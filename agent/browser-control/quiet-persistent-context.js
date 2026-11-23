import path from 'node:path';
import { chromium } from 'playwright-core';

export function launchQuietPersistentContext(profileDir, {
  executablePath, viewport = null, acceptDownloads = true, locale = 'zh-CN', headless = false, timeout
} = {}) {
  if (!profileDir) throw new Error('A dedicated browser profile is required');
  const profile = path.resolve(profileDir);
  return chromium.launchPersistentContext(profile, {
    executablePath, viewport, acceptDownloads, locale, headless, timeout,
    // A normal persistent launch adds about:blank and waits for its window.
    ignoreDefaultArgs: true,
    args: [
      `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-startup-window',
      '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble',
      '--enable-automation', '--disable-extensions', '--disable-background-networking',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', `--lang=${locale}`,
      ...(headless ? ['--headless=new'] : []),
      ...(process.platform === 'linux' ? ['--password-store=basic', '--disable-dev-shm-usage'] : []),
      ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [])
    ]
  });
}
