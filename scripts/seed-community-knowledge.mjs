import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.CLOUD_BASE_URL || 'http://127.0.0.1:3100';
const seed = JSON.parse(fs.readFileSync(path.join(root, 'data', 'knowledge-seed-community.json'), 'utf8').replace(/^\uFEFF/, ''));

const currentResponse = await fetch(`${base}/api/knowledge`);
if (!currentResponse.ok) throw new Error(`读取知识库失败：HTTP ${currentResponse.status}`);
const current = (await currentResponse.json()).knowledge || [];
const existing = new Set(current.map(item => item.question.trim()));
let added = 0;
let skipped = 0;

for (const item of seed) {
  if (existing.has(item.question.trim())) {
    skipped += 1;
    continue;
  }
  const response = await fetch(`${base}/api/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: item.question, answer: item.answer, keywords: item.keywords })
  });
  if (!response.ok) throw new Error(`导入失败：${item.question} / HTTP ${response.status} / ${await response.text()}`);
  added += 1;
}

console.log(`知识种子共 ${seed.length} 条：新增 ${added} 条，已存在跳过 ${skipped} 条。`);
