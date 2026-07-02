const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
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
// than timeoutMs (default 10 min). Kills the child process on timeout.
function runYtDlp(args, timeoutMs = 10 * 60 * 1000) {
    return new Promise((resolve, reject) => {
        const proc = spawnYtDlp(args);
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { proc.kill('SIGTERM'); } catch {}
            reject(new Error('Download timed out (10-minute limit). Try a shorter clip or lower quality.'));
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
    const raw = process.env.YOUTUBE_COOKIES;
    if (!raw) return null;
    try {
        youtubeCookiesPath = path.join(DOWNLOADS_DIR, '_youtube_cookies.txt');
        fs.writeFileSync(youtubeCookiesPath, raw);
    } catch (err) {
        console.error('Failed to write YouTube cookies file:', err.message);
        youtubeCookiesPath = null;
    }
    return youtubeCookiesPath;
}

// Extra args per site
function siteArgs(url) {
    if (/youtube\.com|youtu\.be/i.test(url)) {
        const cookiesPath = getYoutubeCookiesPath();
        return cookiesPath ? ['--cookies', cookiesPath] : [];
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
    if (/tiktok\.com|vm\.tiktok\.com/i.test(url)) {
        return ['--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com'];
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
function friendlyError(raw) {
    const msg = (raw || '').toLowerCase();
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
            return res.json({
                title: data.title || 'JAV Video',
                thumbnail: data.thumbnail || null,
                duration: 0,
                uploader: 'javgg.net',
                platform: 'javgg.net',
                viewCount: 0,
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
            return res.json({
                title: data.title || 'MissAV Video',
                thumbnail: data.thumbnail || null,
                duration: 0,
                uploader: 'missav',
                platform: 'missav',
                viewCount: 0,
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
        const stdout = await execYtDlpPromise([
            url,
            '--dump-json',
            '--no-warnings',
            '--no-playlist',
            '--socket-timeout', '30',
            '--retries', '3',
            '--ffmpeg-location', ffmpegStatic,
            ...siteArgs(url)
        ]);
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

        res.json({
            title: metadata.title || 'Unknown Title',
            thumbnail: metadata.thumbnail || null,
            duration: metadata.duration || 0,
            uploader: metadata.uploader || metadata.channel || 'Unknown',
            platform: metadata.extractor_key || metadata.extractor || 'Unknown',
            viewCount: metadata.view_count || 0,
            formats: uniqueFormats.length > 0 ? uniqueFormats : [
                { formatId: 'best', ext: 'mp4', quality: 'Best Quality', resolution: 'best' }
            ]
        });
    } catch (err) {
        console.error('Info fetch error:', err.message);
        res.status(500).json({ error: friendlyError(err.message) });
    }
});

function findDownloadedFile(timestamp) {
    const files = fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.includes(`_${timestamp}`))
        .map(f => ({
            name: f,
            path: path.join(DOWNLOADS_DIR, f),
            time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs
        }))
        .sort((a, b) => b.time - a.time);

    if (files.length === 0) {
        throw new Error('Download completed but file not found');
    }

    const file = files[0];
    return {
        filePath: file.path,
        cleanName: file.name.replace(`_${timestamp}`, '')
    };
}

async function downloadVideoToFile(url, options = {}) {
    const format = options.format || 'best';
    const fastDownload = options.fastDownload !== false;
    const timestamp = Date.now();
    const outputTemplate = path.join(DOWNLOADS_DIR, `%(title)s_${timestamp}.%(ext)s`);

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
            '--trim-filenames', '50',
            '--no-warnings',
            '--add-header', `Referer:${data.referer}`,
            '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            '--merge-output-format', 'mp4',
            '-S', 'vcodec:h264,acodec:aac,res,br',
            '-f', 'bestvideo+bestaudio/best',
            '--recode-video', 'mp4',
        ];
        await runYtDlp(args);
        return findDownloadedFile(timestamp);
    }

    if (isMissavSite(url)) {
        const cached = getExtractCache(url);
        const data = (cached?.type === 'missav') ? cached : await getMissavVideoUrl(url);
        const args = [
            data.videoUrl,
            '--ffmpeg-location', ffmpegStatic,
            '-o', outputTemplate,
            '--trim-filenames', '50',
            '--no-warnings',
            '--add-header', `Referer:${data.referer}`,
            '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            '--merge-output-format', 'mp4',
            '-S', 'vcodec:h264,acodec:aac,res,br',
            '-f', 'bestvideo+bestaudio/best',
            '--recode-video', 'mp4',
        ];
        await runYtDlp(args);
        return findDownloadedFile(timestamp);
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
                '--trim-filenames', '50',
                '--no-warnings',
                '--cookies', cookiePath,
                '--add-header', `Referer:${referer}`,
                '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                '--merge-output-format', 'mp4',
                '--extractor-args', 'generic:impersonate',
                '-S', 'vcodec:h264,acodec:aac,res,br',
                '-f', 'bestvideo+bestaudio/best',
                '--recode-video', 'mp4',
            ];
            await runYtDlp(args);
            return findDownloadedFile(timestamp);
        } finally {
            if (cookiePath) try { fs.unlinkSync(cookiePath); } catch {}
        }
    }

    const args = [
        url,
        '--ffmpeg-location', ffmpegStatic,
        '-o', outputTemplate,
        '--trim-filenames', '50',
        '--no-playlist',
        '--no-warnings',
        '--socket-timeout', '30',
        '--retries', '3',
        '--fragment-retries', '5',
        '--concurrent-fragments', '6',
        '--merge-output-format', 'mp4',
        ...siteArgs(url)
    ];

    if (fastDownload) {
        args.push('-S', 'vcodec:h264,acodec:aac,res,br');
        if (format && format !== 'best') {
            args.push('-f', [
                format,
                'best[ext=mp4][vcodec^=avc1][acodec^=mp4a]',
                'best[ext=mp4]',
                'best'
            ].join('/'));
        } else {
            args.push('-f', [
                'best[ext=mp4][vcodec^=avc1][acodec^=mp4a]',
                'best[ext=mp4]',
                'best'
            ].join('/'));
        }
    } else {
        args.push('-S', 'vcodec:h264,acodec:aac,res,br');
        if (format && format !== 'best') {
            args.push('-f', [
                `${format}+bestaudio[acodec~='^(mp4a|aac)']`,
                `${format}+bestaudio`,
                format,
                'best'
            ].join('/'));
        } else {
            args.push('-f', 'bestvideo+bestaudio/best');
        }
        args.push('--recode-video', 'mp4');
    }

    await runYtDlp(args);
    return findDownloadedFile(timestamp);
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
        res.status(500).json({ error: friendlyError(err.message) });
    }
});

