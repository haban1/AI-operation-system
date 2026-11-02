FROM node:24.15.0-bookworm-slim AS whisper-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Build on the same distribution as the app; release binaries may require a
# newer glibc. Pin and verify the source archive for repeatable deployments.
RUN curl -fL --retry 3 https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.9.2 -o /tmp/whisper.tar.gz \
    && echo 'a6abd064fcca8b85e794d205abf328c522e9451db43a3eadc178b883b7d0e9cd  /tmp/whisper.tar.gz' | sha256sum -c - \
    && mkdir /whisper && tar -xzf /tmp/whisper.tar.gz -C /whisper --strip-components=1 \
    && cmake -S /whisper -B /whisper/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF \
    && cmake --build /whisper/build --target whisper-cli -j 4

FROM node:24.15.0-bookworm-slim

# ffprobe-static does not ship a Linux ARM64 executable. Use the distribution
# build to validate shared-library media on Apple Silicon Docker as well.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg chromium libgomp1 fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
COPY --from=whisper-build /whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli

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
