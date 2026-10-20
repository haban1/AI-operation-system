import { contentDeclarationLabels, normalizeContentOrigin } from '../../src/services/content-origin.js';

const INCOMPLETE_PROGRESS_RE = /(?:上传中|正在上传|上传进度|当前进度|upload(?:ing)?)[^%]{0,40}(\d{1,3})\s*%/ig;
const BUSY_UPLOAD_RE = /uploading\b|processing\b|\u4e0a\u4f20\u4e2d|\u6b63\u5728\u4e0a\u4f20|\u4e0a\u4f20\u8fc7\u7a0b\u4e2d|\u7d20\u6750\u4e0a\u4f20\u4e2d|\u89c6\u9891\u5904\u7406\u4e2d|\u6b63\u5728\u5904\u7406\u6587\u4ef6|\u6587\u4ef6\u5904\u7406\u4e2d|\u7d20\u6750\u5904\u7406\u4e2d|\u8f6c\u7801\u4e2d|\u6b63\u5728\u8f6c\u7801|\u5c01\u9762\u751f\u6210\u4e2d|\u6b63\u5728\u751f\u6210\u5c01\u9762|\u667a\u80fd\u63a8\u8350\u5c01\u9762\u751f\u6210\u4e2d|\u5f53\u524d\u901f\u5ea6|\u5269\u4f59\u65f6\u95f4|\u53d6\u6d88\u4e0a\u4f20/i;
const INSTRUCTIONAL_UPLOAD_RE = /点击发布后[^。！？!?]{0,80}(?:上传中|上传发布完成)[。！？!?]?/ig;
const UPLOAD_FAILED_RE = /(?:视频|文件|素材)?\s*上传(?:失败|出错|异常)(?:[，,。；;\s]*(?:请)?重新上传)?|上传(?:视频|文件|素材)?\s*(?:失败|出错|异常)|(?:网络|连接)(?:错误|出错|异常|失败)[，,。；;\s]*(?:请)?重新上传|upload failed|failed to upload/i;

export { contentDeclarationLabels, normalizeContentOrigin };

export function analyzePublishReadiness({ text = '', publishButtonVisible = false, publishButtonEnabled = false } = {}) {
  const rawSample = String(text || '').replace(/\s+/g, ' ').trim();
  // 平台帮助文案可能包含“作品还在上传中”，它不是实时上传状态，不能据此阻断。
  const sample = rawSample.replace(INSTRUCTIONAL_UPLOAD_RE, ' ').replace(/\s+/g, ' ').trim();
  const progress = [];
  for (const match of sample.matchAll(INCOMPLETE_PROGRESS_RE)) progress.push(Number(match[1]));
  const incompleteProgress = progress.some(value => Number.isFinite(value) && value < 100);
  const uploadFailureMatch = sample.match(UPLOAD_FAILED_RE);
  const uploadFailed = Boolean(uploadFailureMatch);
  const busyText = BUSY_UPLOAD_RE.test(sample);
  const busy = !uploadFailed && (incompleteProgress || busyText);
  return {
    ready: !uploadFailed && !busy && publishButtonVisible && publishButtonEnabled,
    busy,
    uploadFailed,
    failureCode: uploadFailed ? 'PLATFORM_UPLOAD_FAILED' : null,
    failureText: uploadFailureMatch?.[0] || null,
    incompleteProgress,
    progress,
    publishButtonVisible: Boolean(publishButtonVisible),
    publishButtonEnabled: Boolean(publishButtonEnabled)
  };
}
