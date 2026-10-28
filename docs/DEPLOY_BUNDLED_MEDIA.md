# 随仓库部署现有成片

这份说明是新机器和部署 Agent 的执行依据。仓库携带已确认的固定媒体副本，新部署从这些文件重建公共素材库；不复制开发者的数据库、浏览器登录态或本机目录。新生成的作品仍自动同步为待确认。

本次 GitHub 交付包仅包含 **28 个视频，不包含图片**。本机现有的 44 项媒体可保留本机的确认结果，其中 16 张图片不会随 GitHub 克隆或容器分发。来源与界面对应如下；AIGC 的两条视频保留片段属性，不改称完整成片。

| 来源 | 随仓库内容 | 新部署查看位置 |
| --- | --- | --- |
| `automatic` | 18 个热点视频 | 自动热点的成片库、公共素材库 |
| `editing` | 六套工作流样片、2 条历史视频，共 8 条 | 六套样片在混剪成片库；8 条均在公共素材库 |
| `creation` | 2 个 AIGC 预览片段 | 公共素材库、发布素材选择器 |

## 仓库交付内容

```text
bundled/content-library/
  manifest.json     # 来源、作品标识、媒体文件及精确摘要
  approval.json     # 本次已确认作品的固定字节审批证明
  media/            # Git 中的真实媒体文件，不是本机路径或软链接
```

`engines/video-studio/bundled/` 另保留六套工作流样片、封面和样片说明。相同媒体在 Git 中按内容复用对象。

媒体、清单与审批证明必须来自同一版本的源码。审批证明的 SHA-256 由 seed loader 的代码常量锁定；修改 JSON 的空白、换行或字段也会改变该摘要。`.gitattributes` 将清单固定为 LF，并禁止媒体文本转换，以保证 Windows 克隆后的字节一致。

运行时索引、副本及审核状态写到 `CONTENT_LIBRARY_DIR`；容器默认是 `/app/data/content-library`，保存在 `web_data` 命名卷。Git 中的 `bundled/` 只是可重复初始化的来源，不是运行时数据库。

## 新机器默认启动

准备 Node.js 24+、Docker Desktop 的 Linux containers，以及 Docker Compose 2.24.4+。Windows 的 RAG 模型和 Docker 配置按 [Windows 本机部署](Windows本机部署.md) 与 [Signal 部署说明](Signal-Studio部署.md) 准备。

```sh
git clone https://github.com/haban1/AI-operation-system.git
cd AI-operation-system
npm ci --no-audit --no-fund
npm run media:verify -- --json
node scripts/workbench.mjs start --no-browser
```

本次交付若尚未合并到 `main`，部署 Agent 应从 `codex/video-studio-cli` 分支克隆（在 `git clone` 后加 `--branch codex/video-studio-cli`），并核对该版本包含本页、媒体清单及 28 个视频，避免部署到旧版默认分支。

第一次运行若提示创建了 `.env.docker`，先在该机器填写自己的管理员密码，再执行最后一条命令。已有配置不覆盖。该入口使用 `compose.yaml` 加 `compose.signal.yaml`，启动 Web、RAG 和仓库自带的 Signal，不依赖另一个仓库或开发者电脑上的 8890 服务。

新部署保持 `VIDEO_STUDIO_UPSTREAM_URL` 为空，使用仓库中的内嵌混剪模块。不要复制开发机的 `compose.local.yaml`、`compose.outputs.local.yaml` 或绝对路径映射。查看已随仓库提供的成片不需要模型 API Key；调用新的模型和 ChatCut 服务时再配置本机凭据。

Dockerfile 将 `bundled/content-library` 复制到 `/app/bundled/content-library`，`.dockerignore` 明确允许该目录进入构建上下文。更新交付包后重新构建镜像；只执行容器 `restart` 不会把新仓库文件放进旧镜像。

```sh
node scripts/workbench.mjs start --no-browser
node scripts/workbench.mjs status
```

