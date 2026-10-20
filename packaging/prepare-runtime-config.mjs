import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const channelFlags = [
  'CHANNEL_SPLIT_ENABLED',
  'PLATFORM_CHANNEL_SPLIT_DOUYIN',
  'PLATFORM_CHANNEL_SPLIT_XIAOHONGSHU',
  'PLATFORM_CHANNEL_SPLIT_WECHAT_CHANNELS',
  'PLATFORM_CHANNEL_SPLIT_BILIBILI',
  'PLATFORM_CHANNEL_SPLIT_WEIBO'
];

function envValues(text) {
  return new Map(text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && line.includes('=')).map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
}

export function prepareRuntimeTemplate(sourceText, templateText) {
  const source = envValues(sourceText);
  const selected = new Map(channelFlags.map(name => [name, ['false', '0', 'off', 'no', undefined].includes(source.get(name)?.toLowerCase()) ? 'false' : 'true']));
  selected.set('INSTALLER_CHANNEL_CONFIG_VERSION', '1');
  const note = '# Installed channel settings from the build computer; no credentials or paths.';
  const lines = templateText.split(/\r?\n/).filter(line => line !== note && !selected.has(line.split('=', 1)[0].trim()));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return [...lines, '', note, ...[...selected].map(([name, value]) => `${name}=${value}`), ''].join('\r\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [sourcePath, templatePath, destinationPath] = process.argv.slice(2);
  if (!sourcePath || !templatePath || !destinationPath) throw new Error('Usage: prepare-runtime-config.mjs <source .env> <template> <destination>');
  if ([sourcePath, templatePath].some(input => path.resolve(input) === path.resolve(destinationPath))) throw new Error('Destination must be an installation copy');
  fs.writeFileSync(destinationPath, prepareRuntimeTemplate(fs.readFileSync(sourcePath, 'utf8'), fs.readFileSync(templatePath, 'utf8')), 'utf8');
  console.log('Installation channel settings prepared');
}
