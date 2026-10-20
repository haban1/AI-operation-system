# 五平台通用发布素材

生成日期：2026-08-05

## 直接使用

- 视频：`community-activity-guide-1080x1920.mp4`
- 封面：`community-activity-guide-cover.png`
- 标题、正文与话题：`publish-copy.txt`

适用平台：小红书、抖音、视频号、哔哩哔哩、微博。

## 视频规格

- MP4 / H.264 High / yuv420p
- 1080 × 1920，9:16 竖屏
- 15 秒，24 FPS
- AAC-LC，44.1 kHz
- 文件约 3.2 MB

## 校验结果

- 五个平台：无 `BLOCKED`
- 项目预检：五个平台均为 `WARNING`
- 警告原因：项目当前未安装视频元数据解析器，无法由预检器自动读取视频分辨率、时长、编码等参数
- FFmpeg 实际参数及完整解码：通过
- 文案与画面文字合规：`PASSED`

详细结果见：

- `precheck-report.json`
- `media-info.txt`
- `material-manifest.json`

## 可编辑源文件

- `slides/`：六幕画面 PNG
- `generate_material.py`：重新生成视频
- `validate_material.mjs`：重新运行项目预检和内容合规检查
