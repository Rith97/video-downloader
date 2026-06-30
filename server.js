const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegStatic = require('ffmpeg-static');

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

const venvYtDlp = path.join(__dirname, '.venv', 'Scripts', 'yt-dlp.exe');
const localBinary = path.join(__dirname, 'yt-dlp.exe');
const candidateBinaries = [];

if (process.platform === 'win32' && fs.existsSync(venvYtDlp)) {
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

// ── GET VIDEO INFO ──────────────────────────────────────────────────────
app.post('/api/info', async (req, res) => {
    const { url } = req.body;

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

    if (!ytDlpAvailable || !ytDlpWrap) {
        return sendYtDlpUnavailable(res);
    }

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const timestamp = Date.now();
    const outputTemplate = path.join(DOWNLOADS_DIR, `%(title)s_${timestamp}.%(ext)s`);

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

        // Format selector chain — in order of preference:
        //  1. H.264 video + AAC audio (best phone compatibility, split streams)
        //  2. H.264 video + any audio (Vimeo/Dailymotion use HLS audio with acodec=none)
        //  3. Any best video + any audio
        //  4. Best single combined stream in mp4
        //  5. Best anything (ultimate fallback — never fails if yt-dlp can reach the video)
        if (format && format !== 'best') {
            args.push('-f', [
                `${format}+bestaudio[acodec~='^(mp4a|aac)']`,
                `${format}+bestaudio`,
                format,
                'best'
            ].join('/'));
        } else {
            args.push('-f', [
                "bestvideo[vcodec~='^(avc1|h264)']+bestaudio[acodec~='^(mp4a|aac)']",
                "bestvideo[vcodec~='^(avc1|h264)']+bestaudio",
                "bestvideo+bestaudio",
                "best[ext=mp4]",
                "best"
            ].join('/'));
        }

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
app.listen(PORT, HOST, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║     🎬  Video Downloader Server Running      ║
║     📡  http://${HOST}:${PORT}                ║
║     🎯  YouTube | Facebook | TikTok          ║
╚══════════════════════════════════════════════╝
    `);
});
