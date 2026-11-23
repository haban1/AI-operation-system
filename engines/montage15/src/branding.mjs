import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const logo = readFileSync(new URL('../assets/branding/intellidriven.png', import.meta.url));
export const brandingFingerprint = createHash('sha256').update(logo).update('corner-logo-v1:0.12:0.03:0.94').digest('hex');

export function cornerBranding(width, height) {
  const shortSide = Math.min(width, height), size = Math.round(shortSide * .12), margin = Math.round(shortSide * .03);
  return {
    textLeft: margin + size + 24,
    html: `<img class="intellidriven-logo" alt="智慧驱动" src="data:image/png;base64,${logo.toString('base64')}" style="position:absolute;left:${margin}px;top:${margin}px;width:${size}px;height:auto;opacity:.94;z-index:1000;pointer-events:none;filter:drop-shadow(0 1px 2px #ffffffb3) drop-shadow(0 1px 3px #00000059)" decoding="sync" loading="eager">`,
  };
}
