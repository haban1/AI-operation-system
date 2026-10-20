import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const target = new URL('.env.docker', root);
const secret = () => crypto.randomBytes(32).toString('hex');
const ragToken = secret();
const contents = fs.readFileSync(new URL('.env.docker.example', root), 'utf8')
  .replaceAll('replace-with-shared-rag-token', ragToken)
  .replaceAll('replace-with-random-secret', secret);
try {
  fs.writeFileSync(target, contents, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${fileURLToPath(target)} (admin / admin123; generated service tokens).`);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env.docker already exists; existing configuration retained.');
}
