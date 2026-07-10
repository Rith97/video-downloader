// ── DOM ELEMENTS ─────────────────────────────────────────────────────────
const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const pasteBtn = document.getElementById('pasteBtn');
const clearBtn = document.getElementById('clearBtn');
const fetchBtnText = document.querySelector('.fetch-btn-text');
const fetchBtnLoader = document.querySelector('.fetch-btn-loader');
const detectedPlatform = document.getElementById('detectedPlatform');
const platformIcon = document.getElementById('platformIcon');
const platformName = document.getElementById('platformName');
const errorMessage = document.getElementById('errorMessage');
const errorText = document.getElementById('errorText');
const videoCard = document.getElementById('videoCard');
const videoThumbnail = document.getElementById('videoThumbnail');
const videoTitle = document.getElementById('videoTitle');
const videoDuration = document.getElementById('videoDuration');
const videoPlatformBadge = document.getElementById('videoPlatformBadge');
const videoUploader = document.getElementById('videoUploader');
const videoViews = document.getElementById('videoViews');
const qualitySelect = document.getElementById('qualitySelect');
const downloadBtn = document.getElementById('downloadBtn');
const downloadProgress = document.getElementById('downloadProgress');
const progressBarFill = document.getElementById('progressBarFill');
const statusText = document.getElementById('statusText');
const badgeDot = document.querySelector('.badge-dot');
const inputWrapper = document.getElementById('inputWrapper');
const historySection = document.getElementById('historySection');
const historyList = document.getElementById('historyList');
const historyClearBtn = document.getElementById('historyClearBtn');
const telegramBotCard = document.getElementById('telegramBotCard');
const telegramBotText = document.getElementById('telegramBotText');
const telegramBotLink = document.getElementById('telegramBotLink');

const HISTORY_KEY = 'videograb_history';
const MAX_HISTORY = 20;
const YOUTUBE_COOKIES_REQUIRED_CODE = 'YOUTUBE_COOKIES_REQUIRED';
const YOUTUBE_COOKIES_REQUIRED_MESSAGE = 'This deployment needs YOUTUBE_COOKIES to access YouTube. Set YOUTUBE_COOKIES from a logged-in YouTube cookies.txt export, then redeploy.';

// ── STATE ────────────────────────────────────────────────────────────────
let currentVideoUrl = '';
let currentVideoInfo = null;
let fetchAbortController = null;
let downloadAbortController = null;

// ── INIT ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    createParticles();
    checkServerHealth();
    checkTelegramBot();
    setupEventListeners();
    renderHistory();
});

// ── PARTICLES ────────────────────────────────────────────────────────────
function createParticles() {
    const container = document.getElementById('particles');
    const count = 25;

    for (let i = 0; i < count; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.left = `${Math.random() * 100}%`;
        particle.style.animationDuration = `${8 + Math.random() * 12}s`;
        particle.style.animationDelay = `${Math.random() * 10}s`;
        particle.style.width = `${2 + Math.random() * 3}px`;
        particle.style.height = particle.style.width;

        const colors = [
            'rgba(139, 92, 246, 0.4)',
            'rgba(236, 72, 153, 0.3)',
            'rgba(59, 130, 246, 0.3)',
            'rgba(16, 185, 129, 0.3)'
        ];
        particle.style.background = colors[Math.floor(Math.random() * colors.length)];

        container.appendChild(particle);
    }
}

// ── SERVER HEALTH CHECK ──────────────────────────────────────────────────
async function checkServerHealth() {
    try {
        const res = await fetch('/api/health');
        const contentType = res.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await res.json() : { message: await res.text() };

        if (res.ok && data.status === 'ok') {
            statusText.textContent = `Ready • yt-dlp ${data.ytDlpVersion}`;
            badgeDot.classList.remove('error');
        } else {
            statusText.textContent = getApiErrorMessage(data, 'yt-dlp not found');
            badgeDot.classList.add('error');
        }
    } catch {
        statusText.textContent = 'Server offline';
        badgeDot.classList.add('error');
    }
}

