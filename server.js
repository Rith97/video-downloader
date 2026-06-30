const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const YTDlpWrap = require('yt-dlp-wrap').default;

// On Linux use the system ffmpeg (apt-installed); ffmpeg-static crashes with SIGSEGV there.
const ffmpegStatic = process.platform === 'linux'
    ? (fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg')
    : require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure downloads directory exists
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Resolve the yt-dlp executable in a way that prefers the newer Python-installed binary when available
let ytDlpBinaryPath = 'yt-dlp';
let ytDlpWrap = null;
let ytDlpAvailable = true;
let ytDlpErrorMessage = '';

const venvYtDlp = process.platform === 'win32'
    ? path.join(__dirname, '.venv', 'Scripts', 'yt-dlp.exe')
    : path.join(__dirname, '.venv', 'bin', 'yt-dlp');
const localBinary = path.join(__dirname, 'yt-dlp.exe');
const candidateBinaries = [];

if (fs.existsSync(venvYtDlp)) {
    candidateBinaries.push(venvYtDlp);
}
if (process.platform === 'win32' && fs.existsSync(localBinary)) {
    candidateBinaries.push(localBinary);
}
candidateBinaries.push('yt-dlp');

const resolvedBinary = candidateBinaries.find(candidate => {
    if (candidate === 'yt-dlp') return true;
    return fs.existsSync(candidate);
});

if (resolvedBinary) {
    ytDlpBinaryPath = resolvedBinary;
    try {
        ytDlpWrap = new YTDlpWrap(ytDlpBinaryPath);
    } catch (err) {
        ytDlpAvailable = false;
        ytDlpErrorMessage = `Unable to initialize yt-dlp: ${err.message}`;
    }
} else {
    ytDlpAvailable = false;
    ytDlpErrorMessage = 'yt-dlp binary was not found. Install yt-dlp or place yt-dlp.exe in the app folder.';
}

function sendYtDlpUnavailable(res) {
    return res.status(503).json({
        error: ytDlpErrorMessage || 'yt-dlp is currently unavailable.'
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

// Extra args per site
function siteArgs(url) {
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
    const venv = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
    if (process.platform === 'win32' && fs.existsSync(venv)) return venv;
    return 'python3';
}

function runPythonScript(code, args = []) {
    return new Promise((resolve, reject) => {
        const proc = spawn(getBrowserPython(), ['-c', code, ...args]);
        let out = '', err = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.stderr.on('data', d => { err += d.toString(); });
        proc.on('close', code => {
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

    if (!ytDlpAvailable || !ytDlpWrap) {
        return sendYtDlpUnavailable(res);
    }

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const stdout = await ytDlpWrap.execPromise([
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

// ── DOWNLOAD VIDEO ──────────────────────────────────────────────────────
app.get('/api/download', async (req, res) => {
    const { url, format } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const timestamp = Date.now();
    const outputTemplate = path.join(DOWNLOADS_DIR, `%(title)s_${timestamp}.%(ext)s`);

    // curl-based download for javgg.net
    if (isCurlSite(url)) {
        if (!ytDlpAvailable || !ytDlpWrap) return sendYtDlpUnavailable(res);
        try {
            const cached = getExtractCache(url);
            const data = (cached?.type === 'javgg') ? cached : await getJavggVideoUrl(url);
            const args = [
                data.m3u8,
                '--ffmpeg-location', ffmpegStatic,
                '-o', outputTemplate,
                '--no-warnings',
                '--add-header', `Referer:${data.referer}`,
                '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                '--merge-output-format', 'mp4',
                '-S', 'vcodec:h264,acodec:aac,res,br',
                '-f', 'bestvideo+bestaudio/best',
                '--recode-video', 'mp4',
            ];
            await new Promise((resolve, reject) => {
                const emitter = ytDlpWrap.exec(args);
                let stderr = '';
                emitter.ytDlpProcess?.stderr?.on('data', d => { stderr += d.toString(); });
                emitter.on('error', reject);
                emitter.on('close', code => {
                    if (code === 0) resolve();
                    else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
                });
            });
            const files = fs.readdirSync(DOWNLOADS_DIR)
                .filter(f => f.includes(`_${timestamp}`))
                .map(f => ({ name: f, path: path.join(DOWNLOADS_DIR, f), time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
                .sort((a, b) => b.time - a.time);
            if (files.length === 0) return res.status(500).json({ error: 'Download completed but file not found' });
            const file = files[0];
            const cleanName = file.name.replace(`_${timestamp}`, '');
            res.download(file.path, cleanName, () => {
                try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {}
            });
        } catch (err) {
            console.error('javgg.net download error:', err.message);
            res.status(500).json({ error: err.message || 'javgg.net download failed.' });
        }
        return;
    }

    // curl-based download for MissAV pages
    if (isMissavSite(url)) {
        if (!ytDlpAvailable || !ytDlpWrap) return sendYtDlpUnavailable(res);

        try {
            const cached = getExtractCache(url);
            const data = (cached?.type === 'missav') ? cached : await getMissavVideoUrl(url);
            const args = [
                data.videoUrl,
                '--ffmpeg-location', ffmpegStatic,
                '-o', outputTemplate,
                '--no-warnings',
                '--add-header', `Referer:${data.referer}`,
                '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                '--merge-output-format', 'mp4',
                '-S', 'vcodec:h264,acodec:aac,res,br',
                '-f', 'bestvideo+bestaudio/best',
                '--recode-video', 'mp4',
            ];
            await new Promise((resolve, reject) => {
                const emitter = ytDlpWrap.exec(args);
                let stderr = '';
                emitter.ytDlpProcess?.stderr?.on('data', d => { stderr += d.toString(); });
                emitter.on('error', reject);
                emitter.on('close', code => {
                    if (code === 0) resolve();
                    else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
                });
            });
            const files = fs.readdirSync(DOWNLOADS_DIR)
                .filter(f => f.includes(`_${timestamp}`))
                .map(f => ({ name: f, path: path.join(DOWNLOADS_DIR, f), time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
                .sort((a, b) => b.time - a.time);
            if (files.length === 0) return res.status(500).json({ error: 'Download completed but file not found' });
            const file = files[0];
            const cleanName = file.name.replace(`_${timestamp}`, '');
            res.download(file.path, cleanName, () => {
                try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {}
            });
        } catch (err) {
            console.error('MissAV download error:', err.message);
            res.status(500).json({ error: err.message || 'MissAV download failed.' });
        }
        return;
    }

    // Browser-based download for JAV sites
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
                '--cookies', cookiePath,
                '--add-header', `Referer:${referer}`,
                '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                '--merge-output-format', 'mp4',
                '--extractor-args', 'generic:impersonate',
                '-S', 'vcodec:h264,acodec:aac,res,br',
                '-f', 'bestvideo+bestaudio/best',
                '--recode-video', 'mp4',
            ];

            await new Promise((resolve, reject) => {
                const emitter = ytDlpWrap.exec(args);
                let stderr = '';
                emitter.ytDlpProcess?.stderr?.on('data', d => { stderr += d.toString(); });
                emitter.on('error', reject);
                emitter.on('close', code => {
                    if (code === 0) resolve();
                    else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
                });
            });

            const files = fs.readdirSync(DOWNLOADS_DIR)
                .filter(f => f.includes(`_${timestamp}`))
                .map(f => ({ name: f, path: path.join(DOWNLOADS_DIR, f), time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
                .sort((a, b) => b.time - a.time);

            if (files.length === 0) return res.status(500).json({ error: 'Download completed but file not found' });

            const file = files[0];
            const cleanName = file.name.replace(`_${timestamp}`, '');
            res.download(file.path, cleanName, () => {
                try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {}
            });
        } catch (err) {
            console.error('Browser download error:', err.message);
            let msg = err.message || 'Browser extraction failed.';
            if (/403|UserProjectAccountProblem|unable to download/i.test(msg)) {
                msg = 'This video\'s CDN is currently unavailable (server-side billing issue). Please try again later or check if the site has restored their video hosting.';
            } else if (/521|522|502|Bad Gateway/i.test(msg)) {
                msg = 'The video CDN is down. Please try again later.';
            }
            res.status(500).json({ error: msg });
        } finally {
            if (cookiePath) try { fs.unlinkSync(cookiePath); } catch {}
        }
        return;
    }

    if (!ytDlpAvailable || !ytDlpWrap) {
        return sendYtDlpUnavailable(res);
    }

    try {
        // Build yt-dlp arguments
        const args = [
            url,
            '--ffmpeg-location', ffmpegStatic,
            '-o', outputTemplate,
            '--no-playlist',
            '--no-warnings',
            '--socket-timeout', '30',
            '--retries', '3',
            '--merge-output-format', 'mp4',
            ...siteArgs(url)
        ];

        // Sort formats: prefer H.264 video + AAC audio for maximum device compatibility.
        // -S is applied before -f so the best matching format wins.
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

        // If the merged file still isn't H.264+AAC (e.g. VP9/AV1 fallback),
        // recode to a universally playable mp4.
        args.push('--recode-video', 'mp4');

        // Execute download
        await new Promise((resolve, reject) => {
            const emitter = ytDlpWrap.exec(args);
            let stderr = '';

            emitter.ytDlpProcess?.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            emitter.on('error', (err) => reject(err));

            emitter.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
            });
        });

        // Find the downloaded file
        const files = fs.readdirSync(DOWNLOADS_DIR)
            .filter(f => f.includes(`_${timestamp}`))
            .map(f => ({
                name: f,
                path: path.join(DOWNLOADS_DIR, f),
                time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs
            }))
            .sort((a, b) => b.time - a.time);

        if (files.length === 0) {
            return res.status(500).json({ error: 'Download completed but file not found' });
        }

        const file = files[0];
        const cleanName = file.name.replace(`_${timestamp}`, '');

        // Stream file to client then cleanup
        res.download(file.path, cleanName, (err) => {
            // Cleanup: delete the file after sending
            try {
                if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
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

// ── HEALTH CHECK ────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    if (!ytDlpAvailable || !ytDlpWrap) {
        return res.status(503).json({ status: 'error', message: ytDlpErrorMessage || 'yt-dlp is unavailable.' });
    }

    try {
        const version = await ytDlpWrap.getVersion();
        res.json({ status: 'ok', ytDlpVersion: version });
    } catch (err) {
        res.status(503).json({ status: 'error', message: 'yt-dlp is installed but could not be executed.' });
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
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the existing server or start this app with another port, for example: $env:PORT=3001; npm start`);
        process.exit(1);
    }

    console.error('Server startup error:', err.message);
    process.exit(1);
});
