#!/usr/bin/env bash
# weixin_robot 部署健康检查脚本
#
# 用法（在 E 盘项目根目录执行）:
#   bash scripts/deploy-check.sh
#
# 检查项：
#   1. FastAPI /health
#   2. FastAPI 首页（前端）
#   3. FastAPI Swagger /docs
#   4. 微信机器人管理后台（127.0.0.1:8080）
#   5. admin 账号登录
#   6. 微信客户端登录态（自动发现 client_xxx 容器）
#   7. FastAPI -> 客户端好友列表
#   8. 人工接管通知人（handoff-notifier）配置
#   9. Chat 端到端（gpt-5.5 / qwen-plus）
#  10. wechat-robot 网络容器数
#
# 依赖：bash + curl + docker + python（Git Bash 自带）

set -u

API="http://127.0.0.1:8000"
ADMIN_BACKEND="http://127.0.0.1:8080"
ADMIN_USER="admin"
ADMIN_PASS="admin123"

pass=0
fail=0
items=()

ok()  { items+=("PASS  $1"); pass=$((pass+1)); }
ng()  { items+=("FAIL  $1 -- $2"); fail=$((fail+1)); }

# 1. API /health
h=$(curl -s --max-time 8 "$API/health" 2>/dev/null)
if echo "$h" | grep -q '"status":"ok"'; then
  ok "API /health"
else
  ng "API /health" "未返回 ok 状态（$h）"
fi

# 2. API 首页
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$API/" 2>/dev/null)
if [ "$code" = "200" ]; then
  ok "API 首页（前端）"
else
  ng "API 首页" "HTTP $code"
fi

# 3. API Swagger
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$API/docs" 2>/dev/null)
if [ "$code" = "200" ]; then
  ok "API /docs (Swagger)"
else
  ng "API /docs" "HTTP $code"
fi

# 4. 微信机器人后台
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$ADMIN_BACKEND/" 2>/dev/null)
if [ "$code" = "200" ]; then
  ok "微信机器人后台 8080"
else
  ng "微信机器人后台 8080" "HTTP $code"
fi

# 5. admin 登录拿 token
login=$(curl -s --max-time 15 -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" 2>/dev/null)
token=$(echo "$login" | python -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
if [ -n "$token" ]; then
  ok "admin 账号登录"
else
  ng "admin 登录" "无法获取 token（$login）"
fi

# 6. 自动发现 client 容器
client_name=$(docker ps --filter "name=client_" --format "{{.Names}}" 2>/dev/null | head -1)
if [ -n "$client_name" ]; then
  ok "微信客户端容器运行中（$client_name）"
else
  ng "微信客户端容器" "未发现 client_xxx 容器运行"
fi

# 7. 好友列表（同时验证 client 登录态 + API->client 链路）
if [ -n "$token" ] && [ -n "$client_name" ]; then
  friends=$(curl -s --max-time 30 "$API/wechat-robot/friends" \
    -H "Authorization: Bearer $token" 2>/dev/null)
  count=$(echo "$friends" | python -c "import sys,json; print(json.load(sys.stdin).get('count','?'))" 2>/dev/null)
  if [ -n "$count" ] && [ "$count" != "?" ] && [ "$count" -gt 0 ] 2>/dev/null; then
    ok "客户端登录态 + 好友列表（$count 人）"
  else
    ng "客户端登录态 + 好友列表" "好友数=$count，登录态可能掉了，需重新扫码。原始响应：$friends"
  fi
fi

# 8. 人工接管通知人
if [ -n "$token" ]; then
  hn=$(curl -s --max-time 15 "$API/wechat-robot/handoff-notifier" \
    -H "Authorization: Bearer $token" 2>/dev/null)
  enabled=$(echo "$hn" | python -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('enabled') else '0')" 2>/dev/null)
  name=$(echo "$hn" | python -c "import sys,json; print(json.load(sys.stdin).get('name',''))" 2>/dev/null)
  if [ "$enabled" = "1" ]; then
    ok "人工接管通知人（$name）"
  else
    ng "人工接管通知人" "未配置，需在后台或 PUT /wechat-robot/handoff-notifier 设置"
  fi
fi

# 9. Chat 端到端（用「你好」测，能命中 FAQ 且触发 LLM rewrite）
if [ -n "$token" ]; then
  chat=$(curl -s --max-time 60 -X POST "$API/chat" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d '{"message":"你好","session_id":"deploy-check"}' 2>/dev/null)
  llm=$(echo "$chat" | python -c "import sys,json; print(json.load(sys.stdin).get('llm_used',''))" 2>/dev/null)
  answer=$(echo "$chat" | python -c "import sys,json; print(json.load(sys.stdin).get('answer',''))" 2>/dev/null)
  if [ "$llm" = "True" ] && [ -n "$answer" ]; then
    ok "Chat 端到端（llm_used=true, answer 非空）"
  else
    ng "Chat 端到端" "llm_used=$llm, answer='$answer'，请检查 .env 里 DASHSCOPE_API_KEY / DASHSCOPE_CHAT_MODEL / DASHSCOPE_BASE_URL"
  fi
fi

# 10. 容器数
n=$(docker ps --filter "network=wechat-robot" --format "{{.Names}}" 2>/dev/null | wc -l)
ok "wechat-robot 网络容器：$n 个运行中"

# 输出
echo ""
echo "================== 健康检查报告 =================="
for line in "${items[@]}"; do echo "$line"; done
echo "--------------------------------------------------"
echo "汇总：$pass 通过 / $fail 失败 / $((pass+fail)) 总计"
[ $fail -eq 0 ] && echo "状态：全部正常 ✅" || echo "状态：有 $fail 项异常 ❌"
exit $fail
