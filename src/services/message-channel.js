const VALID_CHANNELS = new Set(['PRIVATE_MESSAGE', 'COMMENT']);

export function normalizeChannelType(value) {
  const channel = String(value ?? '').trim().toUpperCase();
  if (!VALID_CHANNELS.has(channel)) throw new Error(`不支持的消息通道：${channel || 'EMPTY'}`);
  return channel;
}