async function checkTelegramBot() {
    if (!telegramBotCard || !telegramBotLink) return;

    try {
        const res = await fetch('/api/telegram/status');
        const data = await res.json();
        if (!res.ok || !data.running || !data.link) {
            telegramBotCard.style.display = 'none';
            return;
        }

        telegramBotLink.href = data.link;
        telegramBotText.textContent = `Open @${data.username}, press Start, then paste a video link there (max ${data.maxUploadMb} MB).`;
        telegramBotCard.style.display = 'flex';
    } catch {
        telegramBotCard.style.display = 'none';
    }
}

// ── EVENT LISTENERS ──────────────────────────────────────────────────────
function setupEventListeners() {
    urlInput.addEventListener('input', () => {
        detectPlatform(urlInput.value);
        hideError();
        clearBtn.style.display = urlInput.value ? 'flex' : 'none';
    });

    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') fetchVideoInfo();
    });

    pasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            urlInput.value = text;
            detectPlatform(text);
            hideError();
            clearBtn.style.display = text ? 'flex' : 'none';
            pasteBtn.style.color = 'var(--accent-green)';
            setTimeout(() => { pasteBtn.style.color = ''; }, 600);
        } catch {
            urlInput.focus();
        }
    });

    clearBtn.addEventListener('click', clearInput);
    fetchBtn.addEventListener('click', fetchVideoInfo);
    downloadBtn.addEventListener('click', downloadVideo);

    historyClearBtn.addEventListener('click', () => {
        localStorage.removeItem(HISTORY_KEY);
        renderHistory();
    });

    // Platform chips → open the site in a new tab
    const PLATFORM_URLS = {
        youtube:     'https://www.youtube.com',
        facebook:    'https://www.facebook.com',
        tiktok:      'https://www.tiktok.com',
        javguru:     'https://jav.guru',
        javeng:      'https://javeng.tv',
        javgg:       'https://javgg.net',
        missav:      'https://missav.com/en',
        pornhub:     'https://www.pornhub.com',
        xvideos:     'https://www.xvideos.com',
        spankbang:   'https://www.spankbang.com',
        redtube:     'https://www.redtube.com',
        eporner:     'https://www.eporner.com',
        xhamster:    'https://xhamster.com',
        xnxx:        'https://www.xnxx.com',
        youporn:     'https://www.youporn.com',
        tube8:       'https://www.tube8.com',
        bilibili:    'https://www.bilibili.com',
        rumble:      'https://rumble.com',
        niconico:    'https://www.nicovideo.jp',
        odysee:      'https://odysee.com',
        kick:        'https://kick.com',
        bitchute:    'https://www.bitchute.com',
        pinterest:   'https://www.pinterest.com',
        telegram:    'https://web.telegram.org',
        instagram:   'https://www.instagram.com',
        twitter:     'https://x.com',
        reddit:      'https://www.reddit.com',
        vimeo:       'https://vimeo.com',
        twitch:      'https://www.twitch.tv',
        dailymotion: 'https://www.dailymotion.com',
        linkedin:    'https://www.linkedin.com',
        streamable:  'https://streamable.com',
        redgifs:     'https://www.redgifs.com',
        vk:          'https://vk.com',
        coub:        'https://coub.com',
        loom:        'https://www.loom.com',
        soundcloud:  'https://soundcloud.com',
    };

    document.querySelectorAll('.platform-chip[data-platform]').forEach(chip => {
        const url = PLATFORM_URLS[chip.dataset.platform];
        if (!url) return;
        chip.style.cursor = 'pointer';
        chip.title = `Open ${chip.dataset.platform}`;
        chip.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    });
}

