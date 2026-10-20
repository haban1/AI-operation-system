# 微信协议朋友圈空名单修复

当前 `wechat-ipad-8074` v1.2.2 的朋友圈发布逻辑会把空联系人字符串编码为一个空用户名。本目录提供针对已核验版本的可复现补丁及镜像构建方式。实际公开发布仍待用户测试，离线验证不代表微信服务端已接受发布。

`patch_moment_lists.py` 检查完整原文件 SHA256、ELF64 可执行段和三处原指令，只输出独立修复文件、JSON 清单及离线测试。哈希不符时拒绝修改，不覆盖输入文件，不连接微信。

补丁将三处字符串分割参数从 `-1` 改为 `-len(input)`：空名单变为零项，非空名单保持原行为。三处等长替换共改变 18 字节。具体诊断、部署和回滚记录见 `../../docs/朋友圈发布排查-20261020.md`。

## 构建与离线验证

在项目根目录运行 PowerShell，需要 Python、Docker 和可用的 Go 构建镜像：

```powershell
$work = Join-Path (Get-Location) '.codex-work/moment-protocol-build'
New-Item -ItemType Directory -Path $work -Force | Out-Null
$base = 'registry.cn-shenzhen.aliyuncs.com/houhou/wechat-ipad-8074@sha256:f32ac5b1b5e05a88b0736c483e1248887845293e6f8670ecd51243d8dd16b620'
$extractId = docker create --entrypoint /bin/true $base
if ($LASTEXITCODE -ne 0) { throw 'Cannot create export container' }
try {
  docker cp "${extractId}:/usr/wic-go/main" "$work/server-main"
  if ($LASTEXITCODE -ne 0) { throw 'Cannot export original program' }
} finally {
  docker rm $extractId
}
python wechat-assistant/wechat-robot-protocol/patch_moment_lists.py `
  "$work/server-main" "$work/server-main.patched" --test-dir "$work/check"
if ($LASTEXITCODE -ne 0) { throw 'Patch rejected this executable' }
docker run --rm --network none --mount "type=bind,source=$work,target=/work" `
  -w /work/check docker.m.daocloud.io/library/golang:1.25.8 go test -v -count=1 ./...
if ($LASTEXITCODE -ne 0) { throw 'Offline verification failed' }
docker build -f wechat-assistant/wechat-robot-protocol/Dockerfile.moment-lists `
  -t tianhe-wechat-ipad-8074:moment-lists-fixed $work
if ($LASTEXITCODE -ne 0) { throw 'Image build failed' }
```

测试直接执行从修复文件提取的指令，验证空名单修复及非空名单行为保持一致。以上步骤仅构建和验证，不部署、不发布朋友圈。

## 部署约定

2026-10-20 已将补丁部署到现有协议容器，并将机器人 ID 3 的管理数据库 `docker_image` 更新为 `tianhe-wechat-ipad-8074:moment-lists-fixed`，供后续重建使用。当前容器未重建，其 `Config.Image` 仍为原镜像名称；实际运行程序应以 SHA256 为准。

迁移主机前必须先构建或导入修复镜像，保留原有微信数据、配置及网络。此本地镜像没有推送到远程仓库。

上游升级会触发完整哈希校验失败，不应跳过校验套用旧补丁。优先采用上游源码修复，并验证三个名单的空值处理。
