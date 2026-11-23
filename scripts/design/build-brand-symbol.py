from pathlib import Path
import re
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
source = ROOT / 'engines/video-studio/bundled/company-assets/Logo/智慧驱动-透明Logo.png'
image = cv2.imdecode(np.fromfile(source, dtype=np.uint8), cv2.IMREAD_UNCHANGED)[:, :454]
alpha = image[:, :, 3] > 140
ribbons = np.all(image[:, :, :3] > 220, axis=2) & alpha

def outline(mask, precision):
    contours, _ = cv2.findContours(mask.astype(np.uint8) * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    paths = []
    for contour in contours:
        if cv2.contourArea(contour) < 8:
            continue
        points = cv2.approxPolyDP(contour, precision, True)[:, 0, :]
        paths.append('M' + ' L'.join(f'{x * .198 + 5:.2f},{y * .198 + 4:.2f}' for x, y in points) + ' Z')
    return ' '.join(paths)

gear_path = outline(alpha, 1.8)
ribbon_path = outline(ribbons, 0.9)
css = (ROOT / 'public/theme.css').read_text(encoding='utf-8')
out = ROOT / 'public/branding'
out.mkdir(exist_ok=True)
for theme in ('day', 'night'):
    block = re.search(r'html\[data-theme="' + theme + r'"\]\{(.*?)\n\}', css, re.S).group(1)
    def color(token):
        return re.search(re.escape(token) + r':(#[0-9a-fA-F]{6})', block).group(1)
    primary, secondary, middle = [color(token) for token in ('--tk-acc', '--tk-acc2', '--tk-acc-mid')]
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="100" height="104" viewBox="0 0 100 104">
  <defs>
    <linearGradient id="surface" x1=".15" y1=".05" x2=".82" y2="1">
      <stop stop-color="{secondary}"/><stop offset=".48" stop-color="{middle}"/><stop offset="1" stop-color="{primary}"/>
    </linearGradient>
    <linearGradient id="depth" x2=".4" y2="1">
      <stop stop-color="{primary}"/><stop offset="1" stop-color="{primary}" stop-opacity=".65"/>
    </linearGradient>
    <linearGradient id="edge" x1=".12" y1="0" x2=".7" y2="1">
      <stop stop-color="#fff" stop-opacity=".8"/><stop offset=".48" stop-color="#fff" stop-opacity=".26"/><stop offset="1" stop-color="#fff" stop-opacity=".06"/>
    </linearGradient>
    <radialGradient id="glaze" cx=".27" cy=".1" r=".82">
      <stop stop-color="#fff" stop-opacity=".3"/><stop offset=".7" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ribbons" x2=".35" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#e6f8ff" stop-opacity=".93"/></linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="3" stdDeviation="2.1" flood-color="{primary}" flood-opacity=".19"/></filter>
    <path id="gear" d="{gear_path}"/>
    <path id="brain" d="{ribbon_path}"/>
  </defs>
  <g filter="url(#shadow)">
    <use href="#gear" fill="url(#depth)" transform="translate(0 3)"/>
    <use href="#gear" fill="url(#surface)" stroke="url(#edge)" stroke-width="1.4" stroke-linejoin="round"/>
    <use href="#gear" fill="url(#glaze)"/>
    <use href="#brain" fill="{primary}" opacity=".24" transform="translate(0 1)"/>
    <use href="#brain" fill="url(#ribbons)"/>
  </g>
</svg>
'''
    target = out / f'intellidriven-{theme}.svg'
    target.write_text(svg, encoding='utf-8')
    print(target.relative_to(ROOT), primary, secondary, middle)
