const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { Readable } = require('stream');
const { spawn } = require('child_process');

// On Linux use the system ffmpeg (apt-installed); ffmpeg-static crashes with SIGSEGV there.
const ffmpegStatic = process.platform === 'linux'
    ? (fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg')
    : require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;

function loadEnvFile() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const eq = trimmed.indexOf('=');
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key && process.env[key] === undefined) process.env[key] = value;
    }
}

loadEnvFile();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure downloads directory exists
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Resolve the yt-dlp executable in a way that prefers the newer Python-installed binary when available
let ytDlpCommand = ['yt-dlp'];
let ytDlpAvailable = true;
let ytDlpErrorMessage = '';

if (process.platform === 'win32') {
    const localBinary = path.join(__dirname, 'yt-dlp.exe');
    const pythonCandidates = [
        process.env.PYTHON,
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
    ].filter(Boolean);
    const python = pythonCandidates.find(p => fs.existsSync(p));

    if (fs.existsSync(localBinary)) {
        ytDlpCommand = [localBinary];
    } else if (python) {
        ytDlpCommand = [python, '-m', 'yt_dlp'];
    } else {
        ytDlpAvailable = false;
        ytDlpErrorMessage = 'yt-dlp was not found. Install yt-dlp for Python or place yt-dlp.exe in the app folder.';
    }
}

function sendYtDlpUnavailable(res) {
    return res.status(503).json({
        error: ytDlpErrorMessage || 'yt-dlp is currently unavailable.'
    });
}

function spawnYtDlp(args) {
    return spawn(ytDlpCommand[0], [...ytDlpCommand.slice(1), ...args]);
}

function execYtDlpPromise(args, timeoutMs = 2 * 60 * 1000) {
    return new Promise((resolve, reject) => {
        const proc = spawnYtDlp(args);
        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { proc.kill('SIGTERM'); } catch {}
            reject(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)} seconds`));
        }, timeoutMs);

        proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        proc.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        });
    });
}

// Runs a yt-dlp command and rejects with a friendly error if it takes longer
// than timeoutMs (default DOWNLOAD_TIMEOUT_MINUTES). Kills the child process on timeout.
const DOWNLOAD_TIMEOUT_MINUTES = (() => {
    const v = Number(process.env.DOWNLOAD_TIMEOUT_MINUTES);
    return Number.isFinite(v) ? Math.min(120, Math.max(5, v)) : 20;
})();

function runYtDlp(args, timeoutMs = DOWNLOAD_TIMEOUT_MINUTES * 60 * 1000) {
    return new Promise((resolve, reject) => {
        const proc = spawnYtDlp(args);
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { proc.kill('SIGTERM'); } catch {}
            reject(new Error(`Download timed out (${DOWNLOAD_TIMEOUT_MINUTES}-minute limit). Try a shorter clip or lower quality.`));
        }, timeoutMs);

        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        proc.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        });
    });
}

// Short-lived cache of extracted video data (avoids re-fetching the same
// page between /api/info and the immediately-following /api/download).
const extractCache = new Map();
const CACHE_TTL_MS = 4 * 60 * 1000; // 4 minutes
const previewStreams = new Map();

function setExtractCache(url, data) {
    extractCache.set(url, { data, ts: Date.now() });
    for (const [k, v] of extractCache) {
        if (Date.now() - v.ts > CACHE_TTL_MS) extractCache.delete(k);
    }
}

function getExtractCache(url) {
    const entry = extractCache.get(url);
    if (!entry || Date.now() - entry.ts > CACHE_TTL_MS) {
        extractCache.delete(url);
        return null;
    }
    return entry.data;
}

// Stream URLs issued by video hosts are often short-lived and require a
// Referer header. Keep them server-side and expose only a short-lived token,
// so browsers can play them without cross-origin/CORS failures.
function createPreviewStream(url, headers = {}) {
    if (!url) return null;
    const token = crypto.randomBytes(18).toString('base64url');
    previewStreams.set(token, { url, headers, ts: Date.now() });
    for (const [key, value] of previewStreams) {
        if (Date.now() - value.ts > CACHE_TTL_MS) previewStreams.delete(key);
    }
    return token;
}

// YouTube blocks datacenter IPs (like Railway's) with "Sign in to confirm
// you're not a bot" unless the request carries cookies from a real, logged-in
// browser session. If YOUTUBE_COOKIES is set (Netscape cookies.txt content,
// exported from a browser logged into youtube.com), write it to disk once and
// pass it to yt-dlp for every YouTube request.
let youtubeCookiesPath = null;
let youtubeCookiesChecked = false;
function getYoutubeCookiesPath() {
    if (youtubeCookiesChecked) return youtubeCookiesPath;
    youtubeCookiesChecked = true;

    const filePath = process.env.YOUTUBE_COOKIES_FILE;
    if (filePath) {
        try {
            const resolved = path.resolve(filePath);
            if (fs.existsSync(resolved)) {
                youtubeCookiesPath = resolved;
                return youtubeCookiesPath;
            }
            console.error(`YOUTUBE_COOKIES_FILE does not exist: ${resolved}`);
        } catch (err) {
            console.error('Failed to read YOUTUBE_COOKIES_FILE:', err.message);
        }
    }

    const raw = process.env.YOUTUBE_COOKIES;
    if (!raw) return null;
    try {
        const normalized = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
        youtubeCookiesPath = path.join(DOWNLOADS_DIR, '_youtube_cookies.txt');
        fs.writeFileSync(youtubeCookiesPath, normalized);
    } catch (err) {
        console.error('Failed to write YouTube cookies file:', err.message);
        youtubeCookiesPath = null;
    }
    return youtubeCookiesPath;
}

const YOUTUBE_COOKIES_REQUIRED_MESSAGE = 'This deployment needs YOUTUBE_COOKIES to access YouTube. Set YOUTUBE_COOKIES from a logged-in YouTube cookies.txt export, then redeploy.';

function isYoutubeUrl(url) {
    return /youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(url || '');
}

function getYoutubeEmbedUrl(value) {
    try {
        const url = new URL(value);
        let id = '';
        if (/youtu\.be$/i.test(url.hostname)) id = url.pathname.split('/').filter(Boolean)[0] || '';
        else if (/youtube(?:-nocookie)?\.com$/i.test(url.hostname) || /youtube(?:-nocookie)?\.com$/i.test(url.hostname.replace(/^www\./, ''))) {
            id = url.searchParams.get('v') || '';
            if (!id) {
                const parts = url.pathname.split('/').filter(Boolean);
                const marker = parts.findIndex(part => /^(embed|shorts|live)$/i.test(part));
                if (marker >= 0) id = parts[marker + 1] || '';
            }
        }
        return /^[A-Za-z0-9_-]{6,}$/.test(id)
            ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0&autoplay=1`
            : null;
    } catch {
        return null;
    }
}

function isYoutubeCookiesRequiredError(raw) {
    return /sign in to confirm|confirm you.re not a bot|not a bot|bot detection|unusual traffic|login required|log in|not logged in|authentication|cookies/i.test(raw || '');
}

function apiErrorPayload(raw, url) {
    const isYoutubeContext = isYoutubeUrl(url) || /youtube|youtu\.be/i.test(raw || '');
    const isYoutubeCookiesRequired = isYoutubeContext && isYoutubeCookiesRequiredError(raw);
    return {
        error: isYoutubeCookiesRequired ? YOUTUBE_COOKIES_REQUIRED_MESSAGE : friendlyError(raw, url),
        code: isYoutubeCookiesRequired ? 'YOUTUBE_COOKIES_REQUIRED' : 'DOWNLOAD_ERROR'
    };
}

// Extra args per site
function siteArgs(url) {
    if (isYoutubeUrl(url)) {
        const cookiesPath = getYoutubeCookiesPath();
        // YouTube can return no playable formats to authenticated web clients
        // from a server IP. Its logged-out default/tv client is currently more
        // reliable for public videos. Keep cookies opt-in for age-restricted
        // or account-only videos via YOUTUBE_USE_COOKIES=1.
        const args = ['--extractor-args', 'youtube:player_client=default,tv_simply'];
        const useCookies = /^(1|true|yes)$/i.test(process.env.YOUTUBE_USE_COOKIES || '');
        return cookiesPath && useCookies ? ['--cookies', cookiesPath, ...args] : args;
    }
    if (/facebook\.com|fb\.watch|fb\.com/i.test(url)) {
        return [
            '--add-header', 'Referer:https://www.facebook.com/',
            '--add-header', 'Origin:https://www.facebook.com',
            '--add-header', 'Accept-Language:en-US,en;q=0.9',
            '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            '--extractor-args', 'facebook:skip_embed=true'
        ];
    }
    return [];
}

// yt-dlp sometimes prints a warning line before the JSON; scan from end for last valid JSON
function parseLastJson(stdout) {
    const lines = stdout.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]); } catch {}
    }
    throw new Error('No valid JSON found in yt-dlp output');
}

