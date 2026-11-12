import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from './media.mjs';
import { fail } from './errors.mjs';

export async function chooseSourceFolder(root, { signal } = {}) {
  if (process.platform !== 'darwin') fail(422, 'FOLDER_PICKER_UNAVAILABLE', '请填写本机素材文件夹的完整路径');
  const bundle = path.join(root, 'local-tools', 'Montage Folder Picker.app');
  const binary = path.join(bundle, 'Contents', 'MacOS', 'picker');
  const source = fileURLToPath(new URL('./choose-folder.swift', import.meta.url));
  const compiled = await fs.stat(binary).catch(() => null);
  if (!compiled || compiled.mtimeMs < (await fs.stat(source)).mtimeMs) {
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.operations.montage-folder-picker</string><key>CFBundleName</key><string>混剪素材文件夹</string><key>CFBundleExecutable</key><string>picker</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`);
    try {
      await exec('/usr/bin/xcrun', ['swiftc', '-O', source, '-o', binary], { timeout: 120000, maxBuffer: 500000 });
    } catch {
      fail(422, 'FOLDER_PICKER_UNAVAILABLE', '本机文件夹选择器暂不可用，请填写完整路径');
    }
  }
  try {
    const { stdout } = await exec(binary, [], { timeout: 120000, maxBuffer: 8192, signal });
    if (!stdout.trim()) fail(422, 'FOLDER_PICKER_CANCELLED', '已取消选择素材文件夹');
    return stdout.trim();
  } catch (error) {
    if (error.code === 'FOLDER_PICKER_CANCELLED') throw error;
    fail(422, 'FOLDER_PICKER_UNAVAILABLE', '本机文件夹选择器暂不可用，请填写完整路径');
  }
}
