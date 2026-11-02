import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../src/app/appShell.ts', import.meta.url);
const source = await readFile(file, 'utf8');
const marker = 'syncServerTranscriptionPreferences(models);';
if (!source.includes(marker)) {
  const anchor = '      applyLiveModels(models);';
  if (source.split(anchor).length !== 2) throw new Error('OpenChatCut startup changed: review transcription settings sync');
  await writeFile(file, "import { syncServerTranscriptionPreferences } from '../transcript/server-preferences';\n"
    + source.replace(anchor, anchor + '\n      ' + marker));
}