// Convert raw yt-dlp stderr into a user-friendly message
function friendlyError(raw, url) {
    if (isYoutubeUrl(url) && isYoutubeCookiesRequiredError(raw)) {
        return YOUTUBE_COOKIES_REQUIRED_MESSAGE;
    }

    const msg = (raw || '').toLowerCase();
    if (/download completed but file not found/i.test(raw))
        return 'Download finished but the server could not locate the output file. Please try again.';
    if (/facebook.*cannot parse data|cannot parse data/i.test(raw))
        return 'Facebook videos are currently not supported by the downloader because the platform is blocking metadata extraction.';
    if (/sign in|login required|log in|authentication|not logged in|age.restrict/i.test(raw))
        return 'This video requires a login. Sign in is not supported.';
    if (/private video|this video is private/i.test(raw))
        return 'This video is private.';
    if (/copyright|removed|taken down/i.test(raw))
        return 'This video was removed due to copyright or policy violation.';
    if (/not available|unavailable|does not exist|no video formats/i.test(raw))
        return 'This video is not available or the URL is invalid.';
    if (/confirm you.re not a bot|bot detection|unusual traffic/i.test(raw))
        return 'Platform blocked the request (bot detection). Try again later.';
    if (/403|forbidden/i.test(raw))
        return 'Access denied by the platform.';
    if (/404|not found/i.test(raw))
        return 'Video not found. Check the URL.';
    if (/timed out|socket|network/i.test(raw))
        return 'Connection timed out. The platform may be slow or unavailable.';
    if (/unsupported url|no suitable extractor/i.test(raw))
        return 'This site is not supported. Try a URL from a supported platform.';
    if (/playlist|too many|download limit/i.test(raw))
        return 'Playlist downloads are not supported. Please use a direct video URL.';
    if (/geo.block|not available in your|region/i.test(raw))
        return 'This video is geo-restricted and not available in this region.';
    return 'Download failed. The video may be private, restricted, or the URL is invalid.';
}

// ── CURL-SITE EXTRACTION (javgg.net — no browser needed) ─────────────────

const CURL_SITES = /javgg\.net/i;
const MISSAV_SITES = /missav\./i;

function isCurlSite(url) { return CURL_SITES.test(url); }
function isMissavSite(url) { return MISSAV_SITES.test(url); }

async function getJavggVideoUrl(pageUrl) {
    const code = `
import sys, json, re
from curl_cffi import requests

page_url = sys.argv[1]
r = requests.get(page_url, impersonate='chrome124', timeout=20, allow_redirects=True)
if r.status_code != 200:
    print(json.dumps({'error': f'Page returned {r.status_code}'})); raise SystemExit(0)

embed = re.search(r'(https://javggvideo\\.xyz/t/[a-z0-9]+)', r.text)
if not embed:
    print(json.dumps({'error': 'No javggvideo embed found on page'})); raise SystemExit(0)

r2 = requests.get(embed.group(1), impersonate='chrome124',
    headers={'Referer': page_url}, timeout=15)
m3u8s = re.findall(r'https?://[^\\s\\"\\x27<>]+\\.m3u8[^\\s\\"\\x27<>]*', r2.text)
if not m3u8s:
    print(json.dumps({'error': 'No m3u8 in embed page'})); raise SystemExit(0)

og_title = re.search(r'property="og:title"[^>]*content="([^"]+)"', r.text)
og_img   = re.search(r'property="og:image"[^>]*content="([^"]+)"', r.text)
title = og_title.group(1).strip() if og_title else 'JAV Video'
print(json.dumps({'m3u8': m3u8s[0], 'referer': embed.group(1), 'title': title,
    'thumbnail': og_img.group(1).strip() if og_img else ''}))
`.trim();
    const out = await runPythonScript(code, [pageUrl]);
    const data = JSON.parse(out);
    if (data.error) throw new Error(data.error);
    return data;
}

async function getMissavVideoUrl(pageUrl) {
    const code = `
import sys, json, re
from html import unescape
from curl_cffi import requests

page_url = sys.argv[1]
headers = {
    'Referer': 'https://missav.ai/',
    'Accept-Language': 'en-US,en;q=0.9',
}
r = requests.get(page_url, impersonate='chrome124', headers=headers, timeout=25, allow_redirects=True)
if r.status_code != 200:
    print(json.dumps({'error': f'Page returned {r.status_code}'})); raise SystemExit(0)

t = unescape(r.text)
t = re.sub(r'\\\\u002[fF]', '/', t).replace('\\\\/', '/')

streams = re.findall(r'https?://[^\\s\\"\\x27<>]+\\.(?:m3u8|mp4)(?:\\?[^\\s\\"\\x27<>]*)?', t)
streams = [s for s in streams if 'preview' not in s.lower() and 'thumbnail' not in s.lower()]
if not streams:
    print(json.dumps({'error': 'No downloadable video stream found on MissAV page'})); raise SystemExit(0)

og_title = re.search(r'property=["\\x27]og:title["\\x27][^>]*content=["\\x27]([^"\\x27]+)', t)
og_img = re.search(r'property=["\\x27]og:image["\\x27][^>]*content=["\\x27]([^"\\x27]+)', t)
title_tag = re.search(r'<title[^>]*>([^<]+)</title>', t, re.I)
title = (og_title or title_tag)
title = title.group(1).strip() if title else 'MissAV Video'
for s in [' - MissAV', ' | MissAV', ' MissAV']:
    if title.endswith(s):
        title = title[:-len(s)].strip()

print(json.dumps({
    'videoUrl': streams[0],
    'referer': page_url,
    'title': title,
    'thumbnail': og_img.group(1).strip() if og_img else ''
}))
`.trim();
    const out = await runPythonScript(code, [pageUrl]);
    const data = JSON.parse(out);
    if (data.error) throw new Error(data.error);
    return data;
}

// ── BROWSER-SITE EXTRACTION (jav.guru, javeng.tv) ────────────────────────

const BROWSER_SITES = /jav\.guru|javeng\.tv|javeng\.com/i;

function isBrowserSite(url) {
    return BROWSER_SITES.test(url);
}

function getChromiumPath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    if (process.platform === 'linux') {
        for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
            if (fs.existsSync(p)) return p;
        }
    }
    for (const p of [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ]) {
        if (fs.existsSync(p)) return p;
    }
    return 'chromium';
}

function getBrowserPython() {
    if (process.platform === 'win32') {
        const candidates = [
            process.env.PYTHON,
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
            path.join(__dirname, '.venv', 'Scripts', 'python.exe'),
        ].filter(Boolean);
        const python = candidates.find(p => fs.existsSync(p));
        if (python) return python;
    }
    return 'python3';
}

function runPythonScript(code, args = [], timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const proc = spawn(getBrowserPython(), ['-c', code, ...args]);
        let out = '', err = '', settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { proc.kill('SIGTERM'); } catch {}
            reject(new Error('Python extractor timed out. The site may be slow or unavailable.'));
        }, timeoutMs);

        proc.stdout.on('data', d => { out += d.toString(); });
        proc.stderr.on('data', d => { err += d.toString(); });
        proc.on('error', e => {
            if (settled) return; settled = true; clearTimeout(timer); reject(e);
        });
        proc.on('close', code => {
            if (settled) return; settled = true; clearTimeout(timer);
            if (code !== 0) reject(new Error(err || 'Python subprocess failed'));
            else resolve(out.trim());
        });
    });
}

async function scrapeMeta(url) {
    const code = `
import sys, json, re
try:
    from curl_cffi import requests
    r = requests.get(sys.argv[1], impersonate='chrome124', timeout=20)
    t = r.text
    og_title = re.search(r'property="og:title"[^>]*content="([^"]+)"', t)
    og_img   = re.search(r'property="og:image"[^>]*content="([^"]+)"', t)
    h1       = (re.search(r'<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([^<]+)</h1>', t) or
                re.search(r'<h1[^>]*>([^<]+)<', t))
    raw      = (h1 or og_title)
    title    = raw.group(1).strip() if raw else 'JAV Video'
    for s in [' - Watch Free JAV English Subtitle Videos',
              ' | Watch Free JAV English Subtitle Videos',
              ' &#8211; Watch', ' - Watch']:
        if title.endswith(s):
            title = title[:-len(s)]
    print(json.dumps({'title': title, 'thumbnail': og_img.group(1).strip() if og_img else ''}))
except Exception as e:
    print(json.dumps({'title': 'JAV Video', 'thumbnail': ''}))
`.trim();
    try {
        const out = await runPythonScript(code, [url]);
        return JSON.parse(out);
    } catch {
        return { title: 'JAV Video', thumbnail: '' };
    }
}

