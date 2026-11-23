import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const collectionPages = new WeakSet();
const minimizedPages = new WeakSet();

export function isBackgroundPage(page) {
  return collectionPages.has(page);
}

export async function createBackgroundPage(context, { forHandoff = false } = {}) {
  const browser = context.browser();
  if (!browser) throw new Error('无法连接后台采集浏览器。');
  const session = await browser.newBrowserCDPSession();
  const url = 'about:blank#workspace-' + randomUUID();
  let targetId;
  try {
    // All production contexts are persistent. Infer the partition from its own page if supplied.
    const anchor = context.pages().find(page => !page.isClosed());
    let browserContextId;
    if (anchor) {
      const probe = await context.newCDPSession(anchor);
      try { ({ targetInfo: { browserContextId } } = await probe.send('Target.getTargetInfo')); }
      finally { await probe.detach().catch(() => {}); }
    }
    ({ targetId } = await session.send('Target.createTarget', {
      url, newWindow: true, windowState: 'minimized', background: true, focus: false,
      ...(browserContextId && { browserContextId })
    }));
    const { bounds } = await session.send('Browser.getWindowForTarget', { targetId });
    if (bounds.windowState !== 'minimized') throw new Error('未能在后台打开采集窗口，已停止本次操作。');
    const page = context.pages().find(item => item.url() === url)
      || await context.waitForEvent('page', { predicate: item => item.url() === url, timeout: 10000 });
    if ((await session.send('Browser.getWindowForTarget', { targetId })).bounds.windowState !== 'minimized') {
      throw new Error('浏览器未保持最小化，已停止本次操作。');
    }
    if (!forHandoff) collectionPages.add(page);
    minimizedPages.add(page);
    return page;
  } catch (error) {
    if (targetId) await session.send('Target.closeTarget', { targetId }).catch(() => {});
    throw error;
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function focusInteractivePage(page) {
  if (!page || isBackgroundPage(page)) return;
  const context = page.context?.();
  if (context?.newCDPSession) {
    const session = await context.newCDPSession(page);
    try {
      const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
      if (bounds.windowState === 'minimized') {
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      }
    } finally { await session.detach().catch(() => {}); }
  }
  await page.bringToFront();
  minimizedPages.delete(page);
}

export async function capturePageEvidence(page, options = {}) {
  if (!minimizedPages.has(page)) return page.screenshot(options);
  const session = await page.context().newCDPSession(page);
  let timer;
  try {
    // A minimized compositor may never return a frame. Never restore the window for evidence.
    const capture = async () => {
      const { cssVisualViewport: v } = await session.send('Page.getLayoutMetrics');
      return session.send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true,
        clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 1 }
      });
    };
    const { data } = await Promise.race([capture(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('后台窗口未提供截图。')), 5000);
    })]);
    const bytes = Buffer.from(data, 'base64');
    if (options.path) await writeFile(options.path, bytes);
    return bytes;
  } finally { clearTimeout(timer); await session.detach().catch(() => {}); }
}
