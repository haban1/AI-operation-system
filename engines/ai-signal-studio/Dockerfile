FROM node:24.15.0-bookworm-slim

RUN apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
       python3 python3-venv ffmpeg curl chromium \
       ca-certificates fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-voice.txt ./
RUN python3 -m venv .venv-voice \
    && .venv-voice/bin/pip install --no-cache-dir -r requirements-voice.txt

COPY video/package.json video/package-lock.json ./video/
RUN cd video && npm ci --no-audit --no-fund && npm cache clean --force

COPY app.py config.example.json ./
COPY scripts ./scripts
COPY web ./web
COPY video/src ./video/src
COPY video/tsconfig.json ./video/tsconfig.json
RUN cd video && npm run check
RUN mkdir -p runs data runtime-config video/public/runs

ENV PYTHONUNBUFFERED=1 \
    SIGNAL_HOST=0.0.0.0 \
    SIGNAL_CONFIG_DIR=/app/runtime-config \
    REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium

EXPOSE 8892
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8892/api/health', timeout=4)"
CMD ["python3", "app.py"]
