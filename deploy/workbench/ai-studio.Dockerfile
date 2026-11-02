FROM node:24.15.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk espeak-ng \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json core.js render.js server.js ./
COPY test ./test
RUN mkdir -p /data && chown -R node:node /app /data
ENV NODE_ENV=production STUDIO_DATA_DIR=/data PORT=8892
USER node
EXPOSE 8892
CMD ["node", "server.js"]
