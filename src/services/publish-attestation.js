export function hasReliablePublishEvidence(payload = {}, result = {}, outerStatus = '') {
  if (payload.platformCode === 'xiaohongshu') {
    if (outerStatus !== 'SUCCESS' || result.stage !== 'published' || result.submissionStatus !== 'SUBMITTED') return false;
    if (result.submitAttempted !== true || !result.evidencePath || !result.screenshotPath) return false;
    if (result.publishSignal?.confirmed !== true) return false;
    return ['new-success-url', 'new-visible-success-signal'].includes(result.publishSignal.source);
  }
  if (payload.platformCode !== 'wechat_channels') return outerStatus === 'SUCCESS';
  if (outerStatus !== 'SUCCESS' || result.stage !== 'published' || result.submissionStatus !== 'SUBMITTED') return false;
  if (!result.evidencePath || !result.screenshotPath || result.publishSignal?.confirmed !== true) return false;
  return ['success-url', 'visible-success-signal'].includes(result.publishSignal.source);
}
