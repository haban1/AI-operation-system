# Vendored web-access notice

This directory contains the CDP proxy runtime adapted from:

- Project: web-access
- Upstream: https://github.com/eze-is/web-access
- Version integrated: 2.5.3
- Author: 一泽 Eze / eze-is contributors
- License: MIT

Only the runtime files required by the Local Agent are vendored here. The
project-level `.agents/skills/web-access` copy remains a Codex development
Skill and is not a production runtime dependency.

Local integration wraps the proxy behind a structured command policy. Cloud
requests cannot call the upstream `/eval` endpoint directly, read cookies, or
export browser storage.