function cookiesToNetscape(cookies) {
    const lines = ['# Netscape HTTP Cookie File', ''];
    for (const c of cookies) {
        const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
        const expiry = c.expires && c.expires > 0 ? Math.round(c.expires) : '0';
        lines.push([domain, 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', expiry, c.name, c.value].join('\t'));
    }
    return lines.join('\n');
}

// Player hook injected into EVERY frame before any scripts run.
// Captures the video URL passed to jwpSTXplayer() or jwplayer().setup().
const PLAYER_HOOK_SCRIPT = `
(function() {
    var _poll = setInterval(function() {
        if (window.__vgHooked__) { clearInterval(_poll); return; }
        if (typeof window.jwpSTXplayer === 'function') {
            var orig = window.jwpSTXplayer;
            window.jwpSTXplayer = function(playlist) {
                window.__vgVideoUrl__ = String(playlist);
                try { window.__vgCapture__(String(playlist)); } catch(e) {}
                return orig.apply(this, arguments);
            };
            window.__vgHooked__ = 'jwpSTXplayer'; clearInterval(_poll); return;
        }
        if (typeof window.jwplayer === 'function' && !window.__vgJwHooked__) {
            window.__vgJwHooked__ = true;
            var origJw = window.jwplayer;
            window.jwplayer = function() {
                var inst = origJw.apply(this, arguments);
                if (inst && typeof inst.setup === 'function') {
                    var origSetup = inst.setup;
                    inst.setup = function(cfg) {
                        try {
                            var src = Array.isArray(cfg.sources) ? cfg.sources[0] : null;
                            var url = (src && (src.file || src.src)) || cfg.file || cfg.src;
                            if (url && typeof url === 'string') {
                                window.__vgVideoUrl__ = url;
                                try { window.__vgCapture__(url); } catch(e) {}
                            }
                        } catch(e) {}
                        return origSetup.apply(this, arguments);
                    };
                }
                return inst;
            };
            window.__vgHooked__ = 'jwplayer'; clearInterval(_poll);
        }
    }, 80);
})();
`;

async function browserGetVideoUrl(siteUrl) {
    let puppeteer;
    try { puppeteer = require('puppeteer-core'); }
    catch { throw new Error('puppeteer-core is not installed. Run: npm install'); }

    const browser = await puppeteer.launch({
        executablePath: getChromiumPath(),
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
               '--disable-gpu', '--disable-blink-features=AutomationControlled'],
    });

    try {
        const page = await browser.newPage();

        // Inject hooks before any page scripts run, in all frames
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        await page.evaluateOnNewDocument(new Function(PLAYER_HOOK_SCRIPT));

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        let videoUrl = null;

        // exposeFunction works in ALL frames including cross-origin iframes
        await page.exposeFunction('__vgCapture__', (url) => {
            if (!videoUrl && url) videoUrl = url;
        });

        await page.setRequestInterception(true);
        page.on('request', req => {
            const u = req.url();
            if ((u.includes('.m3u8') || u.includes('/m3u8/')) && !videoUrl) videoUrl = u;
            req.continue().catch(() => {});
        });

        if (/javeng\.tv|javeng\.com/i.test(siteUrl)) {
            await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Wait for server 1 (playkrx18.site) — usually auto-loads first
            await new Promise(r => setTimeout(r, 15000));
            if (!videoUrl) videoUrl = await pollFrames(page, ['playkrx18', 'mov18plus', 'cloud']);

            // Fallback: click server 2
            if (!videoUrl) {
                await page.evaluate(() => {
                    const btn = document.querySelector('[data-nume="2"]');
                    if (btn) btn.click();
                }).catch(() => {});
                await new Promise(r => setTimeout(r, 15000));
                if (!videoUrl) videoUrl = await pollFrames(page, ['playkrx18', 'mov18plus', 'cloud']);
            }

        } else if (/jav\.guru/i.test(siteUrl)) {
            await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            // Click first player button to open the embed
            await page.click('a#wp-btn-iframe, .player-btn, [class*="player"]').catch(() => {});
            await new Promise(r => setTimeout(r, 20000));
            if (!videoUrl) videoUrl = await pollFrames(page, ['play', 'embed', 'player']);
        }

        if (!videoUrl) throw new Error('Could not find video stream. The site may be down or the video unavailable.');

        const cookies = await page.cookies();
        const cookiePath = path.join(__dirname, 'downloads', `_cookies_${Date.now()}.txt`);
        fs.writeFileSync(cookiePath, cookiesToNetscape(cookies));

        return { videoUrl, referer: page.url(), cookiePath };
    } finally {
        await browser.close();
    }
}

async function pollFrames(page, domainHints) {
    for (const frame of page.frames()) {
        const fu = frame.url();
        if (domainHints.some(h => fu.includes(h))) {
            try {
                const v = await frame.evaluate(() => window.__vgVideoUrl__ || null);
                if (v) return v;
            } catch {}
        }
    }
    return null;
}

// ── GET VIDEO INFO ──────────────────────────────────────────────────────
app.post('/api/info', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    // curl-based extraction for javgg.net
    if (isCurlSite(url)) {
        try {
            const data = await getJavggVideoUrl(url);
            setExtractCache(url, { type: 'javgg', ...data });
            const previewToken = createPreviewStream(data.m3u8, { Referer: data.referer });
            return res.json({
                title: data.title || 'JAV Video',
                thumbnail: data.thumbnail || null,
                duration: 0,
                uploader: 'javgg.net',
                platform: 'javgg.net',
                viewCount: 0,
                previewUrl: previewToken ? `/api/preview/${previewToken}` : null,
                previewType: previewToken ? 'hls' : null,
                formats: [
                    { formatId: 'best', ext: 'mp4', quality: 'Best Quality', resolution: 'best' }
                ],
            });
        } catch (err) {
            return res.status(500).json({ error: 'Could not fetch video info: ' + err.message });
        }
    }

    // curl-based extraction for MissAV pages
    if (isMissavSite(url)) {
        try {
            const data = await getMissavVideoUrl(url);
            setExtractCache(url, { type: 'missav', ...data });
            const previewToken = createPreviewStream(data.videoUrl, { Referer: data.referer });
            return res.json({
                title: data.title || 'MissAV Video',
                thumbnail: data.thumbnail || null,
                duration: 0,
                uploader: 'missav',
                platform: 'missav',
                viewCount: 0,
                previewUrl: previewToken ? `/api/preview/${previewToken}` : null,
                previewType: previewToken ? (isM3u8Url(data.videoUrl) ? 'hls' : 'file') : null,
                formats: [
                    { formatId: 'best', ext: 'mp4', quality: 'Best Quality', resolution: 'best' }
                ]
            });
        } catch (err) {
            return res.status(500).json({ error: 'Could not fetch MissAV video info: ' + err.message });
        }
    }

    // Browser-based extraction for JAV sites
    if (isBrowserSite(url)) {
        try {
            const meta = await scrapeMeta(url);
            const host = new URL(url).hostname.replace(/^www\./, '');
            return res.json({
                title: meta.title || 'JAV Video',
                thumbnail: meta.thumbnail || null,
                duration: 0,
                uploader: host,
                platform: host,
                viewCount: 0,
                formats: [
                    { formatId: 'best', ext: 'mp4', quality: 'Best Quality', resolution: 'best' }
                ]
            });
        } catch (err) {
            return res.status(500).json({ error: 'Could not fetch video info: ' + err.message });
        }
    }

    if (!ytDlpAvailable) {
        return sendYtDlpUnavailable(res);
    }

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const infoArgs = [
            url,
            '--dump-json',
            '--no-warnings',
            '--no-playlist',
            '--socket-timeout', '30',
            '--retries', '3',
            '--extractor-retries', '3',
            '--ffmpeg-location', ffmpegStatic,
            ...siteArgs(url)
        ];
        let stdout;
        try {
            stdout = await execYtDlpPromise(infoArgs);
        } catch (firstErr) {
            // Some sites block yt-dlp's TLS fingerprint; retry once
            // impersonating a real Chrome browser before giving up.
            if (isFatalDownloadError(firstErr.message)) throw firstErr;
            try {
                stdout = await execYtDlpPromise([...infoArgs, '--impersonate', 'chrome']);
            } catch (secondErr) {
                throw /impersonate/i.test(secondErr.message || '') ? firstErr : secondErr;
            }
        }
        const metadata = parseLastJson(stdout);

        // Extract useful format options, excluding watermarked TikTok/Facebook download variants
        const formats = (metadata.formats || [])
            .filter(f => f.vcodec !== 'none' && f.ext)
            .filter(f => !f.format_id?.startsWith('download') && !/watermark/i.test(f.format_note || ''))
            .map(f => ({
                formatId: f.format_id,
                ext: f.ext,
                quality: f.format_note || f.resolution || 'unknown',
                resolution: f.resolution || 'audio only',
                filesize: f.filesize || f.filesize_approx || null,
                fps: f.fps,
                vcodec: f.vcodec,
                acodec: f.acodec
            }));

        // Deduplicate by quality label
        const seen = new Set();
        const uniqueFormats = formats.filter(f => {
            const key = f.quality;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // A combined audio/video URL can be played directly by most browsers.
        // YouTube uses its official embed player because high-quality streams are
        // normally split into separate audio and video tracks.
        // Prefer progressive MP4 (native <video> support); fall back to an HLS
        // playlist, which the frontend plays through hls.js via the relay.
        const playableCandidates = (metadata.formats || [])
            .filter(f => f.url && f.vcodec !== 'none' && f.acodec !== 'none')
            .sort((a, b) => {
                const aMp4 = !isM3u8Url(a.url) && a.ext === 'mp4' ? 1 : 0;
                const bMp4 = !isM3u8Url(b.url) && b.ext === 'mp4' ? 1 : 0;
                if (aMp4 !== bMp4) return bMp4 - aMp4;
                return (b.height || 0) - (a.height || 0);
            });
        const playableFormat = playableCandidates[0];
        const previewToken = !isYoutubeUrl(url)
            ? createPreviewStream(playableFormat?.url, {
                ...(playableFormat?.http_headers || {}),
                Referer: playableFormat?.http_headers?.Referer || url
            })
            : null;
        const previewType = previewToken
            ? (isM3u8Url(playableFormat.url) ? 'hls' : 'file')
            : null;

        res.json({
            title: metadata.title || 'Unknown Title',
            thumbnail: metadata.thumbnail || null,
            duration: metadata.duration || 0,
            uploader: metadata.uploader || metadata.channel || 'Unknown',
            platform: metadata.extractor_key || metadata.extractor || 'Unknown',
            viewCount: metadata.view_count || 0,
            embedUrl: isYoutubeUrl(url) ? getYoutubeEmbedUrl(url) : null,
            streamUrl: !isYoutubeUrl(url) ? (playableFormat?.url || null) : null,
            previewUrl: previewToken ? `/api/preview/${previewToken}` : null,
            previewType,
            formats: uniqueFormats.length > 0 ? uniqueFormats : [
                { formatId: 'best', ext: 'mp4', quality: 'Best Quality', resolution: 'best' }
            ]
        });
    } catch (err) {
        console.error('Info fetch error:', err.message);
        res.status(500).json(apiErrorPayload(err.message, url));
    }
});

// ── PREVIEW RELAY ───────────────────────────────────────────────────────
// Relays previously extracted streams with the headers their hosts expect.
// Range requests pass through so seeking works. HLS playlists (.m3u8) are
// rewritten so every segment is also fetched through this relay — browsers
// cannot fetch cross-origin segments directly.

function isM3u8Url(u) {
    return /\.m3u8($|\?)/i.test(u || '');
}

// Only relay to public http(s) hosts, never into the local network.
function isSafeRelayTarget(u) {
    try {
        const parsed = new URL(u);
        if (!/^https?:$/.test(parsed.protocol)) return false;
        return !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i
            .test(parsed.hostname);
    } catch {
        return false;
    }
}

function previewRelayPath(token, absUrl) {
    return `/api/preview/${token}/r?u=${encodeURIComponent(absUrl)}`;
}

// Rewrite every URI in an HLS playlist (segments, nested playlists, keys)
// to go through the relay, resolving relative paths against the playlist URL.
function rewriteM3u8(text, baseUrl, token) {
    return text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith('#')) {
            return line.replace(/URI="([^"]+)"/g, (m, uri) => {
                try { return `URI="${previewRelayPath(token, new URL(uri, baseUrl).href)}"`; }
                catch { return m; }
            });
        }
        try { return previewRelayPath(token, new URL(trimmed, baseUrl).href); }
        catch { return line; }
    }).join('\n');
}

