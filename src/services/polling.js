export function randomIntervalMs(minMs, maxMs, random = Math.random) {
  const min = Math.ceil(Number(minMs));
  const max = Math.floor(Number(maxMs));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    throw new RangeError('Invalid polling interval range');
  }
  const sample = Number(random());
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('Random sample must be within [0, 1)');
  }
  return min + Math.floor(sample * (max - min + 1));
}
