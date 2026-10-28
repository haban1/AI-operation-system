FROM node:24.15.0-bookworm-slim

# ffprobe-static does not ship a Linux ARM64 executable. Use the distribution
# build to validate shared-library media on Apple Silicon Docker as well.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY engines/video-studio/package.json engines/video-studio/package-lock.json ./engines/video-studio/
COPY engines/video-studio/runtime/package.json engines/video-studio/runtime/package-lock.json ./engines/video-studio/runtime/
ENV HYPERFRAMES_SKIP_SKILLS=1 \
    HYPERFRAMES_NO_TELEMETRY=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium \
    CHROME_EXECUTABLE_PATH=/usr/bin/chromium \
    CODEX_BIN=/app/engines/video-studio/node_modules/.bin/codex \
    VIDEO_STUDIO_DATA_DIR=/app/data/video-studio
ENV PATH="/app/engines/video-studio/node_modules/.bin:${PATH}"
RUN npm ci --prefix engines/video-studio --no-audit --no-fund \
    && npm ci --prefix engines/video-studio/runtime --no-audit --no-fund
COPY src ./src
COPY agent ./agent
COPY public ./public
COPY scripts ./scripts
COPY platform-workflows ./platform-workflows
COPY engines/video-studio ./engines/video-studio
COPY bundled/content-library ./bundled/content-library
RUN node scripts/verify-bundled-media.mjs
RUN mkdir -p data/video-studio logs \
    && chmod 700 data/video-studio
EXPOSE 3100
CMD ["sh", "-c", "node scripts/docker-dev-entry.mjs && exec node src/server.js"]
