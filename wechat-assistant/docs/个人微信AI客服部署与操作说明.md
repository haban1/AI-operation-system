# 个人微信 AI 客服部署与操作说明

更新时间：2026-09-16

> 当前版本已改为文档知识库：管理员登录后在“文档知识库”上传 PDF、Word（.docx）、TXT 或 Markdown，等待解析完成，再到“检索测试”检查原文命中。单文件默认 20 MB；扫描 PDF 需先 OCR，旧版 `.doc` 需另存为 `.docx`。模型按需检索文档并引用来源，不再维护课程、意图和 FAQ 条目。下文涉及旧条目维护、FAQ 导入与事实图片回复的说明仅适用于历史版本；当前操作以根目录 README 的 Document Knowledge 与 Core Flow 为准。原有条目数据保留，但不再用于默认问答。

本文面向 Windows 新电脑，从源码开始部署以下两部分：

- FastAPI 智能客服、知识库和管理后台。
- `wechat-robot-client` 微信机器人管理后台与机器人实例。

本文默认两部分部署在同一台电脑的 Docker Desktop 中，并使用同一个
`wechat-robot` Docker 网络互相访问。

## 1. 重要说明

### 1.1 源码和运行数据是分开的

Git 仓库只包含源码和配置模板，不包含：

- 根目录和微信机器人目录中的真实 `.env`。
- FastAPI PostgreSQL 数据。
- 微信机器人 MySQL、Redis 和 Qdrant 数据。
- 微信登录状态、聊天记录和机器人实例运行目录。
- HTTPS 私钥和本地证书。

因此，在新电脑只克隆源码后：

- 需要重新填写两个 `.env`。
- 需要重新创建机器人并登录微信。
- 原知识库和历史会话不会自动出现。
- 使用新微信登录不需要修改源码，但要更新机器人客户端地址。

如需迁移原知识库或保留原微信登录状态，需要单独备份数据库和运行数据，不属于“只迁移
源码”的范围。

### 1.2 账号和合规风险

个人微信机器人依赖非官方接入方式，存在登录失败、版本限制、异地登录和账号风控风险。
建议使用专门的客服微信测试，不要直接使用重要私人账号。

群发功能只应用于已经同意接收通知的好友，并设置合理的发送间隔。不要用于垃圾信息、
骚扰信息或违反微信规则的自动化行为。

## 2. 仓库结构

```text
customer-service/
├─ app/                         FastAPI 后端
├─ frontend/                    客服与管理后台前端
├─ docs/                        项目文档
├─ docker-compose.yml           FastAPI 和 PostgreSQL
├─ .env.example                 FastAPI 配置模板
└─ wechat-robot-client/
   ├─ .deploy/local/            微信机器人本地 Docker 部署目录
   ├─ .env.example              微信机器人客户端开发配置模板
   └─ README.md                 上游微信机器人项目说明
```

## 3. 新电脑准备

安装以下软件：

1. Git for Windows。
2. Docker Desktop。
3. 建议安装 Windows Terminal 或使用 PowerShell。

启动 Docker Desktop，等待 Docker Engine 正常运行，然后检查：

```powershell
docker version
docker compose version
git --version
```

如果上述命令均能返回版本信息，即可继续。

## 4. 获取源码

```powershell
git clone <你的 Git 仓库地址> D:\customer-service
cd D:\customer-service
```

不要从其他电脑复制 `.git`、`.env`、数据库目录或微信登录目录到 Git 仓库。

## 5. 创建公共 Docker 网络

两部分服务通过 `wechat-robot` 网络通信。新电脑只需创建一次：

```powershell
docker network create wechat-robot
```

如果提示网络已经存在，可以忽略。

检查网络：

```powershell
docker network inspect wechat-robot
```

## 6. 配置微信机器人管理后台

进入部署目录：

```powershell
cd D:\customer-service\wechat-robot-client\.deploy\local
Copy-Item .env.example .env
```

编辑该目录下的 `.env`：

```text
ROBOT_SECRET_KEY=至少32位的随机字符串
SESSION_SECRET=另一段随机字符串
LOGIN_TOKEN=登录机器人管理后台使用的密钥
SLIDER_TOKEN=当前可用的滑块服务令牌
REGISTRY=docker.io
```

可在 PowerShell 中生成随机字符串：

