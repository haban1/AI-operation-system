import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

// Preserve the supplied company artwork; only crop the symbol for small browser icons.
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(root, 'engines/video-studio/bundled/company-assets/Logo/智慧驱动-透明Logo.png');
const output = path.join(root, 'public');
mkdirSync(path.join(output, 'branding'), { recursive: true });
copyFileSync(source, path.join(output, 'branding/company-logo-original.png'));
const { height } = await sharp(source).metadata();
const symbol = await sharp(source).extract({ left: 0, top: 0, width: height, height }).png().toBuffer();
writeFileSync(path.join(output, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${height} ${height}" role="img" aria-label="智慧驱动"><image width="${height}" height="${height}" href="data:image/png;base64,${symbol.toString('base64')}"/></svg>\n`);
await sharp(symbol).resize(32, 32).png().toFile(path.join(output, 'favicon-32.png'));
await sharp(symbol).resize(180, 180).png().toFile(path.join(output, 'apple-touch-icon.png'));
const sizes = [32, 48, 256];
const images = await Promise.all(sizes.map(size => sharp(symbol).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (let i = 0; i < images.length; i++) {
  const pos = 6 + i * 16;
  header[pos] = sizes[i] === 256 ? 0 : sizes[i];
  header[pos + 1] = header[pos];
  header.writeUInt16LE(1, pos + 4);
  header.writeUInt16LE(32, pos + 6);
  header.writeUInt32LE(images[i].length, pos + 8);
  header.writeUInt32LE(offset, pos + 12);
  offset += images[i].length;
}
writeFileSync(path.join(output, 'favicon.ico'), Buffer.concat([header, ...images]));
console.log('Restored original company artwork and generated browser icons.');
