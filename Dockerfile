FROM node:24.15.0-bookworm-slim

WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY agent ./agent
COPY public ./public
COPY scripts ./scripts
COPY platform-workflows ./platform-workflows
RUN mkdir -p data logs
EXPOSE 3100
CMD ["sh", "-c", "node scripts/docker-dev-entry.mjs && exec node src/server.js"]