async function relayPreview(req, res, targetUrl, stream, token) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...stream.headers
    };
    const wantsPlaylist = isM3u8Url(targetUrl);
    if (req.headers.range && !wantsPlaylist) headers.Range = req.headers.range;

    const upstream = await fetch(targetUrl, { headers, redirect: 'follow' });
    if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502)
            .json({ error: 'The video host rejected this preview stream.' });
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const finalUrl = upstream.url || targetUrl;
    if (/mpegurl/.test(contentType) || isM3u8Url(finalUrl)) {
        const text = await upstream.text();
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-store');
        return res.send(rewriteM3u8(text, finalUrl, token));
    }

    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
    }
    res.status(upstream.status);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

function getPreviewStreamEntry(req, res) {
    const stream = previewStreams.get(req.params.token);
    if (!stream) {
        res.status(410).json({ error: 'Preview link expired. Fetch the video again.' });
        return null;
    }
    // Keep the token alive while the viewer is actively watching.
    stream.ts = Date.now();
    return stream;
}

app.get('/api/preview/:token', async (req, res) => {
    const stream = getPreviewStreamEntry(req, res);
    if (!stream) return;
    try {
        await relayPreview(req, res, stream.url, stream, req.params.token);
    } catch (err) {
        console.error('Preview stream error:', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Could not open this video preview.' });
        else res.destroy();
    }
});

// HLS segments, nested playlists, and encryption keys referenced by a
// rewritten playlist. The token must still be valid, and the target is
// restricted to public http(s) hosts.
app.get('/api/preview/:token/r', async (req, res) => {
    const stream = getPreviewStreamEntry(req, res);
    if (!stream) return;
    const target = String(req.query.u || '');
    if (!isSafeRelayTarget(target)) {
        return res.status(400).json({ error: 'Invalid relay target.' });
    }
    try {
        await relayPreview(req, res, target, stream, req.params.token);
    } catch (err) {
        console.error('Preview segment error:', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Could not fetch video segment.' });
        else res.destroy();
    }
});

function findDownloadedFile(timestamp, startedAtMs) {
    const prefix = `${timestamp}_`;
    const files = fs.readdirSync(DOWNLOADS_DIR)
        .map(f => {
            const filePath = path.join(DOWNLOADS_DIR, f);
            const stat = fs.statSync(filePath);
            return { name: f, path: filePath, time: stat.mtimeMs, size: stat.size };
        })
        .filter(f => {
            if (/\.(part|ytdl|frag\d*|temp|tmp)$/i.test(f.name)) return false;
            if (f.name.startsWith('_') || f.name.endsWith('.txt') || f.name.endsWith('.lock')) return false;
            if (f.name.startsWith(prefix)) return true;
            // Legacy suffix template fallback, then mtime fallback
            if (f.name.includes(`_${timestamp}`)) return true;
            return startedAtMs && f.time >= startedAtMs - 2000;
        })
        .sort((a, b) => {
            // Prefer exact timestamp matches over mtime guesses
            const aMatch = a.name.startsWith(prefix) ? 1 : 0;
            const bMatch = b.name.startsWith(prefix) ? 1 : 0;
            if (aMatch !== bMatch) return bMatch - aMatch;
            return b.time - a.time;
        });

    if (files.length === 0) {
        throw new Error('Download completed but file not found');
    }

    const file = files[0];
    const cleanName = file.name.startsWith(prefix)
        ? file.name.slice(prefix.length)
        : file.name.replace(`_${timestamp}`, '');
    return {
        filePath: file.path,
        cleanName: cleanName || file.name
    };
}

function isSimpleFormatId(format) {
    return /^[A-Za-z0-9_.-]+$/.test(format || '');
}

function buildSelectedFormat(format) {
    // A quality option may be video-only (as is common on YouTube). Pair it
    // with the best available audio track, but retain the video-only option
    // as a fallback for sites where audio is already included.
    if (!format || format === 'best') return '';
    return `${format}+bestaudio/${format}/bestvideo+bestaudio/best`;
}

// Errors where no retry with different args can possibly help.
function isFatalDownloadError(msg) {
    return /download timed out|private video|is private|sign in|log ?in|authentication|not a bot|age.restrict|copyright|taken down|geo.?block|not available in your|http error 404|does not exist|url is invalid/i.test(msg || '');
}

// A progressive-first chain that still works on platforms (like modern
// YouTube) that no longer publish combined audio+video formats.
const PROGRESSIVE_MP4_CHAIN = [
    'best[ext=mp4][vcodec^=avc1][acodec^=mp4a]',
    'best[ext=mp4]',
    'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]',
    'bestvideo+bestaudio',
    'best'
].join('/');

async function downloadVideoToFile(url, options = {}) {
    const format = options.format || 'best';
    const fastDownload = options.fastDownload !== false;
    const startedAtMs = Date.now();
    const timestamp = Date.now();
    // Timestamp first so long titles can never truncate it away; title capped
    // at 80 bytes by the template itself.
    const outputTemplate = path.join(DOWNLOADS_DIR, `${timestamp}_%(title).80B.%(ext)s`);

    if (!ytDlpAvailable) {
        throw new Error(ytDlpErrorMessage || 'yt-dlp is currently unavailable.');
    }

    if (isCurlSite(url)) {
        const cached = getExtractCache(url);
        const data = (cached?.type === 'javgg') ? cached : await getJavggVideoUrl(url);
        const args = [
            data.m3u8,
            '--ffmpeg-location', ffmpegStatic,
            '-o', outputTemplate,
            '--no-warnings',
            '--no-mtime',
            '--retries', '5',
            '--fragment-retries', '10',
            '--concurrent-fragments', '6',
            '--add-header', `Referer:${data.referer}`,
            '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            '--merge-output-format', 'mp4',
            '-S', 'vcodec:h264,acodec:aac,res,br',
            '-f', 'bestvideo+bestaudio/best',
            '--remux-video', 'mp4',
        ];
        await runYtDlp(args);
        return findDownloadedFile(timestamp, startedAtMs);
    }

    if (isMissavSite(url)) {
        const cached = getExtractCache(url);
        const data = (cached?.type === 'missav') ? cached : await getMissavVideoUrl(url);
        const args = [
            data.videoUrl,
            '--ffmpeg-location', ffmpegStatic,
            '-o', outputTemplate,
            '--no-warnings',
            '--no-mtime',
            '--retries', '5',
            '--fragment-retries', '10',
            '--concurrent-fragments', '6',
            '--add-header', `Referer:${data.referer}`,
            '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            '--merge-output-format', 'mp4',
            '-S', 'vcodec:h264,acodec:aac,res,br',
            '-f', 'bestvideo+bestaudio/best',
            '--remux-video', 'mp4',
        ];
        await runYtDlp(args);
        return findDownloadedFile(timestamp, startedAtMs);
    }

    if (isBrowserSite(url)) {
        let cookiePath = null;
        try {
            const { videoUrl, referer, cookiePath: cp } = await browserGetVideoUrl(url);
            cookiePath = cp;
            const args = [
                videoUrl,
                '--ffmpeg-location', ffmpegStatic,
                '-o', outputTemplate,
                '--no-warnings',
                '--no-mtime',
                '--retries', '5',
                '--fragment-retries', '10',
                '--concurrent-fragments', '6',
                '--cookies', cookiePath,
                '--add-header', `Referer:${referer}`,
                '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                '--merge-output-format', 'mp4',
                '--extractor-args', 'generic:impersonate',
                '-S', 'vcodec:h264,acodec:aac,res,br',
                '-f', 'bestvideo+bestaudio/best',
                '--remux-video', 'mp4',
            ];
            await runYtDlp(args);
            return findDownloadedFile(timestamp, startedAtMs);
        } finally {
            if (cookiePath) try { fs.unlinkSync(cookiePath); } catch {}
        }
    }

    const baseArgs = [
        url,
        '--ffmpeg-location', ffmpegStatic,
        '-o', outputTemplate,
        '--no-playlist',
        '--no-warnings',
        '--no-mtime',
        '--socket-timeout', '30',
        '--retries', '5',
        '--fragment-retries', '10',
        '--extractor-retries', '3',
        '--concurrent-fragments', '6',
        '--merge-output-format', 'mp4',
        ...siteArgs(url)
    ];

    // First attempt: honor the requested format/speed. Later attempts fall
    // back to the safest possible selection, then try browser impersonation
    // for sites that block yt-dlp's TLS fingerprint.
    const firstAttempt = ['-S', 'vcodec:h264,acodec:aac,res,br'];
    if (fastDownload) {
        if (format && format !== 'best') {
            // Previously simple ids such as YouTube's "137" were ignored in
            // fast mode, so the quality selector often downloaded another
            // resolution. Only accept a known id or yt-dlp selector syntax.
            firstAttempt.push('-f', isSimpleFormatId(format) ? buildSelectedFormat(format) : format);
        } else {
            // In fast/mobile mode, prefer progressive MP4. Some platforms
            // return 403 for separate video-only format downloads.
            firstAttempt.push('-f', PROGRESSIVE_MP4_CHAIN);
        }
    } else {
        if (format && format !== 'best') {
            firstAttempt.push('-f', [
                `${format}+bestaudio[acodec~='^(mp4a|aac)']`,
                `${format}+bestaudio`,
                format,
                'bestvideo+bestaudio',
                'best'
            ].join('/'));
        } else {
            firstAttempt.push('-f', 'bestvideo+bestaudio/best');
        }
        firstAttempt.push('--remux-video', 'mp4');
    }

    const safeAttempt = [
        '-S', 'vcodec:h264,acodec:aac,res,br',
        '-f', PROGRESSIVE_MP4_CHAIN,
        '--remux-video', 'mp4'
    ];
    const impersonateAttempt = [...safeAttempt, '--impersonate', 'chrome'];

    let lastError = null;
    for (const attempt of [firstAttempt, safeAttempt, impersonateAttempt]) {
        try {
            await runYtDlp([...baseArgs, ...attempt]);
            return findDownloadedFile(timestamp, startedAtMs);
        } catch (err) {
            // If impersonation itself is unsupported, keep the earlier,
            // more meaningful error.
            if (!/impersonate/i.test(err.message || '') || !lastError) {
                lastError = err;
            }
            if (isFatalDownloadError(err.message)) break;
            console.error(`yt-dlp attempt failed for ${url}: ${(err.message || '').split('\n')[0]}`);
        }
    }
    throw lastError || new Error('Download failed.');
}

// ── DOWNLOAD VIDEO ──────────────────────────────────────────────────────
app.get('/api/download', async (req, res) => {
    const { url, format } = req.query;
    const fastDownload = req.query.fast === '1';

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    if (!ytDlpAvailable) {
        return sendYtDlpUnavailable(res);
    }

    try {
        const file = await downloadVideoToFile(url, { format, fastDownload });
        res.download(file.filePath, file.cleanName, () => {
            try {
                if (fs.existsSync(file.filePath)) {
                    fs.unlinkSync(file.filePath);
                }
            } catch (e) {
                console.error('Cleanup error:', e.message);
            }
        });
    } catch (err) {
        console.error('Download error:', err.message);
        res.status(500).json(apiErrorPayload(err.message, url));
    }
});

// ── TELEGRAM BOT DOWNLOADS ──────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ENABLE_BOT = /^(1|true|yes)$/i.test(process.env.TELEGRAM_ENABLE_BOT || '');
const TELEGRAM_ALLOWED_CHAT_IDS = new Set(
    (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
);
function numberFromEnv(name, fallback, min, max) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

const TELEGRAM_MAX_UPLOAD_MB = numberFromEnv('TELEGRAM_MAX_UPLOAD_MB', 49, 1, 50);
const TELEGRAM_POLL_TIMEOUT_SECONDS = numberFromEnv('TELEGRAM_POLL_TIMEOUT_SECONDS', 25, 5, 50);
const TELEGRAM_MAX_CONCURRENT_DOWNLOADS = numberFromEnv('TELEGRAM_MAX_CONCURRENT_DOWNLOADS', 1, 1, 3);
const TELEGRAM_MAX_QUEUE_SIZE = numberFromEnv('TELEGRAM_MAX_QUEUE_SIZE', 20, 1, 100);
const DOWNLOAD_CLEANUP_AGE_MINUTES = numberFromEnv('DOWNLOAD_CLEANUP_AGE_MINUTES', 60, 5, 24 * 60);
const DOWNLOAD_CLEANUP_INTERVAL_MINUTES = numberFromEnv('DOWNLOAD_CLEANUP_INTERVAL_MINUTES', 15, 1, 24 * 60);
const TELEGRAM_ADMIN_CHAT_IDS = new Set(
    (process.env.TELEGRAM_ADMIN_CHAT_IDS || process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
);
// Optional personal destination for links pasted into the web app. This is
// intentionally configured on the server, never supplied by the browser.
const TELEGRAM_SAVE_CHAT_ID = String(process.env.TELEGRAM_SAVE_CHAT_ID || '').trim();
const TELEGRAM_LOCK_PATH = path.join(DOWNLOADS_DIR, 'telegram_bot.lock');
const TELEGRAM_OFFSET_PATH = path.join(DOWNLOADS_DIR, 'telegram_bot.offset');

// Public base URL of this deployment. Railway injects RAILWAY_PUBLIC_DOMAIN
// automatically; PUBLIC_BASE_URL overrides it. When set, the bot uses a
// webhook instead of polling — webhooks always win over any other instance
// polling the same token, which permanently fixes 409 getUpdates conflicts.
const TELEGRAM_PUBLIC_URL = (
    process.env.PUBLIC_BASE_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
).replace(/\/+$/, '');
const TELEGRAM_WEBHOOK_SECRET = TELEGRAM_BOT_TOKEN
    ? crypto.createHash('sha256').update(`videograb-webhook:${TELEGRAM_BOT_TOKEN}`).digest('hex').slice(0, 48)
    : '';

// Quality options offered to bot users. Every chain degrades gracefully so
// any site works even when the exact height is unavailable.
const TELEGRAM_QUALITY_FORMATS = {
    best: { label: 'Best', format: 'bestvideo+bestaudio/best' },
    1080: { label: '1080p', format: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best' },
    720: { label: '720p', format: 'bestvideo[height<=720]+bestaudio/best[height<=720]/bestvideo+bestaudio/best' },
    480: { label: '480p', format: 'bestvideo[height<=480]+bestaudio/best[height<=480]/bestvideo+bestaudio/best' },
    360: { label: '360p', format: 'bestvideo[height<=360]+bestaudio/best[height<=360]/bestvideo+bestaudio/best' },
    audio: { label: 'Audio', format: 'bestaudio[ext=m4a]/bestaudio/best' }
};

// URLs waiting for the user to pick a quality (inline keyboard callback data
// is limited to 64 bytes, so URLs are kept server-side under a short id).
const telegramPendingLinks = new Map();
let telegramNextLinkId = 1;

function rememberTelegramLink(url) {
    const id = String(telegramNextLinkId++);
    telegramPendingLinks.set(id, { url, ts: Date.now() });
    for (const [key, value] of telegramPendingLinks) {
        if (Date.now() - value.ts > 30 * 60 * 1000 || telegramPendingLinks.size > 200) {
            telegramPendingLinks.delete(key);
        }
    }
    return id;
}

const telegramState = {
    enabled: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_ENABLE_BOT),
    mode: 'polling',
    username: '',
    link: '',
    offset: (() => {
        try { return Math.max(0, Number(fs.readFileSync(TELEGRAM_OFFSET_PATH, 'utf8').trim()) || 0); }
        catch { return 0; }
    })(),
    activeChats: new Set(),
    running: false,
    lockOwner: false,
    lastError: '',
    lastUpdateAt: null,
    lastMessageAt: null,
    startedAt: null,
    pollErrors: 0,
    consecutivePollErrors: 0,
    completedJobs: 0,
    failedJobs: 0,
    canceledJobs: 0,
    stopping: false
};
const telegramQueue = [];
const telegramActiveJobs = new Map();
const telegramActiveFiles = new Set();
let telegramNextJobId = 1;
let cleanupTimer = null;
const cleanupState = {
    lastRunAt: null,
    deletedFiles: 0,
    freedBytes: 0,
    lastError: ''
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractFirstUrl(text = '') {
    const match = text.match(/https?:\/\/[^\s<>"']+/i);
    return match ? match[0].replace(/[),.!?]+$/, '') : '';
}

function saveTelegramOffset() {
    try { fs.writeFileSync(TELEGRAM_OFFSET_PATH, String(telegramState.offset)); }
    catch (err) { console.error('Could not save Telegram update offset:', err.message); }
}

function isTelegramChatAllowed(chatId) {
    return TELEGRAM_ALLOWED_CHAT_IDS.size === 0 || TELEGRAM_ALLOWED_CHAT_IDS.has(String(chatId));
}

function isTelegramAdmin(chatId) {
    return TELEGRAM_ADMIN_CHAT_IDS.size === 0
        ? isTelegramChatAllowed(chatId)
        : TELEGRAM_ADMIN_CHAT_IDS.has(String(chatId));
}

function shortUrl(url) {
    return url.length > 70 ? `${url.slice(0, 67)}...` : url;
}

function getTelegramJobForChat(chatId) {
    const id = String(chatId);
    for (const job of telegramActiveJobs.values()) {
        if (String(job.chatId) === id) return job;
    }
    return telegramQueue.find(job => String(job.chatId) === id) || null;
}

function formatTelegramStatus() {
    const uptime = telegramState.startedAt
        ? `${Math.floor((Date.now() - Date.parse(telegramState.startedAt)) / 60000)}m`
        : 'not started';
    return [
        '*VideoGrab Bot Status*',
        `Enabled: ${telegramState.enabled ? 'yes' : 'no'}`,
        `Running: ${telegramState.running ? 'yes' : 'no'}`,
        `Uptime: ${uptime}`,
        `Active: ${telegramActiveJobs.size}/${TELEGRAM_MAX_CONCURRENT_DOWNLOADS}`,
        `Queued: ${telegramQueue.length}/${TELEGRAM_MAX_QUEUE_SIZE}`,
        `Completed: ${telegramState.completedJobs}`,
        `Failed: ${telegramState.failedJobs}`,
        `Canceled: ${telegramState.canceledJobs}`,
        `Poll errors: ${telegramState.pollErrors}`,
        `Last error: ${telegramState.lastError || 'none'}`,
        `Cleanup deleted: ${cleanupState.deletedFiles} files (${(cleanupState.freedBytes / 1024 / 1024).toFixed(1)} MB)`
    ].join('\n');
}

function formatTelegramQueue() {
    const lines = [
        '*Queue*',
        `Active: ${telegramActiveJobs.size}`,
        `Waiting: ${telegramQueue.length}`
    ];

    for (const job of telegramActiveJobs.values()) {
        lines.push(`#${job.id} active chat ${job.chatId} ${shortUrl(job.url)}`);
    }

    telegramQueue.slice(0, 10).forEach((job, idx) => {
        lines.push(`${idx + 1}. #${job.id} chat ${job.chatId} ${shortUrl(job.url)}`);
    });

    if (telegramQueue.length > 10) {
        lines.push(`...and ${telegramQueue.length - 10} more`);
    }

    return lines.join('\n');
}

function enqueueTelegramJob(chatId, url, quality = 'best') {
    if (telegramActiveJobs.size + telegramQueue.length >= TELEGRAM_MAX_QUEUE_SIZE) {
        return null;
    }

    const job = {
        id: telegramNextJobId++,
        chatId,
        url,
        quality: TELEGRAM_QUALITY_FORMATS[quality] ? quality : 'best',
        status: 'queued',
        createdAt: Date.now(),
        startedAt: null,
        canceled: false,
        filePath: ''
    };
    telegramQueue.push(job);
    telegramState.activeChats.add(chatId);
    processTelegramQueue();
    return job;
}

async function cancelTelegramJob(chatId, requesterChatId) {
    const requesterIsAdmin = isTelegramAdmin(requesterChatId);
    const target = String(chatId);
    const queuedIndex = telegramQueue.findIndex(job => String(job.chatId) === target);
    if (queuedIndex >= 0) {
        const [job] = telegramQueue.splice(queuedIndex, 1);
        job.canceled = true;
        telegramState.activeChats.delete(job.chatId);
        telegramState.canceledJobs += 1;
        await telegramSendMessage(job.chatId, `🚫 Canceled queued download #${job.id}.`).catch(() => {});
        return `Canceled queued job #${job.id}.`;
    }

    const active = [...telegramActiveJobs.values()].find(job => String(job.chatId) === target);
    if (active) {
        if (!requesterIsAdmin && String(requesterChatId) !== target) {
            return 'You can only cancel your own job.';
        }
        active.canceled = true;
        return `Job #${active.id} is already running. I marked it canceled and will stop before upload if possible.`;
    }

    return 'No queued or active job found.';
}

function processTelegramQueue() {
    while (!telegramState.stopping &&
        telegramActiveJobs.size < TELEGRAM_MAX_CONCURRENT_DOWNLOADS &&
        telegramQueue.length > 0) {
        const job = telegramQueue.shift();
        runTelegramJob(job).catch(err => {
            console.error('Telegram queue job fatal error:', err.message);
        });
    }
}

function isProcessAlive(pid) {
    if (!pid || Number.isNaN(pid)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function acquireTelegramLock() {
    try {
        if (fs.existsSync(TELEGRAM_LOCK_PATH)) {
            const existingPid = Number(fs.readFileSync(TELEGRAM_LOCK_PATH, 'utf8').trim());
            if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) {
                telegramState.lastError = `Another local bot process is already running (PID ${existingPid}).`;
                console.error(`Telegram bot disabled: ${telegramState.lastError}`);
                return false;
            }
        }

        fs.writeFileSync(TELEGRAM_LOCK_PATH, String(process.pid));
        telegramState.lockOwner = true;
        return true;
    } catch (err) {
        telegramState.lastError = `Could not acquire Telegram bot lock: ${err.message}`;
        console.error(telegramState.lastError);
        return false;
    }
}

function releaseTelegramLock() {
    if (!telegramState.lockOwner) return;
    try {
        if (fs.existsSync(TELEGRAM_LOCK_PATH)) {
            const existingPid = fs.readFileSync(TELEGRAM_LOCK_PATH, 'utf8').trim();
            if (existingPid === String(process.pid)) fs.unlinkSync(TELEGRAM_LOCK_PATH);
        }
    } catch {}
}

async function telegramJson(method, payload = {}, signal = null) {
    const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    };
    if (signal) opts.signal = signal;
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, opts);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
        const err = new Error(data.description || `Telegram ${method} failed`);
        err.errorCode = data.error_code;
        err.parameters = data.parameters || {};
        throw err;
    }
    return data.result;
}

async function telegramSendMessage(chatId, text, parseMode) {
    const payload = {
        chat_id: chatId,
        text,
        disable_web_page_preview: true
    };
    if (parseMode) payload.parse_mode = parseMode;
    return telegramJson('sendMessage', payload);
}

function telegramMultipart(method, fields, fileField, filePath, filename) {
    return new Promise((resolve, reject) => {
        const boundary = `----VideoGrab${Date.now().toString(16)}`;
        const chunks = [];

        for (const [name, value] of Object.entries(fields)) {
            chunks.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
                `${value}\r\n`
            ));
        }

        const safeName = filename.replace(/["\r\n]/g, '_');
        const mimeType = fileField === 'video' ? 'video/mp4' : 'application/octet-stream';
        chunks.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${fileField}"; filename="${safeName}"\r\n` +
            `Content-Type: ${mimeType}\r\n\r\n`
        ));
        const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
        const fileSize = fs.statSync(filePath).size;
        const contentLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + fileSize + closing.length;

        let settled = false;
        const uploadTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { req.destroy(); } catch {}
            reject(new Error('Telegram upload timed out after 5 minutes.'));
        }, 5 * 60 * 1000);

        const req = https.request({
            method: 'POST',
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': contentLength
            }
        }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', d => { body += d; });
            res.on('end', () => {
                if (settled) return;
                settled = true;
                clearTimeout(uploadTimeout);
                let parsed = {};
                try { parsed = JSON.parse(body); } catch {}
                if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false) {
                    resolve(parsed.result);
                } else {
                    reject(new Error(parsed.description || `Telegram upload failed with status ${res.statusCode}`));
                }
            });
        });

        req.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(uploadTimeout);
            reject(err);
        });
        for (const chunk of chunks) req.write(chunk);
        const stream = fs.createReadStream(filePath);
        stream.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(uploadTimeout);
            reject(err);
        });
        stream.on('end', () => req.end(closing));
        stream.pipe(req, { end: false });
    });
}