// ── TELEGRAM BOT DOWNLOADS ──────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ALLOWED_CHAT_IDS = new Set(
    (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
);
const TELEGRAM_MAX_UPLOAD_MB = Number(process.env.TELEGRAM_MAX_UPLOAD_MB || 49);
const telegramState = {
    enabled: Boolean(TELEGRAM_BOT_TOKEN),
    username: '',
    link: '',
    offset: 0,
    activeChats: new Set(),
    running: false
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractFirstUrl(text = '') {
    const match = text.match(/https?:\/\/[^\s<>"']+/i);
    return match ? match[0] : '';
}

function isTelegramChatAllowed(chatId) {
    return TELEGRAM_ALLOWED_CHAT_IDS.size === 0 || TELEGRAM_ALLOWED_CHAT_IDS.has(String(chatId));
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
        throw err;
    }
    return data.result;
}

async function telegramSendMessage(chatId, text) {
    return telegramJson('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true
    });
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
        chunks.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${fileField}"; filename="${safeName}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`
        ));
        const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
        const fileSize = fs.statSync(filePath).size;
        const contentLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + fileSize + closing.length;

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
                let parsed = {};
                try { parsed = JSON.parse(body); } catch {}
                if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false) {
                    resolve(parsed.result);
                } else {
                    reject(new Error(parsed.description || `Telegram upload failed with status ${res.statusCode}`));
                }
            });
        });

        req.on('error', reject);
        for (const chunk of chunks) req.write(chunk);
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('end', () => req.end(closing));
        stream.pipe(req, { end: false });
    });
}

async function telegramSendDocument(chatId, filePath, filename, caption) {
    const sizeMb = fs.statSync(filePath).size / 1024 / 1024;
    if (sizeMb > TELEGRAM_MAX_UPLOAD_MB) {
        throw new Error(`File is ${sizeMb.toFixed(1)} MB. Telegram bot upload limit is ${TELEGRAM_MAX_UPLOAD_MB} MB.`);
    }

    return telegramMultipart('sendDocument', {
        chat_id: chatId,
        caption: caption.slice(0, 1024)
    }, 'document', filePath, filename);
}

async function handleTelegramMessage(message) {
    const chatId = message.chat?.id;
    const text = message.text || message.caption || '';
    if (!chatId) return;

    if (!isTelegramChatAllowed(chatId)) {
        await telegramSendMessage(chatId, `⛔ Access denied. Your chat ID is: ${chatId}\nAsk the admin to add it to TELEGRAM_ALLOWED_CHAT_IDS.`);
        return;
    }

    if (/^\/start\b|^\/help\b/i.test(text)) {
        await telegramSendMessage(chatId,
            '🎬 *VideoGrab Bot*\n\nPaste any video URL and I\'ll download it and send the file here.\n\nSupported: YouTube, TikTok, Instagram, Facebook, Twitter, Reddit, and many more.'
        );
        return;
    }

    const url = extractFirstUrl(text);
    if (!url) {
        await telegramSendMessage(chatId, '📎 Send me a video URL to download.');
        return;
    }

    if (telegramState.activeChats.has(chatId)) {
        await telegramSendMessage(chatId, '⏳ A download is already in progress. Please wait.');
        return;
    }

    telegramState.activeChats.add(chatId);
    let filePath = '';
    try {
        await telegramSendMessage(chatId, '⬇️ Downloading…');
        const file = await downloadVideoToFile(url, { format: 'best', fastDownload: true });
        filePath = file.filePath;
        const sizeMb = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
        await telegramSendMessage(chatId, `📤 Uploading (${sizeMb} MB)…`);
        await telegramSendDocument(chatId, file.filePath, file.cleanName, `🎬 ${file.cleanName}\n${url}`);
    } catch (err) {
        console.error('Telegram bot download error:', err.message);
        const msg = err.message || '';
        if (msg.includes('MB. Telegram bot upload limit')) {
            await telegramSendMessage(chatId, `❌ ${msg}`).catch(() => {});
        } else {
            await telegramSendMessage(chatId, `❌ ${friendlyError(msg)}`).catch(() => {});
        }
    } finally {
        telegramState.activeChats.delete(chatId);
        if (filePath) try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }
}

async function startTelegramBot() {
    if (!TELEGRAM_BOT_TOKEN) {
        console.log('Telegram bot disabled: TELEGRAM_BOT_TOKEN not set.');
        return;
    }

    // Retry getMe up to 5 times before giving up
    let me = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            me = await telegramJson('getMe');
            break;
        } catch (err) {
            console.error(`Telegram bot startup attempt ${attempt}/5 failed: ${err.message}`);
            if (attempt === 5) {
                console.error('Telegram bot: giving up after 5 failed startup attempts.');
                return;
            }
            await sleep(attempt * 3000);
        }
    }

    telegramState.username = me.username || '';
    telegramState.link = telegramState.username ? `https://t.me/${telegramState.username}` : '';
    telegramState.running = true;
    console.log(`Telegram bot started: @${telegramState.username || '(no username)'}`);

    while (true) {
        telegramState.running = true;
        try {
            // Use AbortController so the fetch doesn't hang forever if the
            // connection drops mid-long-poll (35s > 25s Telegram timeout).
            const ac = new AbortController();
            const pollTimer = setTimeout(() => ac.abort(), 35000);
            let updates;
            try {
                updates = await telegramJson('getUpdates', {
                    offset: telegramState.offset,
                    timeout: 25,
                    allowed_updates: ['message']
                }, ac.signal);
            } finally {
                clearTimeout(pollTimer);
            }

            for (const update of updates) {
                telegramState.offset = update.update_id + 1;
                if (update.message) {
                    handleTelegramMessage(update.message).catch(err => {
                        console.error('Telegram message handler error:', err.message);
                    });
                }
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                // Poll timed out locally — normal, just retry immediately
                continue;
            }

            telegramState.running = false;

            // 409 Conflict means another instance is polling — back off longer
            if (err.errorCode === 409 || (err.message || '').toLowerCase().includes('conflict')) {
                console.error('Telegram: 409 conflict — another instance is polling. Backing off 30s…');
                await sleep(30000);
            } else {
                console.error('Telegram polling error:', err.message);
                await sleep(3000);
            }
        }
    }
}

app.get('/api/telegram/status', (req, res) => {
    res.json({
        enabled: telegramState.enabled,
        running: telegramState.running,
        username: telegramState.username,
        link: telegramState.link,
        maxUploadMb: TELEGRAM_MAX_UPLOAD_MB
    });
});

// ── HEALTH CHECK ────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    if (!ytDlpAvailable) {
        return res.status(503).json({ status: 'error', message: ytDlpErrorMessage || 'yt-dlp is unavailable.' });
    }

    try {
        const version = (await execYtDlpPromise(['--version'], 30000)).trim();
        res.json({ status: 'ok', ytDlpVersion: version, ytDlpCommand: ytDlpCommand.join(' ') });
    } catch (err) {
        res.status(503).json({ status: 'error', message: 'yt-dlp is installed but could not be executed.', details: err.message });
    }
});

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