// ── CLEAR INPUT ──────────────────────────────────────────────────────────
function clearInput() {
    urlInput.value = '';
    clearBtn.style.display = 'none';
    detectedPlatform.style.display = 'none';
    document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('active'));
    videoCard.style.display = 'none';
    hideError();
    currentVideoUrl = '';
    currentVideoInfo = null;
    urlInput.focus();
}

// ── PLATFORM DETECTION ───────────────────────────────────────────────────
function detectPlatform(url) {
    const platforms = {
        youtube:     { patterns: [/youtube\.com/, /youtu\.be/, /youtube-nocookie\.com/], icon: '🔴', name: 'YouTube',     color: 'youtube' },
        facebook:    { patterns: [/facebook\.com/, /fb\.watch/, /fb\.com/],             icon: '🔵', name: 'Facebook',    color: 'facebook' },
        tiktok:      { patterns: [/tiktok\.com/, /vm\.tiktok\.com/],                    icon: '⚫', name: 'TikTok',      color: 'tiktok' },
        javguru:     { patterns: [/jav\.guru/],                                          icon: 'J',  name: 'JAV Guru',   color: 'jav' },
        javeng:      { patterns: [/javeng\.tv/, /javeng\.com/],                          icon: 'J',  name: 'JAV Eng',    color: 'jav' },
        javgg:       { patterns: [/javgg\.net/],                                         icon: 'J',  name: 'JAVGG',      color: 'jav' },
        missav:      { patterns: [/missav\./],                                           icon: 'M',  name: 'MissAV',     color: 'missav' },
        pornhub:     { patterns: [/pornhub\.com/],                                       icon: 'P',  name: 'Pornhub',    color: 'pornhub' },
        xvideos:     { patterns: [/xvideos\.com/, /xvideos2\.com/],                     icon: 'X',  name: 'XVideos',    color: 'xvideos' },
        spankbang:   { patterns: [/spankbang\.com/, /spankbang\.party/],                icon: 'S',  name: 'SpankBang',  color: 'spankbang' },
        redtube:     { patterns: [/redtube\.com/],                                       icon: 'R',  name: 'RedTube',    color: 'redtube' },
        eporner:     { patterns: [/eporner\.com/],                                       icon: 'E',  name: 'Eporner',    color: 'eporner' },
        xhamster:    { patterns: [/xhamster\.com/, /xhamster\.desi/],                   icon: 'X',  name: 'xHamster',   color: 'xhamster' },
        xnxx:        { patterns: [/xnxx\.com/],                                          icon: 'X',  name: 'XNXX',       color: 'xnxx' },
        youporn:     { patterns: [/youporn\.com/],                                       icon: 'Y',  name: 'YouPorn',    color: 'youporn' },
        tube8:       { patterns: [/tube8\.com/],                                         icon: 'T',  name: 'Tube8',      color: 'tube8' },
        bilibili:    { patterns: [/bilibili\.com/, /b23\.tv/],                           icon: 'B',  name: 'Bilibili',   color: 'bilibili' },
        rumble:      { patterns: [/rumble\.com/],                                        icon: 'R',  name: 'Rumble',     color: 'rumble' },
        niconico:    { patterns: [/nicovideo\.jp/, /nico\.ms/],                          icon: 'N',  name: 'Niconico',   color: 'niconico' },
        odysee:      { patterns: [/odysee\.com/, /lbry\.tv/],                            icon: 'O',  name: 'Odysee',     color: 'odysee' },
        kick:        { patterns: [/kick\.com/],                                          icon: 'K',  name: 'Kick',       color: 'kick' },
        bitchute:    { patterns: [/bitchute\.com/],                                      icon: 'B',  name: 'BitChute',   color: 'bitchute' },
        pinterest:   { patterns: [/pinterest\.com/, /pin\.it/, /pinterest\.\w{2,3}/],   icon: '📌', name: 'Pinterest',  color: 'pinterest' },
        telegram:    { patterns: [/t\.me/, /telegram\.me/, /telegram\.org/],            icon: '✈️', name: 'Telegram',   color: 'telegram' },
        instagram:   { patterns: [/instagram\.com/, /instagr\.am/],                     icon: '📷', name: 'Instagram',  color: 'instagram' },
        twitter:     { patterns: [/twitter\.com/, /x\.com/, /t\.co/],                   icon: '🐦', name: 'X / Twitter',color: 'twitter' },
        reddit:      { patterns: [/reddit\.com/, /redd\.it/, /v\.redd\.it/],            icon: '🤖', name: 'Reddit',     color: 'reddit' },
        vimeo:       { patterns: [/vimeo\.com/],                                         icon: '🎬', name: 'Vimeo',      color: 'vimeo' },
        twitch:      { patterns: [/twitch\.tv/, /clips\.twitch\.tv/],                   icon: '🎮', name: 'Twitch',     color: 'twitch' },
        dailymotion: { patterns: [/dailymotion\.com/, /dai\.ly/],                       icon: '▶️', name: 'Dailymotion',color: 'dailymotion' },
        linkedin:    { patterns: [/linkedin\.com/],                                      icon: '💼', name: 'LinkedIn',   color: 'linkedin' },
        streamable:  { patterns: [/streamable\.com/],                                    icon: 'S',  name: 'Streamable', color: 'streamable' },
        redgifs:     { patterns: [/redgifs\.com/, /gfycat\.com/],                        icon: 'R',  name: 'Redgifs',    color: 'redgifs' },
        vk:          { patterns: [/vk\.com/, /vkontakte\.ru/],                           icon: 'V',  name: 'VK',         color: 'vk' },
        coub:        { patterns: [/coub\.com/],                                          icon: 'C',  name: 'Coub',       color: 'coub' },
        loom:        { patterns: [/loom\.com/],                                          icon: 'L',  name: 'Loom',       color: 'loom' },
        soundcloud:  { patterns: [/soundcloud\.com/, /snd\.sc/],                        icon: '🔊', name: 'SoundCloud', color: 'soundcloud' },
    };

    document.querySelectorAll('.platform-chip').forEach(chip => chip.classList.remove('active'));

    for (const [key, platform] of Object.entries(platforms)) {
        if (platform.patterns.some(p => p.test(url))) {
            detectedPlatform.style.display = 'flex';
            platformIcon.textContent = platform.icon;
            platformName.textContent = platform.name;
            const chip = document.querySelector(`.platform-chip[data-platform="${key}"]`);
            if (chip) chip.classList.add('active');
            return key;
        }
    }

    detectedPlatform.style.display = 'none';
    return null;
}