async function telegramSendDocument(chatId, filePath, filename, caption) {
    return telegramMultipart('sendDocument', {
        chat_id: chatId,
        caption: caption.slice(0, 1024)
    }, 'document', filePath, filename);
}

async function telegramSendVideoFile(chatId, filePath, filename, caption) {
    const sizeMb = fs.statSync(filePath).size / 1024 / 1024;
    if (sizeMb > TELEGRAM_MAX_UPLOAD_MB) {
        throw new Error(`File is ${sizeMb.toFixed(1)} MB. Telegram bot upload limit is ${TELEGRAM_MAX_UPLOAD_MB} MB.`);
    }

    try {
        return await telegramMultipart('sendVideo', {
            chat_id: chatId,
            caption: caption.slice(0, 1024),
            supports_streaming: 'true'
        }, 'video', filePath, filename);
    } catch (err) {
        // If sendVideo fails (codec/format issue), fall back to sendDocument
        console.error('sendVideo failed, falling back to sendDocument:', err.message);
        return telegramSendDocument(chatId, filePath, filename, caption);
    }
}

async function downloadTelegramVideoToFile(url, quality = 'best') {
    const maxBytes = TELEGRAM_MAX_UPLOAD_MB * 1024 * 1024;
    const formatAttempts = [
        // Preserve the requested quality whenever it still fits in the
        // Telegram upload limit. Only step down after the actual file proves
        // too large.
        ...buildTelegramFormatAttempts(quality)
    ];

    let lastError = null;
    for (const format of formatAttempts) {
        let file = null;
        try {
            file = await downloadVideoToFile(url, { format, fastDownload: true });
            const size = fs.statSync(file.filePath).size;
            if (size <= maxBytes) return file;

            lastError = new Error(`Downloaded file is ${(size / 1024 / 1024).toFixed(1)} MB, above Telegram limit ${TELEGRAM_MAX_UPLOAD_MB} MB.`);
            lastError.oversize = true;
            try { fs.unlinkSync(file.filePath); } catch {}
        } catch (err) {
            lastError = err;
            if (file?.filePath) try { fs.unlinkSync(file.filePath); } catch {}
        }
    }

    throw lastError || new Error('Telegram download failed.');
}

