#!/bin/sh
set -eu
cd "$(dirname "$0")"
if /usr/bin/curl --silent --fail --max-time 2 http://127.0.0.1:8890/api/status >/dev/null 2>&1; then
  printf '%s\n' '视频创作工作台已运行：http://127.0.0.1:8890/'
  exit 0
fi
printf '%s\n' '视频创作工作台：http://127.0.0.1:8890/（保持此终端打开）'
exec node server.mjs
