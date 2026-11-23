# 公司标志：页面与视频

侧栏和登录页使用同一份原版透明 Logo，日间、夜间都保留原色。浏览器图标取左侧齿轮脑形区域，避免小尺寸下难以辨认。页面没有将字标重绘成主题色或叠加立体效果。

| 用途 | 资产或入口 |
| --- | --- |
| 公司原图 | `engines/video-studio/bundled/company-assets/Logo/智慧驱动-透明Logo.png` |
| 登录和侧栏 | `public/branding/company-logo-original.png`；布局在 `public/index.html`、`public/app-shell.css` |
| 浏览器/触屏图标 | `public/favicon.svg`、`public/favicon-32.png`、`public/favicon.ico`、`public/apple-touch-icon.png` |
| 新生成的视频 | 混剪和热点引擎各自读取随包透明 Logo；更新网页副本不会自动改变引擎中的文件，也不会改写已导出的 MP4 |

在安装项目依赖后，`node scripts/design/restore-company-logo.mjs` 从原图生成网页副本及图标，不改写源图。更新时同步 HTML 中的资源版本，分别检查日间、夜间、窄屏和新导出视频。静态副本不能代替组织对新商标或素材的授权。

### 历史方案

`public/branding/` 下的日夜 SVG 及玻璃 PNG 是先前方案，不是当前导航 Logo。需要重现历史玻璃图时，可在独立 Python 环境准备 Blender 4.3 / Cycles、NumPy 1.x、OpenCV，运行 `scripts/design/render-brand-glass.py`（`--font` 可指定已授权的本地中文字体），再用 `node scripts/design/export-brand-glass.mjs` 导出。字体和渲染中间件不是网页运行依赖，不随源码分发。不要因此把历史图片重新接入当前页面。