// Attempts start at the requested quality and only step DOWN, so the bot
// honors the user's choice but still delivers something when the file is
// too large for Telegram.
function buildTelegramFormatAttempts(quality) {
    const chosen = TELEGRAM_QUALITY_FORMATS[quality] || TELEGRAM_QUALITY_FORMATS.best;
    if (quality === 'audio') return [chosen.format];

    const heights = [1080, 720, 480, 360];
    const startIndex = quality === 'best' ? 0 : heights.indexOf(Number(quality)) + 1;
    return [
        chosen.format,
        ...heights.slice(Math.max(0, startIndex)).map(h =>
            `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`),
        'worst[ext=mp4]/worst'
    ];
}

async function runTelegramJob(job) {
    telegramActiveJobs.set(job.id, job);
    job.status = 'active';
    job.startedAt = Date.now();
    let filePath = '';

    try {
        const qualityLabel = (TELEGRAM_QUALITY_FORMATS[job.quality] || TELEGRAM_QUALITY_FORMATS.best).label;
        await telegramSendMessage(job.chatId, `⬇️ Downloading #${job.id} (${qualityLabel})...`);
        const file = await downloadTelegramVideoToFile(job.url, job.quality);
        filePath = file.filePath;
        job.filePath = filePath;
        telegramActiveFiles.add(filePath);

        if (job.canceled) {
            telegramState.canceledJobs += 1;
            await telegramSendMessage(job.chatId, `🚫 Download #${job.id} was canceled before upload.`).catch(() => {});
            return;
        }

        const sizeMb = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
        await telegramSendMessage(job.chatId, `📤 Uploading #${job.id} (${sizeMb} MB)...`);
        await telegramSendVideoFile(job.chatId, file.filePath, file.cleanName, `🎬 ${file.cleanName}\n${job.url}`);
        telegramState.completedJobs += 1;
        telegramState.lastError = '';
    } catch (err) {
        console.error('Telegram bot download error:', err.message);
        telegramState.failedJobs += 1;
        telegramState.lastError = err.message || String(err);
        const msg = err.message || '';
        if (err.oversize || msg.includes('MB. Telegram bot upload limit') || msg.includes('above Telegram limit')) {
            // Telegram bots cannot upload big files, but the web app can
            // deliver any size — hand the user a direct download link.
            const directLink = TELEGRAM_PUBLIC_URL
                ? `${TELEGRAM_PUBLIC_URL}/api/download?url=${encodeURIComponent(job.url)}&format=best&fast=1`
                : '';
            await telegramSendMessage(
                job.chatId,
                `⚠️ ${msg}` + (directLink ? `\n\n⬇️ Download the full file in your browser:\n${directLink}` : '')
            ).catch(() => {});
        } else if (msg.includes('chat not found') || msg.includes('bot was blocked')) {
            console.error(`Telegram chat ${job.chatId} unreachable: ${msg}`);
        } else {
            await telegramSendMessage(job.chatId, `❌ ${friendlyError(msg)}`).catch(() => {});
        }
    } finally {
        telegramActiveJobs.delete(job.id);
        telegramState.activeChats.delete(job.chatId);
        if (filePath) {
            telegramActiveFiles.delete(filePath);
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
        }
        processTelegramQueue();
    }
}

