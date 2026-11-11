# Add the browser required by the already-deployed MCP service.
FROM registry.cn-shenzhen.aliyuncs.com/houhou/xiaohongshu-mcp:latest
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --location --retry 2 --connect-timeout 20 --max-time 180 \
       https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && google-chrome --version \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*
ENV ROD_BROWSER_BIN=/usr/bin/google-chrome
