FROM node:24.15.0-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
# Same Bun version as the upstream Dockerfile; npm avoids a second base-image pull.
RUN npm install --prefix /opt/bun @oven/bun-linux-x64@1.3.14 \
    && ln -s /opt/bun/node_modules/@oven/bun-linux-x64/bin/bun /usr/local/bin/bun \
    && bun --version
COPY . .
RUN bun install --frozen-lockfile && bun run build:server \
    && mkdir -p /app/data/workspaces/myProject && chown -R node:node /app/data
ENV NODE_ENV=production TOONFLOW_DATA_DIR=/app/data
USER node
LABEL org.opencontainers.image.source="https://github.com/HBAI-Ltd/Toonflow-app" \
      org.opencontainers.image.revision="30139c931e80476caa718b31684b86383c6e83ce"
EXPOSE 3000
CMD ["bun", "build/server/index.js"]