// ── FETCH VIDEO INFO ─────────────────────────────────────────────────────
async function fetchVideoInfo() {
    const url = urlInput.value.trim();

    if (!url) { showError('Please paste a video URL first.'); return; }
    if (!isValidUrl(url)) { showError('Please enter a valid URL.'); return; }

    // Cancel any in-flight request
    if (fetchAbortController) fetchAbortController.abort();
    fetchAbortController = new AbortController();
    const signal = fetchAbortController.signal;
    const timeout = setTimeout(() => fetchAbortController.abort(), 60000);

    setLoading(true);
    hideError();
    videoCard.style.display = 'none';

    try {
        const res = await fetch('/api/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
            signal,
        });

        const contentType = res.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await res.json() : { error: await res.text() };

        if (!res.ok) throw new Error(getApiErrorMessage(data, 'Failed to fetch video info'));

        currentVideoUrl = url;
        currentVideoInfo = data;
        displayVideoInfo(data);
    } catch (err) {
        if (err.name === 'AbortError') {
            showError('Request timed out. The site may be slow or the video may be unavailable.');
        } else {
            showError(err.message);
        }
    } finally {
        clearTimeout(timeout);
        setLoading(false);
    }
}

// ── DISPLAY VIDEO INFO ──────────────────────────────────────────────────
function displayVideoInfo(info) {
    if (info.thumbnail) {
        videoThumbnail.src = info.thumbnail;
        videoThumbnail.alt = info.title;
        videoThumbnail.onerror = () => {
            videoThumbnail.src = '';
            videoThumbnail.alt = 'No thumbnail available';
        };
    } else {
        videoThumbnail.src = '';
        videoThumbnail.alt = 'No thumbnail available';
    }

    videoTitle.textContent = info.title;

    if (info.duration) {
        videoDuration.textContent = formatDuration(info.duration);
        videoDuration.style.display = 'block';
    } else {
        videoDuration.style.display = 'none';
    }

    // Platform badge
    const platform = (info.platform || '').toLowerCase();
    videoPlatformBadge.textContent = info.platform;
    videoPlatformBadge.className = 'video-platform-badge';
    const badgeClass = platformToClass(platform);
    if (badgeClass) videoPlatformBadge.classList.add(badgeClass);

    videoUploader.textContent = `👤 ${info.uploader}`;

    if (info.viewCount) {
        videoViews.textContent = `👁 ${formatNumber(info.viewCount)} views`;
        videoViews.style.display = 'flex';
    } else {
        videoViews.style.display = 'none';
    }

    // Quality options — only insert the ⭐ shortcut when multiple formats
    // exist; single-format sites (javgg, missav, browser) already return
    // formatId='best' so we'd otherwise get two identical options.
    qualitySelect.innerHTML = '';
    info.formats.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.formatId;
        let label = f.quality;
        if (f.filesize) label += ` (${formatFileSize(f.filesize)})`;
        if (f.ext) label += ` — ${f.ext.toUpperCase()}`;
        opt.textContent = label;
        qualitySelect.appendChild(opt);
    });

    if (info.formats.length > 1) {
        const bestOpt = document.createElement('option');
        bestOpt.value = 'best';
        bestOpt.textContent = '⭐ Best Quality (Recommended)';
        qualitySelect.insertBefore(bestOpt, qualitySelect.firstChild);
    }
    qualitySelect.value = 'best';

    videoCard.style.display = 'block';
    setTimeout(() => videoCard.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
}