async function handleTelegramMessage(message) {
    const chatId = message.chat?.id;
    const text = message.text || message.caption || '';
    if (!chatId) return;
    telegramState.lastMessageAt = new Date().toISOString();

    if (!isTelegramChatAllowed(chatId)) {
        await telegramSendMessage(chatId, `⛔ Access denied. Your chat ID is: ${chatId}\nAsk the admin to add it to TELEGRAM_ALLOWED_CHAT_IDS.`);
        return;
    }

    if (/^\/start\b|^\/help\b/i.test(text)) {
        await telegramSendMessage(chatId,
            '🎬 VideoGrab Bot\n\nPaste any video URL, pick a quality (Best / 1080p / 720p / 480p / 360p / Audio), and I will download it and send the file here.\nIf a file is too big for Telegram, I will send you a direct download link instead.\n\nCommands:\n/status - bot health\n/queue - active and waiting downloads\n/cancel - cancel your queued download\n/help - show this help'
        );
        return;
    }

    if (/^\/status\b/i.test(text)) {
        await telegramSendMessage(chatId, formatTelegramStatus());
        return;
    }

    if (/^\/queue\b/i.test(text)) {
        await telegramSendMessage(chatId, formatTelegramQueue());
        return;
    }

    if (/^\/cancel\b/i.test(text)) {
        const parts = text.trim().split(/\s+/);
        const targetChatId = parts[1] && isTelegramAdmin(chatId) ? parts[1] : chatId;
        await telegramSendMessage(chatId, await cancelTelegramJob(targetChatId, chatId));
        return;
    }

    const url = extractFirstUrl(text);
    if (!url) {
        await telegramSendMessage(chatId, '📎 Send me a video URL to download.');
        return;
    }

    if (telegramState.activeChats.has(chatId)) {
        const existing = getTelegramJobForChat(chatId);
        const label = existing ? `#${existing.id} (${existing.status})` : 'current job';
        await telegramSendMessage(chatId, `⏳ You already have ${label}. Use /queue or /cancel.`);
        return;
    }

    // Let the user pick the quality before downloading.
    const linkId = rememberTelegramLink(url);
    await telegramJson('sendMessage', {
        chat_id: chatId,
        text: `🎬 ${shortUrl(url)}\n\nChoose quality:`,
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '⭐ Best', callback_data: `q:${linkId}:best` },
                    { text: '1080p', callback_data: `q:${linkId}:1080` },
                    { text: '720p', callback_data: `q:${linkId}:720` }
                ],
                [
                    { text: '480p', callback_data: `q:${linkId}:480` },
                    { text: '360p', callback_data: `q:${linkId}:360` },
                    { text: '🎵 Audio', callback_data: `q:${linkId}:audio` }
                ]
            ]
        }
    });
}

async function handleTelegramCallback(callbackQuery) {
    const chatId = callbackQuery.message?.chat?.id;
    const answer = text => telegramJson('answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        ...(text ? { text } : {})
    }).catch(() => {});

    if (!chatId) return answer();
    if (!isTelegramChatAllowed(chatId)) return answer('Access denied.');

    const match = /^q:(\d+):(best|1080|720|480|360|audio)$/.exec(callbackQuery.data || '');
    if (!match) return answer('Unknown action.');

    const pending = telegramPendingLinks.get(match[1]);
    if (!pending) return answer('This link expired. Send the URL again.');

    if (telegramState.activeChats.has(chatId)) {
        return answer('You already have a download running. Use /cancel first.');
    }

    const quality = match[2];
    const job = enqueueTelegramJob(chatId, pending.url, quality);
    if (!job) return answer('The download queue is full. Try again later.');

    telegramPendingLinks.delete(match[1]);
    await answer(`Queued (${TELEGRAM_QUALITY_FORMATS[quality].label})`);

    // Remove the keyboard so the same link is not queued twice.
    telegramJson('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] }
    }).catch(() => {});

    const position = telegramQueue.findIndex(q => q.id === job.id) + 1;
    const queueText = position > 0 ? `Queued as #${job.id}. Position: ${position}.` : `Started as #${job.id}.`;
    await telegramSendMessage(chatId, `${queueText}\nQuality: ${TELEGRAM_QUALITY_FORMATS[quality].label}.\nUse /queue for status or /cancel to cancel.`).catch(() => {});
}

// Route a Telegram update (from webhook or polling) to the right handler.
function handleTelegramUpdate(update) {
    telegramState.lastUpdateAt = new Date().toISOString();
    if (update.message) {
        return handleTelegramMessage(update.message);
    }
    if (update.channel_post) {
        return handleTelegramMessage(update.channel_post);
    }
    if (update.callback_query) {
        return handleTelegramCallback(update.callback_query);
    }
    return Promise.resolve();
}

async function startTelegramBot() {
    if (!TELEGRAM_BOT_TOKEN) {
        console.log('Telegram bot disabled: TELEGRAM_BOT_TOKEN not set.');
        return;
    }
    if (!TELEGRAM_ENABLE_BOT) {
        console.log('Telegram bot disabled: TELEGRAM_ENABLE_BOT is not 1.');
        return;
    }

    if (!acquireTelegramLock()) return;

    try {
        // Retry getMe up to 5 times before giving up
        let me = null;
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                me = await telegramJson('getMe');
                break;
            } catch (err) {
                telegramState.lastError = err.message || String(err);
                console.error(`Telegram bot startup attempt ${attempt}/5 failed: ${err.message}`);
                if (attempt === 5) {
                    console.error('Telegram bot: giving up after 5 failed startup attempts.');
                    releaseTelegramLock();
                    return;
                }
                await sleep(attempt * 3000);
            }
        }

        telegramState.username = me.username || '';
        telegramState.link = telegramState.username ? `https://t.me/${telegramState.username}` : '';
        telegramState.startedAt = new Date().toISOString();

        // Prefer webhook mode when this deployment has a public URL. A webhook
        // always outranks any other instance polling the same token, which
        // permanently fixes 409 getUpdates conflicts between deployments.
        if (TELEGRAM_PUBLIC_URL && TELEGRAM_WEBHOOK_SECRET) {
            try {
                await telegramJson('setWebhook', {
                    url: `${TELEGRAM_PUBLIC_URL}/api/telegram/webhook`,
                    secret_token: TELEGRAM_WEBHOOK_SECRET,
                    allowed_updates: ['message', 'channel_post', 'callback_query'],
                    drop_pending_updates: false
                });
                telegramState.mode = 'webhook';
                telegramState.running = true;
                telegramState.lastError = '';
                console.log(`Telegram bot started in webhook mode: @${telegramState.username} → ${TELEGRAM_PUBLIC_URL}/api/telegram/webhook`);
                return;
            } catch (err) {
                console.error('Telegram setWebhook failed, falling back to polling:', err.message);
            }
        }

        // Polling mode: a webhook and polling cannot run together. Keep pending
        // updates and a persisted offset so a restart does not lose jobs.
        try {
            await telegramJson('deleteWebhook', { drop_pending_updates: false });
        } catch (err) {
            console.error('Telegram deleteWebhook failed (non-fatal):', err.message);
        }

        telegramState.mode = 'polling';
        telegramState.running = true;
        telegramState.lastError = '';
        console.log(`Telegram bot started in polling mode: @${telegramState.username || '(no username)'}`);
    } catch (err) {
        telegramState.running = false;
        telegramState.lastError = err.message || String(err);
        releaseTelegramLock();
        throw err;
    }

    while (!telegramState.stopping) {
        try {
            // Use AbortController so the fetch doesn't hang forever if the
            // connection drops mid-long-poll (local timeout > Telegram timeout).
            const ac = new AbortController();
            const pollTimer = setTimeout(() => ac.abort(), (TELEGRAM_POLL_TIMEOUT_SECONDS + 10) * 1000);
            let updates;
            try {
                updates = await telegramJson('getUpdates', {
                    offset: telegramState.offset,
                    timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
                    allowed_updates: ['message', 'channel_post', 'callback_query']
                }, ac.signal);
            } finally {
                clearTimeout(pollTimer);
            }

            for (const update of (updates || [])) {
                telegramState.offset = update.update_id + 1;
                saveTelegramOffset();
                handleTelegramUpdate(update).catch(err => {
                    console.error('Telegram update handler error:', err.message);
                });
            }
            telegramState.running = true;
            telegramState.lastError = '';
            telegramState.consecutivePollErrors = 0;
        } catch (err) {
            if (err.name === 'AbortError') {
                // Poll timed out locally — normal, just retry immediately
                continue;
            }

            telegramState.pollErrors += 1;
            telegramState.consecutivePollErrors += 1;

            // 409 Conflict means another instance is polling
            if (err.errorCode === 409 || (err.message || '').toLowerCase().includes('conflict')) {
                telegramState.running = false;
                telegramState.lastError = '409 conflict: another bot instance is polling. Retrying...';
                console.error('Telegram: 409 conflict — another instance is polling. Retrying in 2s...');
                await sleep(2000);
            } else if (err.errorCode === 429) {
                const retryAfter = Number(err.parameters?.retry_after || 5);
                telegramState.running = false;
                telegramState.lastError = `Rate limited by Telegram. Retrying in ${retryAfter}s.`;
                console.error(`Telegram polling rate limited. Retrying in ${retryAfter}s...`);
                await sleep(Math.min(60, Math.max(1, retryAfter)) * 1000);
            } else {
                telegramState.running = false;
                telegramState.lastError = err.message || String(err);
                console.error('Telegram polling error:', err.message);
                await sleep(Math.min(30000, 3000 * telegramState.consecutivePollErrors));
            }
        }
    }

    telegramState.running = false;
    releaseTelegramLock();
}

