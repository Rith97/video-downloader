FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && apt-get install -y chromium \
    && pip3 install --no-cache-dir --break-system-packages -U yt-dlp curl_cffi \
    && apt-get purge -y python3-pip \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p downloads

EXPOSE 3000

CMD ["node", "server.js"]