浏览器打开 `http://127.0.0.1:3100` 并登录，进入“内容生成 → 素材库”。也可从“发布管理 → 从素材库选择”检查同一批作品。仅停止服务使用 `node scripts/workbench.mjs stop`，保留卷中的作品和审核状态。

## 默认初始化与审批边界

`CONTENT_LIBRARY_SEED_ENABLED` 默认启用；`CONTENT_LIBRARY_SEED_ROOT` 默认指向仓库的 `bundled/content-library`。需要禁用随仓库初始化时显式设为 `false`。改 seed 根目录只改变读取位置，不允许任意审批文件绕过代码中的摘要锁。

main 每次启动都会执行 seed 初始化，不依赖业务数据库是否新建。清单中的作品通过正式素材库复制、媒体检测和摘要校验进入运行时库。

日志中的 `imported` 是本轮新收录数，`approved` 是本轮新应用固定审批的数量，`retained` 包括保留已有审批或人工审核状态的项目，`failed` 是独立失败数。空库完整初始化应为 `imported=28 approved=28 retained=0 failed=0`；未改动后重启应为 `imported=0 approved=0 retained=28 failed=0`。旧库已有作品时不能要求重复出现 `approved=28`。

自动恢复“已确认”仅适用于锁定审批证明中的 `source + sourceId + sha256 + bytes` 完整匹配项。新增文件、改变媒体字节或没有审批证明的作品只能进入待确认。审批证明不能给今后所有输出授权。

同一来源与摘要重复启动不会新增一份作品。已有人工审核记录优先：部署后手动撤回为待确认或拒绝的作品，重启不会把它重新批准。文件丢失、大小改变或同大小内容被改写，仍必须通过真实文件校验；清单里的状态不能替代校验。

作品已确认只表示可以带入发布草稿。平台账号、内容来源声明、素材预检、AI 审核和最终发布授权继续执行。

### 清单合同

实现入口为 `src/services/content-library-seeds.js`，启动入口为 `src/server.js`，配置来自 `src/config.js`。以代码和同一 commit 的交付包为准。

| 文件 | 必需字段与约束 |
| --- | --- |
| `manifest.json` | `schemaVersion: 1`、`items` 数组。每项包含稳定 `id`、`source`、`sourceId`、`title`、`filename`、`artifactType`、`mediaType`、`filePath`、`sha256`、`bytes`。本包的 `mediaType` 全部为 `video`；验证器也支持另行授权的 `image`。 |
| 媒体引用 | `source` 为 `automatic` / `editing` / `creation`；`artifactType` 为 `final_video` / `video_clip` / `image`；`filePath` 必须是 `media/<sha256>.<扩展名>`，不能是绝对路径、远程 URL、软链接或包含 `..`。 |
| `approval.json` | `schemaVersion: 1`、`actor`、`basis`、`approvedAt`，以及 `items` 数组；每项仅按 `source`、`sourceId`、`sha256`、`bytes` 组成精确授权 tuple。 |
| 摘要锁 | `BUNDLED_CONTENT_APPROVAL_SHA256` 必须等于 `approval.json` 原始文件字节的 SHA-256；审批范围不会由 `manifest.json` 的状态字段扩展。 |

## 部署验收

在一个新的运行目录或新的 Compose project/空卷上验收，避免把开发机已有数据误认为随仓库初始化成功。不要删除正在使用的卷来制造空环境。