// ── PLATFORM → CSS CLASS ─────────────────────────────────────────────────
function platformToClass(p) {
    if (p.includes('youtube'))                   return 'youtube';
    if (p.includes('facebook'))                  return 'facebook';
    if (p.includes('tiktok'))                    return 'tiktok';
    if (p.includes('pinterest'))                 return 'pinterest';
    if (p.includes('telegram'))                  return 'telegram';
    if (p.includes('instagram'))                 return 'instagram';
    if (p.includes('twitter') || p.includes('x.com')) return 'twitter';
    if (p.includes('reddit'))                    return 'reddit';
    if (p.includes('vimeo'))                     return 'vimeo';
    if (p.includes('twitch'))                    return 'twitch';
    if (p.includes('dailymotion'))               return 'dailymotion';
    if (p.includes('linkedin'))                  return 'linkedin';
    if (p.includes('pornhub'))                   return 'pornhub';
    if (p.includes('xvideo'))                    return 'xvideos';
    if (p.includes('spankbang'))                 return 'spankbang';
    if (p.includes('redtube'))                   return 'redtube';
    if (p.includes('eporner'))                   return 'eporner';
    if (p.includes('xhamster'))                  return 'xhamster';
    if (p.includes('xnxx'))                      return 'xnxx';
    if (p.includes('youporn'))                   return 'youporn';
    if (p.includes('tube8'))                     return 'tube8';
    if (p.includes('bilibili'))                  return 'bilibili';
    if (p.includes('rumble'))                    return 'rumble';
    if (p.includes('nicovideo') || p.includes('niconico')) return 'niconico';
    if (p.includes('odysee') || p.includes('lbry'))        return 'odysee';
    if (p.includes('kick'))                      return 'kick';
    if (p.includes('bitchute'))                  return 'bitchute';
    if (p.includes('streamable'))               return 'streamable';
    if (p.includes('redgifs') || p.includes('gfycat')) return 'redgifs';
    if (p === 'vk' || p.includes('vkontakte')) return 'vk';
    if (p.includes('coub'))                     return 'coub';
    if (p.includes('loom'))                     return 'loom';
    if (p.includes('soundcloud'))               return 'soundcloud';
    if (p.includes('jav') || p.includes('guru')) return 'jav';
    if (p.includes('missav'))                    return 'missav';
    return '';
}

