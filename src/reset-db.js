import fs from 'node:fs';
import { config } from './config.js';
if (fs.existsSync(config.databasePath)) fs.rmSync(config.databasePath);
await import('./db.js');
console.log(`数据库已重置：${config.databasePath}`);