```powershell
[Convert]::ToBase64String(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(48)
)
```

`LOGIN_TOKEN` 是访问机器人管理后台时输入的登录密钥，请妥善保存，不要提交到 Git。
`SLIDER_TOKEN` 需要使用机器人项目当前提供的有效令牌；过期令牌可能导致扫码登录或机器人
创建流程异常。

## 7. 生成本地 HTTPS 证书

先运行：

```powershell
ipconfig
```

找到当前电脑的局域网 IPv4 地址，例如 `192.168.1.100`。然后执行：

```powershell
cd D:\customer-service\wechat-robot-client\.deploy\local
powershell -ExecutionPolicy Bypass `
  -File .\gen-self-signed-cert.ps1 `
  -IpAddresses 192.168.1.100
```

请将示例 IP 替换为当前电脑的实际局域网 IP。

## 8. 启动微信机器人管理后台

```powershell
cd D:\customer-service\wechat-robot-client\.deploy\local
docker compose pull
docker compose up -d
docker compose ps
```

第一次拉取镜像和初始化 MySQL 可能需要几分钟。管理后台可通过以下地址访问：

```text
http://127.0.0.1:8080
```

也可以使用：

```text
https://127.0.0.1:8443
```

自签名证书可能触发浏览器警告，本地部署确认地址无误后可继续访问。

登录方式选择“密钥登录”，输入微信机器人 `.env` 中配置的 `LOGIN_TOKEN`。

## 9. 创建机器人

登录机器人管理后台后：

1. 点击“创建机器人”。
2. 机器人名称可自行填写，例如“课程客服”。
3. 协议版本优先选择界面推荐版本。当前界面优先推荐 `8.0.59`；如果该版本明确登录失败，
   可删除失败实例并按界面提示尝试 `8.0.74`。
4. 不使用代理时，代理 IP、代理用户名和代理密码全部留空。
5. 点击“创建”。

创建后检查机器人详情中的服务端和客户端容器状态。也可以在 PowerShell 中检查：

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}" |
  Select-String "client_|server_"
```

正常情况下应同时存在：

```text
client_<机器人编码>
server_<机器人编码>
```

两个容器都应为 `Up`，不应持续显示 `Restarting`。

## 10. 登录微信

进入机器人详情，点击登录，建议优先使用界面推荐的 iPad 登录方式。

注意事项：

- 使用 iPad 扫码登录时，扫码手机和运行 Docker 的电脑应位于同一个局域网。
- 手机关闭移动数据后只保留同一 Wi-Fi，有助于避免出口 IP 不一致。
- 登录后按照手机提示确认。
- 看到管理后台显示登录成功后，再进行消息测试。
- Windows 微信、Mac 微信等登录方式是否可用取决于当前机器人协议和微信版本，遇到问题时
  优先回到界面推荐的登录方式。

登录新的微信账号时，不需要修改 AI 源码，只需要重新创建或登录机器人实例。

## 11. 获取机器人客户端地址

机器人容器名称由管理后台动态生成。运行：

```powershell
docker ps --filter "name=client_" `
  --format "table {{.Names}}\t{{.Status}}"
```

记下当前已登录机器人的客户端容器名，例如：

```text
client_xWZjBWwtxBwJxaD7
```

FastAPI 访问地址应写为：

```text
http://client_xWZjBWwtxBwJxaD7:9000
```

不要继续使用已经删除的旧机器人容器名。

## 12. 配置 FastAPI

回到仓库根目录：

```powershell
cd D:\customer-service
Copy-Item .env.example .env
```

编辑根目录 `.env`。至少检查以下配置：

```text
SECRET_KEY=一段新的随机字符串

LLM_ENABLED=true
DASHSCOPE_BASE_URL=https://聊天服务地址/v1
DASHSCOPE_API_KEY=聊天服务API密钥
DASHSCOPE_CHAT_MODEL=聊天模型名称

DASHSCOPE_EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_EMBEDDING_API_KEY=阿里云百炼API密钥
DASHSCOPE_EMBEDDING_MODEL=text-embedding-v4
DASHSCOPE_EMBEDDING_DIMENSIONS=1024

WECHAT_ROBOT_BASE_URL=http://client_<当前机器人编码>:9000
WECHAT_ROBOT_WEBHOOK_SECRET=一段单独的Webhook密钥
WECHAT_ROBOT_AUTO_REPLY_ENABLED=true
WECHAT_ROBOT_GROUP_REPLY_MODE=mention
WECHAT_ROBOT_GREETING_ENABLED=true
WECHAT_ROBOT_GREETING_TEXT=你好，我是课程客服助手。请问有什么可以帮你？
WECHAT_ROBOT_HANDOFF_MESSAGE=已为你转接人工客服，请稍候。
WECHAT_ROBOT_HANDOFF_AUTO_RESUME_HOURS=24
WECHAT_ROBOT_BROADCAST_MAX_RECIPIENTS=500
WECHAT_ROBOT_BROADCAST_INTERVAL_SECONDS=0.8
```

