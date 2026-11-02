FROM node:24.15.0-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg nginx fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL=skip \
    OPENCHATCUT_FFMPEG=/usr/bin/ffmpeg OPENCHATCUT_FFPROBE=/usr/bin/ffprobe
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
COPY --from=workbench /openchatcut.mts /app/deploy/openchatcut.mts
COPY --from=workbench /openchatcut.nginx.conf /app/deploy/nginx.conf
ARG NODE_USE_ENV_PROXY=1
RUN npm run build && mkdir -p /data/media/uploads /data/home \
    && ln -s /data/settings.env /app/.env.local && chown -R node:node /data
ENV NODE_ENV=production OPENCHATCUT_DATA_DIR=/data \
    OPENCHATCUT_DEV_PROFILE_ID=43c882d0-9c14-49b8-bcb6-9e0ba2a63071 \
    OPENCHATCUT_EDITOR_URL=http://127.0.0.1:5199
COPY --from=workbench /patch-openchatcut.mjs /app/deploy/patch-openchatcut.mjs
COPY --from=workbench /openchatcut-proxy.verify.mts /app/deploy/openchatcut-proxy.verify.mts
RUN node /app/deploy/patch-openchatcut.mjs \
    && node --import tsx /app/deploy/openchatcut-proxy.verify.mts \
    && node --import tsx /app/server/llm-proxy.verify.ts
# Provision rendering and model downloads during the build. Runtime stays node.
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends chromium curl fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/node_modules/.remotion /app/node_modules/.cache \
    && chown -R node:node /app/node_modules/.remotion /app/node_modules/.cache
ENV CC_BROWSER_EXECUTABLE=/usr/bin/chromium CC_RENDER_GL=swangle
COPY --from=workbench /openchatcut-transcription-settings.ts /app/src/transcript/server-preferences.ts
COPY --from=workbench /patch-openchatcut-transcription.mjs /app/deploy/patch-openchatcut-transcription.mjs
COPY --from=workbench /openchatcut-transcription-settings.verify.mts /app/deploy/openchatcut-transcription-settings.verify.mts
RUN node /app/deploy/patch-openchatcut-transcription.mjs \
    && node --import tsx /app/deploy/openchatcut-transcription-settings.verify.mts \
    && npm run build
USER node
LABEL org.opencontainers.image.source="https://github.com/0xsline/OpenChatCut" \
      org.opencontainers.image.revision="7fa4b7903e7ebecf832a36249f0c0c755200cc17"
EXPOSE 5200
CMD ["sh", "-c", "nginx -c /app/deploy/nginx.conf && exec node --import tsx /app/deploy/openchatcut.mts"]
