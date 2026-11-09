import { readFileSync, writeFileSync } from 'node:fs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const js = read('preview.js');
const css = read('preview.css');
if (/<\/script/i.test(js) || /<\/style/i.test(css)) {
  throw new Error('预览源文件包含会提前结束内联标签的内容，请先调整源文件。');
}
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="dark"><title>智慧驱动 · 全系统精简预览</title><link rel="icon" href="data:,"><style>${css}</style></head><body><div id="app"></div><script>${js}</script></body></html>`;
writeFileSync(new URL('interactive.html', import.meta.url), html);
console.log('已重建独立交互预览；静态截图与图册不变。');