说明：

- `DASHSCOPE_BASE_URL`、`DASHSCOPE_API_KEY` 只负责聊天模型。
- `DASHSCOPE_EMBEDDING_BASE_URL`、`DASHSCOPE_EMBEDDING_API_KEY` 负责知识库和意图向量。
- 独立 Embedding URL 一旦填写，就必须同时填写对应的 Embedding Key，不会回退使用聊天 Key。
- 两项独立 Embedding 配置都留空时，为兼容旧部署，Embedding 会沿用聊天 URL 和 Key。
- `WECHAT_ROBOT_BASE_URL` 必须对应当前机器人客户端容器。
- `WECHAT_ROBOT_WEBHOOK_SECRET` 自行生成，下一步要在机器人系统设置中填写同一个值。
- 群聊建议保持 `mention`，只在机器人被 `@` 时回复。
- `WECHAT_ROBOT_HANDOFF_AUTO_RESUME_HOURS=0` 表示关闭自动恢复，必须由管理员手动恢复机器人。

## 13. 启动 FastAPI 智能客服

```powershell
cd D:\customer-service
docker compose up -d --build
docker compose ps
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

正常结果包含：

```json
{"status":"ok"}
```

打开管理后台：

```text
http://127.0.0.1:8000
```

当前默认本地测试账号：

```text
管理员：admin / admin123
普通用户：student / student123
```

默认账号只适用于本地测试。当前版本没有完整的密码修改界面，不要把 `8000` 端口直接暴露
到公网。

## 14. 配置消息 Webhook

在机器人管理后台进入当前机器人，然后打开“系统设置”，填写：

```text
Webhook 地址：
http://customer-service-api:8000/wechat-robot/callback
```

Webhook 请求头填写 JSON：

```json
{
  "X-Webhook-Token": "与根目录 WECHAT_ROBOT_WEBHOOK_SECRET 完全相同的值"
}
```

保存设置。客户端会自动在回调地址后附加 `robot_wxid`，不需要手工填写微信 wxid。

为什么使用 `customer-service-api`：

- FastAPI 容器在 `wechat-robot` 网络中使用该别名。
- 微信机器人客户端容器也在同一个网络中。
- 机器人可直接通过 Docker 内网调用 FastAPI，不依赖宿主机局域网 IP。

## 15. 首次功能验证

建议按照以下顺序验证。

### 15.1 自动回复

使用另一个微信好友给机器人发送：

```text
你好
```

预期结果：

- 首次会话先发送欢迎语。
- 随后调用 FastAPI 中的 AI 和知识库回复。

查看 FastAPI 日志：

```powershell
cd D:\customer-service
docker compose logs -f --tail 100 api
```

查看机器人客户端日志：

```powershell
docker logs -f --tail 100 client_<当前机器人编码>
```

### 15.2 知识库图片

在 FastAPI 管理后台为某条知识库事实上传图片，然后让好友询问能够命中该事实的问题。

预期结果：

- 先发送文字回答。
- 该事实存在图片时，再发送图片。
- 没有配置图片时只发送文字。

### 15.3 自动转人工

先在 FastAPI 管理后台“微信好友群发”区域点击“同步好友”，再从同步到的机器人好友中选择
一位“人工接管通知好友”并保存。选择“不发送微信通知”可以关闭该功能。

好友发送“转人工”“人工客服”或命中需要人工处理的咨询。

预期结果：

- 机器人发送转接提示。
- 该好友进入“人工接待队列”。
- 机器人暂停回复该好友。
- 机器人私聊选定的通知好友，发送客户微信 ID、来源和转人工消息。
- 同一会话处于人工暂停期间不会重复通知。

客服也可以直接通过电脑微信向某位好友主动发送文字、图片、语音、视频、表情或文件。系统
检测到人工主动发送后，会自动暂停该好友的机器人回复。

机器人自动回复、欢迎语和群发消息有系统发送回执，不会误判成人工接管。

人工处理完毕后，在 FastAPI 管理后台的“人工接待队列”点击“恢复机器人”。

### 15.4 微信好友群发

进入 FastAPI 管理后台的“微信好友群发”：

1. 刷新好友列表。
2. 系统默认勾选全部好友。
3. 取消不需要发送的好友。
4. 填写文案或选择图片。
5. 文案和图片至少填写一项，支持纯文字、纯图片、文字加图片。
6. 确认收件人数后发送。

群发会逐个好友发送，并显示成功和失败数量。

## 16. 日常启动和停止

### 16.1 启动顺序

```powershell
docker network create wechat-robot