1. Git 中有清单、审批证明和清单引用的全部媒体；每个媒体文件的大小及 SHA-256 与清单完全一致，且不是 Git LFS 指针或软链接。
2. 空库第一次启动后，公共素材库包含交付清单全部作品；与锁定审批证明精确匹配的项目为已确认。总数和按 `automatic` / `editing` 来源的数量，应按清单逐项比对。
3. 混剪成片页应有 6 套工作流样片；自动热点成片库应有 18 项热点视频；公共素材库共 28 个视频，另 4 条为历史视频（2 条 `editing`、2 条 `creation` 片段）。热点成片入口 `#automatic/library` 从公共库按来源筛选，不依赖 Signal 原生 `runs` 历史。Signal 的任务过程、评审过程和可编辑工程不由媒体副本重建。
4. 预览和 Range 播放成功；从公共素材库选择已确认作品能进入发布草稿，并仍提示完成平台预检与审核。未登录访问素材或接口应被拒绝。
5. 重启后，作品数量及稳定 ID 不变，不产生重复入库。手动撤回一项后再重启，该项保持撤回后的审核状态。
6. 在隔离验收库中改写一项的媒体字节，即使大小不变也应校验失败，不得以旧审批直接发布。未列入审批证明的测试输出保持待确认。

`node scripts/workbench.mjs verify` 可检查登录保护、Signal 页面/API 和合成渲染；它不能单独证明交付媒体数量、SHA-256 和审批状态已验收。

下面的只读验收脚本在容器内检查交付媒体实际字节、审批摘要锁，以及已登录 API 返回的确认记录。凭据从容器环境读取，不写到命令行或日志。示例使用 POSIX shell；Windows 部署 Agent 可把 heredoc 内容保存为临时 `.mjs` 文件后以相同环境执行。

```sh
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml \
  exec -T web node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { verifyBundledMedia } from './scripts/verify-bundled-media.mjs';

const root = path.resolve(process.env.CONTENT_LIBRARY_SEED_ROOT || 'bundled/content-library');
const manifest = JSON.parse(await fsp.readFile(path.join(root, 'manifest.json'), 'utf8'));
const verified = await verifyBundledMedia({ manifestPath: path.join(root, 'manifest.json') });
assert.equal(verified.counts.total, 28);
assert.equal(verified.counts.approved, 28);
assert.deepEqual(verified.counts.mediaTypes, { video: 28, image: 0 });
assert.deepEqual(verified.counts.sources, { automatic: 18, editing: 8, creation: 2 });

const base = 'http://127.0.0.1:3100';
const login = await fetch(base + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }),
});
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie);
try {
  const response = await fetch(base + '/api/content-library', {
    headers: { Cookie: cookie }, signal: AbortSignal.timeout(120000),
  });
  assert.equal(response.status, 200);
  const library = await response.json();
  const approved = library.items || [];
  for (const item of manifest.items) {
    assert.ok(approved.some(record => record.source === item.source && record.sourceId === item.sourceId
      && record.sha256 === item.sha256 && record.sizeBytes === item.bytes
      && record.admissionStatus === 'approved'), `Missing approved seed: ${item.id}`);
  }
  console.log(JSON.stringify({ checked: manifest.items.length, bySource: verified.counts.sources, approvedMatches: 28 }));
} finally {
  await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
}
NODE
```

有 `compose.outputs.local.yaml` 时，手动命令须追加同一个 `-f compose.outputs.local.yaml`。若某项已由部署人员手动撤回，脚本对该项失败是符合审核边界的结果，应核对撤回记录，而不是重新自动批准。

## 给后续维护 Agent

新增交付成片时先完成一次真实媒体校验和人工确认，再更新清单与明确授权的审批证明；只有取得新的明确审批后才能更新 loader 的审批摘要常量。不要仅修改状态字段，或把未来输出默认批准。

不要提交 `.env*` 私有文件、API Key、Cookie、Codex/ChatCut 登录态、平台 Profile、业务数据库或运行时 `catalog.json`。部署包使用可独立重建的清单和媒体，不从开发者绝对路径读取文件。

修改后至少检查 seed 初始化测试、素材审核与工作台集成测试，并在新数据目录中验证数量、摘要、来源分组和重复启动。保留测试结果与源码 commit，作为部署记录。

```sh
node --test test/bundled-media-verifier.test.js test/content-library-seeds.test.js test/content-library-studio.test.js \
  test/content-library-admission.test.js test/video-studio-integration.test.js
```
