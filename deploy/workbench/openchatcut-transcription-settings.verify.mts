import assert from 'node:assert/strict';
import { syncServerTranscriptionPreferences } from '../src/transcript/server-preferences';

const data = new Map([['cc.transcriptionProvider', 'assemblyai'], ['cc.asrModel', 'tiny']]);
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  setItem: (key: string, value: string) => data.set(key, value),
} });
let notifications = 0;
Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: (event: Event) => {
  assert.equal(event.type, 'openchatcut:transcription-provider-change'); notifications++;
} } });
syncServerTranscriptionPreferences({ PREFERRED_TRANSCRIPTION_PROVIDER: 'local', LOCAL_ASR_MODEL: 'small',
  TRANSCRIPTION_LANGUAGE: 'zh', TRANSCRIPTION_DIARIZATION: '0', AUTO_TRANSCRIBE_INGEST: 'local' });
assert.equal(data.get('cc.transcriptionProvider'), 'local', 'Saved local provider overrides a stale browser cloud selection');
assert.equal(data.get('cc.asrModel'), 'small', 'Startup loads the installed tier without opening Settings');
assert.equal(data.get('cc.autoTranscribeIngest'), 'local');
assert.equal(data.get('cc.transcriptionDiarization'), '0');
assert.equal(notifications, 1);
syncServerTranscriptionPreferences({ PREFERRED_TRANSCRIPTION_PROVIDER: 'openai', LOCAL_ASR_MODEL: 'invalid', TRANSCRIPTION_LANGUAGE: 'en' });
assert.equal(data.get('cc.transcriptionProvider'), 'openai');
assert.equal(data.get('cc.asrModel'), 'small', 'Invalid catalog tiers are not persisted');
assert.equal(data.get('cc.transcriptionLanguage'), 'en');
Object.defineProperty(globalThis, 'localStorage', { get: () => { throw new Error('Storage disabled'); } });
assert.doesNotThrow(() => syncServerTranscriptionPreferences({}));
console.log('Transcription startup settings: stale provider, model selection, language and unavailable storage passed');
