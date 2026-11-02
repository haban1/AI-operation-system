import { readFile, writeFile } from 'node:fs/promises';

// Keep the pinned upstream checkout intact; apply this adapter in the image.
// The editor checks Origin before /llm. Its subsequent server-to-server request
// must not carry browser context into Tianhe's independent CORS boundary.
const file = new URL('../server/proxy.ts', import.meta.url);
const original = await readFile(file, 'utf8');
const marker = '  // Tianhe: browser context ends at the editor proxy.';
if (!original.includes(marker)) {
  const anchor = '  cookie: true,';
  if (original.split(anchor).length !== 2) {
    throw new Error('OpenChatCut proxy changed: review the Tianhe header adapter');
  }
  const patched = original.replace(anchor, `${anchor}
${marker}
  origin: true,
  referer: true,
  'sec-fetch-site': true,
  'sec-fetch-mode': true,
  'sec-fetch-dest': true,
  'sec-fetch-user': true,`);
  await writeFile(file, patched);
}
