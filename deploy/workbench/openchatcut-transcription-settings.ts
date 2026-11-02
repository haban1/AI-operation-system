import { isAsrModelTier } from '../../shared/asr-models';
import { isTranscriptionProviderId } from './types';

// Server preferences must reach the transcription client at startup, including
// old browser sessions. Previously only opening Settings synchronized these.
export function syncServerTranscriptionPreferences(models: Record<string, string>): void {
  try {
    const provider = models.PREFERRED_TRANSCRIPTION_PROVIDER;
    localStorage.setItem('cc.transcriptionProvider', isTranscriptionProviderId(provider) ? provider : 'assemblyai');
    localStorage.setItem('cc.transcriptionLanguage', models.TRANSCRIPTION_LANGUAGE?.trim() || 'zh');
    localStorage.setItem('cc.transcriptionDiarization', models.TRANSCRIPTION_DIARIZATION === '0' ? '0' : '1');
    const tier = models.LOCAL_ASR_MODEL ?? '';
    if (isAsrModelTier(tier)) localStorage.setItem('cc.asrModel', tier);
    const ingest = models.AUTO_TRANSCRIBE_INGEST;
    if (ingest === 'off' || ingest === 'local' || ingest === 'all') localStorage.setItem('cc.autoTranscribeIngest', ingest);
    window.dispatchEvent(new Event('openchatcut:transcription-provider-change'));
  } catch {
    // Match the existing settings UI when browser storage is unavailable.
  }
}
