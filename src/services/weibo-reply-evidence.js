export function hasReliableWeiboReplyEvidence(result = {}, outerStatus) {
  if (outerStatus !== 'SUCCESS') return false;
  if (result.stage !== 'reply_sent') return false;
  if (!result.evidencePath || !result.screenshotPath || !result.sendMethod) return false;
  if (result.targetIdentityVerified !== true || result.uniqueTargetMatch !== true) return false;
  if (result.editorCleared !== true) return false;

  const scopedEchoCount = Number(result.scopedEchoCount);
  const baselineEchoCount = Number(result.baselineEchoCount);
  return Number.isFinite(scopedEchoCount)
    && Number.isFinite(baselineEchoCount)
    && scopedEchoCount > baselineEchoCount;
}