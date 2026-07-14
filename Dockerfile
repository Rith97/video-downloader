FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates ffmpeg wget git \
    && apt-get install -y chromium \
    && pip3 install --no-cache-dir --break-system-packages -U curl_cffi \
    && apt-get purge -y python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp as the standalone release binary (not pip) so the server's
# built-in self-updater (`yt-dlp -U`) can keep extractors current without
# rebuilding the image.
RUN wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# YouTube increasingly requires a per-video Proof-of-Origin token on
# datacenter IPs. Install the maintained bgutil provider and its yt-dlp plugin.
ARG BGUTIL_VERSION=1.3.1
RUN git clone --depth 1 --branch ${BGUTIL_VERSION} \
        https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider \
    && cd /opt/bgutil-ytdlp-pot-provider/server \
    && npm ci \
    && npx tsc \
    && mkdir -p /root/.config/yt-dlp/plugins \
    && wget -q https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_VERSION}/bgutil-ytdlp-pot-provider.zip \
        -O /root/.config/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p downloads

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