cd D:\customer-service\wechat-robot-client\.deploy\local
docker compose up -d

cd D:\customer-service
docker compose up -d
```

网络已经存在时，第一条命令报错可以忽略。

### 16.2 停止服务

停止 FastAPI：

```powershell
cd D:\customer-service
docker compose stop
```

停止微信机器人管理后台：

```powershell
cd D:\customer-service\wechat-robot-client\.deploy\local
docker compose stop
```

不要随意执行以下命令：

```text
docker compose down -v
```

`-v` 会删除数据库卷，可能导致知识库和配置丢失。

### 16.3 修改 `.env` 后重启

FastAPI 配置修改后：

```powershell
cd D:\customer-service
docker compose up -d --force-recreate api
```

微信机器人管理后台配置修改后：

```powershell
cd D:\customer-service\wechat-robot-client\.deploy\local
docker compose up -d --force-recreate
```

## 17. 换微信账号

只更换微信账号，不需要重新编写 AI 逻辑。

推荐步骤：

1. 在机器人管理后台创建一个新机器人。
2. 使用新的微信扫码并确认登录。
3. 确认新的 `client_<机器人编码>` 和 `server_<机器人编码>` 都为 `Up`。
4. 修改根目录 `.env` 中的 `WECHAT_ROBOT_BASE_URL`。
5. 在新机器人“系统设置”中重新填写 Webhook 地址和请求头。
6. 重建 FastAPI API 容器。
7. 使用另一个好友发送消息验证。

命令：

```powershell
cd D:\customer-service
docker compose up -d --force-recreate api
```

## 18. 换电脑只迁移源码

如果新电脑使用新的微信，并且不需要旧知识库和旧聊天记录，只迁移 Git 源码即可。

新电脑执行顺序：

1. 克隆 Git 仓库。
2. 安装并启动 Docker Desktop。
3. 创建 `wechat-robot` 网络。
4. 创建两个 `.env`。
5. 生成本地证书。
6. 启动微信机器人管理后台。
7. 创建机器人并登录新微信。
8. 获取新客户端容器名。
9. 配置 FastAPI `.env`。
10. 启动 FastAPI。
11. 配置机器人 Webhook。
12. 测试自动回复、转人工和群发。

## 19. 常见故障

### 19.1 `network wechat-robot declared as external, but could not be found`

执行：

```powershell
docker network create wechat-robot
```

然后重新启动两个 Compose 项目。

### 19.2 管理后台无法打开

检查：

```powershell
cd D:\customer-service\wechat-robot-client\.deploy\local
docker compose ps
docker compose logs --tail 100 wechat-robot-admin-backend
docker compose logs --tail 100 wechat-nginx
```

确认 MySQL、Redis、管理后端和 Nginx 均已启动。

### 19.3 微信提示“应用版本过低”

先确认选择的是界面推荐协议版本。可删除失败机器人后重新创建，优先尝试 `8.0.59`，仍明确
失败时再按创建界面的提示尝试 `8.0.74`。

不要在同一个失败实例上反复扫码；重新创建实例通常更容易排除残留状态。

### 19.4 `server_<编码>` 持续 `Restarting`

查看日志：

```powershell
docker logs --tail 100 server_<机器人编码>
```

如果日志提示缺少：

```text
ROBOT_CODE
ROBOT_AUTH_KEY_ID
WECHAT_CLIENT_HOST
```

说明机器人服务端容器配置不完整，问题发生在机器人管理后台创建容器阶段，不是 FastAPI AI
回复逻辑。先更新管理后台镜像：

```powershell
cd D:\customer-service\wechat-robot-client\.deploy\local
docker compose pull
docker compose up -d
```

然后在管理后台删除失败实例的客户端和服务端容器并重新创建。若仍然出现相同错误，需要检查
管理后台镜像与机器人服务端镜像版本是否匹配。

### 19.5 FastAPI 日志提示机器人主机名无法解析

通常是 `.env` 仍然指向已经删除的旧客户端，例如：

```text
WECHAT_ROBOT_BASE_URL=http://client_旧编码:9000
```

重新查看当前客户端名称，修改 `.env` 并重建 API：

```powershell
docker ps --filter "name=client_" --format "{{.Names}} {{.Status}}"

