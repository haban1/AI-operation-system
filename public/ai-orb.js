/* 运营总览的 AI 员工示意：旋转的粒子球，五个平台图标沿轨道转动。
   只做展示；颜色取主题令牌，性能模式或“减少动态效果”时只画一帧。 */
import { PLATFORM_BRANDS, PLATFORM_ORDER, platformPath } from './platform-icons.js?v=20261111-v2';

const running = new WeakMap();
const mounted = new Map();
/* 切换日间/夜间或光效后按新颜色重画 */
window.addEventListener('tk-theme-change', () => {
  for (const [canvas, options] of mounted) { if (canvas.isConnected) mountAiOrb(canvas, options); else mounted.delete(canvas); }
});

export function mountAiOrb(canvas, { platforms = [], centerValue = '', centerLabel = '' } = {}) {
  if (!canvas || !canvas.getContext || !canvas.isConnected) return;
  mounted.set(canvas, { platforms, centerValue, centerLabel });
  const previous = running.get(canvas);
  if (previous) cancelAnimationFrame(previous.frame);
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, R = W * 0.26;
  const css = getComputedStyle(document.documentElement);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const accent = token('--tk-acc', '#2563eb');
  const accent2 = token('--tk-acc2', '#14b8a6');
  const ink = token('--tk-ink', '#0f1b2d');
  const muted = token('--tk-muted', '#536176');
  const warn = token('--tk-warn', '#c46a00');
  const points = [];
  const N = 240;
  for (let i = 0; i < N; i += 1) {
    const y = 1 - 2 * (i + 0.5) / N, r = Math.sqrt(1 - y * y), th = i * 2.39996;
    points.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  const nodes = (platforms.length ? platforms : PLATFORM_ORDER.map(code => ({ code, ok: true })))
    .filter(item => PLATFORM_BRANDS[item.code])
    .map(item => ({ ...item, path: new Path2D(platformPath(item.code)), brand: PLATFORM_BRANDS[item.code] }));
  const still = document.documentElement.getAttribute('data-fx') === 'off'
    || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const state = { frame: 0, t: previous?.t ?? 0.6 };
  running.set(canvas, state);

  const drawNode = (node, x, y, front) => {
    ctx.globalAlpha = front ? 1 : 0.5;
    ctx.fillStyle = node.brand.filled ? node.brand.color : '#ffffff';
    ctx.shadowColor = 'rgba(20,40,90,.25)'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(x, y, 18, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    const size = node.brand.filled ? 28 : 20;
    ctx.save(); ctx.translate(x - size / 2, y - size / 2); ctx.scale(size / 24, size / 24);
    ctx.fillStyle = node.brand.filled ? '#ffffff' : node.brand.color; ctx.fill(node.path); ctx.restore();
    if (!node.ok) { ctx.fillStyle = warn; ctx.beginPath(); ctx.arc(x + 13, y - 13, 4.5, 0, 7); ctx.fill(); }
  };

  const frame = () => {
    if (!canvas.isConnected) { running.delete(canvas); mounted.delete(canvas); return; }
    const t = state.t;
    ctx.clearRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, H / 2, R * 0.2, W / 2, H / 2, R * 1.7);
    glow.addColorStop(0, accent + '33'); glow.addColorStop(1, accent + '00');
    ctx.globalAlpha = 1; ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(W / 2, H / 2, R * 1.7, 0, 7); ctx.fill();
    const cy = Math.cos(t), sy = Math.sin(t), cx = Math.cos(0.35), sx = Math.sin(0.35);
    const orbit = nodes.map((node, i) => {
      const a = t * 1.3 + i * Math.PI * 2 / nodes.length;
      const x = Math.cos(a) * R * 1.5, y = Math.sin(a) * R * 0.42;
      return { node, front: Math.sin(a) > 0, x: W / 2 + x * Math.cos(-0.25) - y * Math.sin(-0.25), y: H / 2 + x * Math.sin(-0.25) + y * Math.cos(-0.25) };
    });
    orbit.filter(o => !o.front).forEach(o => drawNode(o.node, o.x, o.y, false));
    for (const [x, y, z] of points) {
      let X = x * cy + z * sy, Z = -x * sy + z * cy; const Y = y * cx - Z * sx; Z = y * sx + Z * cx;
      const s = 0.55 + 0.45 * (Z + 1) / 2;
      ctx.globalAlpha = 0.12 + 0.7 * (Z + 1) / 2; ctx.fillStyle = Z > 0 ? accent : accent2;
      ctx.beginPath(); ctx.arc(W / 2 + X * R, H / 2 + Y * R, 2.2 * s, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 0.3; ctx.strokeStyle = accent; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(W / 2, H / 2, R * 1.5, R * 0.42, -0.25, 0, 7); ctx.stroke();
    orbit.filter(o => o.front).forEach(o => drawNode(o.node, o.x, o.y, true));
    ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (centerValue !== '') {
      ctx.fillStyle = ink; ctx.font = '600 30px "JetBrains Mono",ui-monospace,monospace'; ctx.fillText(String(centerValue), W / 2, H / 2 - 8);
      ctx.fillStyle = muted; ctx.font = '15px "PingFang SC","Microsoft YaHei",sans-serif'; ctx.fillText(centerLabel, W / 2, H / 2 + 20);
    }
    if (!still) { state.t += 0.005; state.frame = requestAnimationFrame(frame); }
  };
  frame();
}