// Receives updates pushed by Telegram in webhook mode. The secret header
// proves the request really came from Telegram for this bot token.
app.post('/api/telegram/webhook', (req, res) => {
    if (!telegramState.enabled || !TELEGRAM_WEBHOOK_SECRET ||
        req.get('x-telegram-bot-api-secret-token') !== TELEGRAM_WEBHOOK_SECRET) {
        return res.sendStatus(403);
    }
    // Acknowledge immediately; process in the background so Telegram never
    // retries an update just because a download is slow.
    res.sendStatus(200);
    telegramState.running = true;
    handleTelegramUpdate(req.body || {}).catch(err => {
        console.error('Telegram webhook update error:', err.message);
    });
});

app.get('/api/telegram/status', (req, res) => {
    res.json({
        enabled: telegramState.enabled,
        running: telegramState.running,
        mode: telegramState.mode,
        lockOwner: telegramState.lockOwner,
        username: telegramState.username,
        link: telegramState.link,
        maxUploadMb: TELEGRAM_MAX_UPLOAD_MB,
        autoSaveEnabled: Boolean(TELEGRAM_SAVE_CHAT_ID),
        activeDownloads: telegramState.activeChats.size,
        activeJobs: telegramActiveJobs.size,
        queuedJobs: telegramQueue.length,
        maxConcurrentDownloads: TELEGRAM_MAX_CONCURRENT_DOWNLOADS,
        maxQueueSize: TELEGRAM_MAX_QUEUE_SIZE,
        allowedChats: TELEGRAM_ALLOWED_CHAT_IDS.size,
        lastUpdateAt: telegramState.lastUpdateAt,
        lastMessageAt: telegramState.lastMessageAt,
        startedAt: telegramState.startedAt,
        pollErrors: telegramState.pollErrors,
        consecutivePollErrors: telegramState.consecutivePollErrors,
        completedJobs: telegramState.completedJobs,
        failedJobs: telegramState.failedJobs,
        canceledJobs: telegramState.canceledJobs,
        cleanup: cleanupState,
        lastError: telegramState.lastError
    });
});

// The web app calls this after its Download button is pressed. It queues a
// separate Telegram delivery without delaying the browser download.
app.post('/api/telegram/save', async (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'A valid video URL is required.' });
    }
    if (!telegramState.enabled || !TELEGRAM_SAVE_CHAT_ID) {
        return res.status(503).json({ error: 'Telegram auto-save is not configured.' });
    }
    if (!isTelegramChatAllowed(TELEGRAM_SAVE_CHAT_ID)) {
        return res.status(503).json({ error: 'Telegram auto-save chat is not allowed.' });
    }
    if (telegramState.activeChats.has(TELEGRAM_SAVE_CHAT_ID)) {
        return res.status(202).json({ queued: false, message: 'Telegram is already saving a video.' });
    }

    const job = enqueueTelegramJob(TELEGRAM_SAVE_CHAT_ID, url, 'best');
    if (!job) return res.status(429).json({ error: 'Telegram download queue is full.' });
    return res.status(202).json({ queued: true, jobId: job.id });
});

// ── DOWNLOAD CLEANUP ────────────────────────────────────────────────────
function cleanupDownloads() {
    const now = Date.now();
    const maxAgeMs = DOWNLOAD_CLEANUP_AGE_MINUTES * 60 * 1000;
    let deleted = 0;
    let freed = 0;

    try {
        for (const name of fs.readdirSync(DOWNLOADS_DIR)) {
            const filePath = path.join(DOWNLOADS_DIR, name);
            if (filePath === TELEGRAM_LOCK_PATH || telegramActiveFiles.has(filePath)) continue;
            if (name === '_youtube_cookies.txt' || name === path.basename(TELEGRAM_OFFSET_PATH)) continue;

            const stat = fs.statSync(filePath);
            if (!stat.isFile()) continue;
            if (now - stat.mtimeMs < maxAgeMs) continue;

            fs.unlinkSync(filePath);
            deleted += 1;
            freed += stat.size;
        }

        cleanupState.lastRunAt = new Date().toISOString();
        cleanupState.deletedFiles += deleted;
        cleanupState.freedBytes += freed;
        cleanupState.lastError = '';
        if (deleted > 0) {
            console.log(`Cleanup removed ${deleted} stale download files (${(freed / 1024 / 1024).toFixed(1)} MB).`);
        }
    } catch (err) {
        cleanupState.lastRunAt = new Date().toISOString();
        cleanupState.lastError = err.message || String(err);
        console.error('Download cleanup error:', err.message);
    }
}

function startCleanupScheduler() {
    cleanupDownloads();
    cleanupTimer = setInterval(cleanupDownloads, DOWNLOAD_CLEANUP_INTERVAL_MINUTES * 60 * 1000);
    if (cleanupTimer.unref) cleanupTimer.unref();
}

// ── HEALTH CHECK ────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    if (!ytDlpAvailable) {
        return res.status(503).json({ status: 'error', message: ytDlpErrorMessage || 'yt-dlp is unavailable.' });
    }

    const youtubeHealthUrl = isYoutubeUrl(req.query.url)
        ? req.query.url
        : process.env.YOUTUBE_HEALTH_CHECK_URL;

    try {
        const version = (await execYtDlpPromise(['--version'], 30000)).trim();

        if (isYoutubeUrl(youtubeHealthUrl)) {
            await execYtDlpPromise([
                youtubeHealthUrl,
                '--dump-json',
                '--no-warnings',
                '--no-playlist',
                '--socket-timeout', '15',
                '--retries', '1',
                ...siteArgs(youtubeHealthUrl)
            ], 45000);
        }

        res.json({ status: 'ok', ytDlpVersion: version, ytDlpCommand: ytDlpCommand.join(' ') });
    } catch (err) {
        const payload = apiErrorPayload(err.message, youtubeHealthUrl);
        res.status(503).json({
            status: 'error',
            message: payload.code === 'YOUTUBE_COOKIES_REQUIRED'
                ? payload.error
                : 'yt-dlp is installed but could not be executed.',
            code: payload.code,
            details: err.message
        });
    }
});

// ── YT-DLP SELF-UPDATE ──────────────────────────────────────────────────
// Site extractors break constantly as platforms change; a stale yt-dlp is
// the most common reason "every link fails". Best-effort update at startup
// and every 12 hours (no-op for pip-managed installs).
function updateYtDlp() {
    if (!ytDlpAvailable) return;
    try {
        const proc = spawnYtDlp(['-U']);
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.stderr.on('data', d => { out += d.toString(); });
        proc.on('error', () => {});
        proc.on('close', code => {
            const summary = out.trim().split('\n').pop() || '';
            if (code === 0 && /updated/i.test(out)) {
                console.log(`yt-dlp self-update: ${summary}`);
            }
        });
    } catch {}
}

function startYtDlpUpdateScheduler() {
    updateYtDlp();
    const timer = setInterval(updateYtDlp, 12 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
}

// ── START SERVER ────────────────────────────────────────────────────────
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║     🎬  Video Downloader Server Running      ║
║     📡  http://${HOST}:${PORT}                ║
║     🎯  YouTube | Facebook | TikTok          ║
╚══════════════════════════════════════════════╝
    `);
    startCleanupScheduler();
    startYtDlpUpdateScheduler();
    startTelegramBot().catch(err => {
        console.error('Telegram bot fatal error:', err.message);
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the existing server or start this app with another port, for example: $env:PORT=3001; npm start`);
        process.exit(1);
    }

    console.error('Server startup error:', err.message);
    process.exit(1);
});

function stopTelegramBot() {
    telegramState.stopping = true;
    if (cleanupTimer) clearInterval(cleanupTimer);
    releaseTelegramLock();
}

process.on('exit', stopTelegramBot);
process.on('SIGINT', () => {
    stopTelegramBot();
    process.exit(0);
});
process.on('SIGTERM', () => {
    stopTelegramBot();
    process.exit(0);
});