// ── DOWNLOAD VIDEO ───────────────────────────────────────────────────────
async function downloadVideo() {
    if (!currentVideoUrl) return;

    const selectedFormat = qualitySelect.value;
    const params = new URLSearchParams({
        url: currentVideoUrl,
        format: selectedFormat,
        fast: prefersFastDownload() ? '1' : '0'
    });
    const downloadUrl = `/api/download?${params}`;
    downloadBtn.disabled = true;
    downloadProgress.style.display = 'block';
    progressBarFill.style.width = '0%';
    setProgressPhase('processing');

    if (currentVideoInfo) {
        saveToHistory({
            url: currentVideoUrl,
            title: currentVideoInfo.title,
            thumbnail: currentVideoInfo.thumbnail,
            platform: currentVideoInfo.platform,
            uploader: currentVideoInfo.uploader,
            duration: currentVideoInfo.duration,
            downloadedAt: Date.now()
        });
    }

    if (usesNativeDownload()) {
        progressBarFill.style.width = '100%';
        setProgressPhase('transferring');
        window.location.href = downloadUrl;
        setTimeout(() => {
            downloadProgress.style.display = 'none';
            progressBarFill.style.width = '0%';
            downloadBtn.disabled = false;
        }, 1200);
        return;
    }

    downloadAbortController = new AbortController();
    const fakeInterval = simulateProgress();

    try {
        const response = await fetch(downloadUrl, {
            signal: downloadAbortController.signal
        });

        clearInterval(fakeInterval);

        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || contentType.includes('application/json')) {
            const errData = await response.json().catch(() => ({ error: `Server error ${response.status}` }));
            throw new Error(getApiErrorMessage(errData, 'Download failed'));
        }

        // Parse filename from Content-Disposition
        const cd = response.headers.get('content-disposition') || '';
        const fnMatch = cd.match(/filename[^;=\n]*=\s*(?:UTF-8'')?["']?([^"';\r\n]+)/i);
        const filename = fnMatch ? decodeURIComponent(fnMatch[1].trim().replace(/["']$/, '')) : 'video.mp4';

        // Switch UI to transfer phase and stream chunks with real progress (85→99%)
        setProgressPhase('transferring');
        const total = parseInt(response.headers.get('content-length') || '0', 10);
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;

        progressBarFill.style.width = '85%';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (total > 0) {
                progressBarFill.style.width = `${85 + (received / total) * 14}%`;
            }
        }

        const blob = new Blob(chunks, { type: contentType || 'video/mp4' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);

        progressBarFill.style.width = '100%';
        setTimeout(() => {
            downloadProgress.style.display = 'none';
            progressBarFill.style.width = '0%';
        }, 800);

    } catch (err) {
        clearInterval(fakeInterval);
        downloadProgress.style.display = 'none';
        if (err.name !== 'AbortError') showError(err.message);
    } finally {
        downloadBtn.disabled = false;
        downloadAbortController = null;
    }
}

function prefersFastDownload() {
    const platform = (currentVideoInfo?.platform || '').toLowerCase();
    return usesNativeDownload() || platform.includes('youtube') || platform.includes('facebook');
}

function usesNativeDownload() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// ── CANCEL DOWNLOAD ──────────────────────────────────────────────────────
function cancelDownload() {
    if (downloadAbortController) {
        downloadAbortController.abort();
        downloadAbortController = null;
    }
    downloadProgress.style.display = 'none';
    progressBarFill.style.width = '0%';
    downloadBtn.disabled = false;
}

// ── PROGRESS PHASE TEXT ──────────────────────────────────────────────────
function setProgressPhase(phase) {
    const h3 = document.querySelector('.progress-text h3');
    const p  = document.querySelector('.progress-text p');
    if (phase === 'processing') {
        h3.textContent = 'Processing…';
        p.textContent  = 'Fetching and encoding the video. This may take a minute.';
    } else {
        h3.textContent = 'Transferring…';
        p.textContent  = 'Streaming video to your device.';
    }
}

// ── PROGRESS SIMULATION ─────────────────────────────────────────────────
function simulateProgress() {
    let progress = 0;
    return setInterval(() => {
        if (progress < 85) {
            progress += Math.random() * 8;
            if (progress > 85) progress = 85;
            progressBarFill.style.width = `${progress}%`;
        }
    }, 500);
}

// ── HELPERS ──────────────────────────────────────────────────────────────
function isValidUrl(str) {
    try { new URL(str); return true; } catch { return false; }
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatNumber(num) {
    if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
    return num.toString();
}

function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + ' GB';
    if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
}

function getApiErrorMessage(data, fallback) {
    if (data?.code === YOUTUBE_COOKIES_REQUIRED_CODE) {
        return data.error || data.message || YOUTUBE_COOKIES_REQUIRED_MESSAGE;
    }
    return data?.error || data?.message || fallback;
}

function setLoading(loading) {
    fetchBtn.disabled = loading;
    if (loading) {
        fetchBtnText.style.display = 'none';
        fetchBtnLoader.style.display = 'flex';
    } else {
        fetchBtnText.style.display = 'inline';
        fetchBtnLoader.style.display = 'none';
    }
}

function showError(message) {
    errorText.textContent = message;
    errorMessage.style.display = 'flex';
}

function hideError() {
    errorMessage.style.display = 'none';
}

// ── DOWNLOAD HISTORY ─────────────────────────────────────────────────────
function saveToHistory(item) {
    const history = getHistory();
    const filtered = history.filter(h => h.url !== item.url);
    filtered.unshift(item);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(filtered.slice(0, MAX_HISTORY)));
    renderHistory();
}

function getHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
    catch { return []; }
}

function renderHistory() {
    const history = getHistory();
    if (history.length === 0) { historySection.style.display = 'none'; return; }

    historySection.style.display = 'block';
    historyList.innerHTML = '';

    history.forEach(item => {
        const platformClass = platformToClass((item.platform || '').toLowerCase());
        const timeAgo = formatTimeAgo(item.downloadedAt);

        const card = document.createElement('div');
        card.className = 'history-item';
        card.innerHTML = `
            <div class="history-thumb">
                ${item.thumbnail
                    ? `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy">`
                    : `<div class="history-thumb-placeholder"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></div>`}
                ${item.duration ? `<span class="history-duration">${formatDuration(item.duration)}</span>` : ''}
            </div>
            <div class="history-info">
                <p class="history-item-title">${escapeHtml(item.title)}</p>
                <div class="history-meta">
                    ${platformClass ? `<span class="history-badge ${platformClass}">${escapeHtml(item.platform)}</span>` : ''}
                    <span class="history-time">${timeAgo}</span>
                </div>
            </div>
            <button class="history-dl-btn" title="Download again" data-url="${escapeHtml(item.url)}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
            </button>
        `;

        card.querySelector('.history-dl-btn').addEventListener('click', () => {
            urlInput.value = item.url;
            clearBtn.style.display = 'flex';
            detectPlatform(item.url);
            hideError();
            fetchVideoInfo();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        historyList.appendChild(card);
    });
}

function formatTimeAgo(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(diff / 86400000);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    if (m > 0) return `${m}m ago`;
    return 'Just now';
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