cd D:\customer-service
docker compose up -d --force-recreate api
```

### 19.6 微信收到消息但机器人不回复

依次检查：

1. `client_` 和 `server_` 容器是否为 `Up`。
2. 机器人详情是否显示微信在线。
3. 系统设置中的 Webhook URL 是否正确。
4. Webhook 请求头密钥是否与 FastAPI `.env` 相同。
5. FastAPI `/health` 是否正常。
6. `DASHSCOPE_API_KEY` 是否有效。
7. 该好友是否仍处于“人工接待队列”。

### 19.7 图片无法发送

检查：

- 知识库事实是否真正保存了图片。
- FastAPI 与机器人客户端是否都在 `wechat-robot` 网络。
- Docker Compose 中 `WECHAT_ROBOT_MEDIA_BASE_URL` 是否为
  `http://customer-service-api:8000`。
- FastAPI 日志中是否有图片下载或机器人 API 错误。

### 19.8 好友列表或群发读取失败

检查 `WECHAT_ROBOT_BASE_URL` 是否指向当前在线的 `client_` 容器，并确认：

```powershell
docker ps --filter "name=client_" --format "{{.Names}} {{.Status}}"
```

修改地址后需要重建 FastAPI API 容器。

### 19.9 人工和机器人同时回复

客服第一次通过电脑微信主动向好友发消息后，系统会通过消息回调暂停该好友机器人。出现同时
回复时，检查：

- Webhook 是否正常回调。
- 当前人工发送的消息类型是否被客户端回调。
- 该好友是否出现在“人工接待队列”。
- FastAPI 是否使用了本次新增自动接管逻辑的源码。

## 20. 部署验收清单

- [ ] Docker Desktop 正常运行。
- [ ] `wechat-robot` 网络已创建。
- [ ] 两个 `.env` 已创建且未提交到 Git。
- [ ] 微信机器人管理后台可以打开。
- [ ] `client_` 和 `server_` 容器均为 `Up`。
- [ ] 微信登录成功。
- [ ] FastAPI `/health` 返回 `status: ok`。
- [ ] `WECHAT_ROBOT_BASE_URL` 指向当前客户端。
- [ ] Webhook URL 和请求头已保存。
- [ ] 好友发送文字可以收到自动回复。
- [ ] 配置图片的知识库事实可以发送图片。
- [ ] 人工主动发送后机器人会暂停。
- [ ] 管理员可以恢复机器人。
- [ ] 群发好友默认全选，并可取消部分好友。
- [ ] 纯文字、纯图片和文字加图片均可正常群发。

## 21. 首次上传 GitHub

当前电脑上的 Git `origin` 可能仍指向旧项目。上传前先检查：

```powershell
cd D:\customer-service
git remote -v
git status
```

不要把本项目直接推送到无关的旧仓库。建议保留旧远程作为备份，再绑定新的 GitHub 空仓库：

```powershell
git remote rename origin old-origin
git remote add origin <新的 GitHub 仓库地址>
```

提交合并后的源码：

```powershell
git add .
git commit -m "Add personal WeChat AI customer service"
```

将当前分支统一为 `main` 并推送：

```powershell
git branch -M main
git push -u origin main
```

上传前可再次确认不会提交运行数据：

```powershell
git status --short
git check-ignore .env
git check-ignore wechat-robot-client\.deploy\local\.env
```

两个 `.env` 应显示为已忽略，不能出现在待提交文件中。
