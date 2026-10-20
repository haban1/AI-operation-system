from __future__ import annotations

import math
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
SLIDES = OUT / "slides"
SEGMENTS = OUT / "segments"
FFMPEG = ROOT / ".tmp" / "ffmpeg-tool" / "node_modules" / "@ffmpeg-installer" / "win32-x64" / "ffmpeg.exe"

W, H = 1080, 1920
FPS = 24
SEGMENT_SECONDS = 2.5
VIDEO_NAME = "community-activity-guide-1080x1920.mp4"

FONT_REGULAR = Path(r"C:\Windows\Fonts\msyh.ttc")
FONT_BOLD = Path(r"C:\Windows\Fonts\msyhbd.ttc")


def font(size: int, bold: bool = False):
    return ImageFont.truetype(str(FONT_BOLD if bold else FONT_REGULAR), size=size)


def rounded_gradient(size, top, bottom, radius=40):
    w, h = size
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    for y in range(h):
        t = y / max(1, h - 1)
        rgb = [int(top[i] * (1-t) + bottom[i] * t) for i in range(3)]
        arr[y, :, :3] = rgb
        arr[y, :, 3] = 255
    img = Image.fromarray(arr, "RGBA")
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w-1, h-1), radius=radius, fill=255)
    img.putalpha(mask)
    return img


def background(index: int):
    top = np.array([7, 28, 54], dtype=np.float32)
    bottom = np.array([8, 78, 92], dtype=np.float32)
    y = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
    arr = top[None, None, :] * (1-y) + bottom[None, None, :] * y
    arr = np.repeat(arr, W, axis=1)

    # Soft cyan glow, shifted per slide for a subtle cinematic variation.
    yy, xx = np.mgrid[0:H, 0:W]
    cx = 150 + (index * 155) % 760
    cy = 340 + (index % 3) * 380
    dist = ((xx-cx)/680)**2 + ((yy-cy)/720)**2
    glow = np.exp(-dist * 3.0)[..., None]
    arr += glow * np.array([8, 50, 57], dtype=np.float32)
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr, "RGB").convert("RGBA")

    # Fine grid pattern.
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(0, W, 90):
        gd.line((x, 0, x, H), fill=(115, 226, 226, 14), width=1)
    for gy in range(0, H, 90):
        gd.line((0, gy, W, gy), fill=(115, 226, 226, 12), width=1)
    img = Image.alpha_composite(img, grid)

    # Decorative rings and dots, kept away from text-heavy central area.
    deco = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(deco)
    dd.ellipse((-220, 1320, 520, 2060), outline=(91, 231, 217, 45), width=3)
    dd.ellipse((-120, 1420, 410, 1950), outline=(91, 231, 217, 28), width=2)
    dd.ellipse((760, -150, 1230, 320), outline=(91, 231, 217, 35), width=3)
    for n in range(14):
        px = 780 + ((n * 67 + index * 31) % 250)
        py = 145 + ((n * 103) % 330)
        r = 3 + n % 3
        dd.ellipse((px-r, py-r, px+r, py+r), fill=(167, 247, 236, 80))
    return Image.alpha_composite(img, deco)


def draw_brand(draw):
    draw.rounded_rectangle((72, 92, 360, 154), radius=31, fill=(118, 239, 220, 36), outline=(131, 244, 226, 90), width=2)
    draw.ellipse((92, 110, 118, 136), fill=(112, 242, 219, 255))
    draw.text((135, 109), "社区便民指南", font=font(31, True), fill=(220, 255, 250, 245))


def draw_footer(draw, label="实用流程 · 建议收藏"):
    draw.line((72, 1660, 1008, 1660), fill=(177, 245, 234, 46), width=2)
    draw.text((72, 1710), label, font=font(31), fill=(199, 238, 235, 205))
    draw.text((72, 1780), "提前确认信息  ·  按公告指引参与", font=font(28), fill=(167, 214, 213, 155))


def save_title_slide(path):
    img = background(0)
    d = ImageDraw.Draw(img)
    draw_brand(d)
    d.text((72, 400), "社区活动", font=font(104, True), fill=(244, 255, 253, 255))
    d.text((72, 530), "报名指南", font=font(104, True), fill=(244, 255, 253, 255))
    d.rounded_rectangle((74, 690, 405, 760), radius=35, fill=(100, 239, 217, 235))
    d.text((111, 705), "四步轻松完成", font=font(35, True), fill=(5, 54, 61, 255))

    card = rounded_gradient((936, 510), (18, 70, 83), (12, 48, 68), 48)
    card.alpha_composite(Image.new("RGBA", card.size, (255, 255, 255, 8)))
    img.alpha_composite(card, (72, 900))
    d = ImageDraw.Draw(img)
    d.text((126, 980), "报名之前先看清", font=font(42, True), fill=(223, 255, 250, 255))
    bullets = ["活动时间与地点", "参与要求与所需信息", "报名截止时间"]
    for i, text in enumerate(bullets):
        y = 1075 + i * 90
        d.ellipse((128, y+13, 146, y+31), fill=(103, 240, 216, 255))
        d.text((174, y), text, font=font(35), fill=(213, 239, 237, 235))
    draw_footer(d)
    img.convert("RGB").save(path, quality=95)


def save_step_slide(path, idx, title, detail, accent):
    img = background(idx)
    d = ImageDraw.Draw(img)
    draw_brand(d)

    d.text((72, 310), f"0{idx}", font=font(176, True), fill=(*accent, 255))
    d.text((72, 525), title, font=font(82, True), fill=(244, 255, 253, 255))
    d.rounded_rectangle((72, 670, 1008, 1110), radius=48, fill=(9, 43, 59, 190), outline=(*accent, 92), width=2)

    # Simple native vector icon.
    ix, iy = 126, 742
    if idx == 1:  # notice board
        d.rounded_rectangle((ix, iy, ix+170, iy+190), radius=20, outline=(*accent, 255), width=8)
        d.line((ix+38, iy+56, ix+132, iy+56), fill=(*accent, 220), width=8)
        d.line((ix+38, iy+100, ix+132, iy+100), fill=(*accent, 180), width=8)
        d.line((ix+38, iy+144, ix+112, iy+144), fill=(*accent, 150), width=8)
    elif idx == 2:  # person/info
        d.ellipse((ix+52, iy, ix+120, iy+68), outline=(*accent, 255), width=8)
        d.arc((ix+20, iy+82, ix+152, iy+214), 190, 350, fill=(*accent, 255), width=9)
        d.line((ix+170, iy+42, ix+170, iy+180), fill=(*accent, 180), width=7)
        d.ellipse((ix+158, iy+8, ix+182, iy+32), fill=(*accent, 255))
    elif idx == 3:  # send/check
        d.polygon([(ix, iy+55), (ix+190, iy), (ix+130, iy+190), (ix+88, iy+112)], outline=(*accent, 255), fill=(*accent, 38))
        d.line((ix+88, iy+112, ix+190, iy), fill=(*accent, 255), width=8)
        d.line((ix+42, iy+155, ix+82, iy+195), fill=(*accent, 255), width=9)
        d.line((ix+82, iy+195, ix+154, iy+126), fill=(*accent, 255), width=9)
    else:  # bell
        d.arc((ix+25, iy+16, ix+165, iy+176), 190, 350, fill=(*accent, 255), width=9)
        d.line((ix+25, iy+96, ix+5, iy+170), fill=(*accent, 255), width=9)
        d.line((ix+165, iy+96, ix+185, iy+170), fill=(*accent, 255), width=9)
        d.line((ix+5, iy+170, ix+185, iy+170), fill=(*accent, 255), width=9)
        d.arc((ix+70, iy+165, ix+120, iy+215), 0, 180, fill=(*accent, 255), width=8)

    # Wrap detail into two lines where needed.
    chunks = detail.split("｜")
    for n, line in enumerate(chunks):
        d.text((370, 770 + n*82), line, font=font(39 if n == 0 else 34, n == 0), fill=(224, 247, 244, 244 if n == 0 else 205))

    d.text((72, 1220), "完成这一项后，再进入下一步", font=font(35), fill=(191, 230, 227, 205))
    # Four-step progress indicator.
    for n in range(1, 5):
        x = 72 + (n-1)*238
        active = n <= idx
        color = (*accent, 255) if active else (129, 184, 184, 85)
        d.rounded_rectangle((x, 1325, x+190, 1343), radius=9, fill=color)
        d.text((x, 1370), f"0{n}", font=font(28, True), fill=color)
    draw_footer(d, f"第 {idx} 步 / 共 4 步")
    img.convert("RGB").save(path, quality=95)


def save_end_slide(path):
    img = background(5)
    d = ImageDraw.Draw(img)
    draw_brand(d)
    d.text((72, 390), "提前规划", font=font(104, True), fill=(244, 255, 253, 255))
    d.text((72, 525), "从容参与", font=font(104, True), fill=(110, 241, 219, 255))
    d.rounded_rectangle((72, 780, 1008, 1190), radius=52, fill=(9, 43, 59, 192), outline=(112, 242, 220, 90), width=2)
    d.text((126, 865), "查看公告  →  准备信息", font=font(43, True), fill=(229, 251, 248, 245))
    d.text((126, 960), "提交报名  →  留意通知", font=font(43, True), fill=(229, 251, 248, 245))
    d.rounded_rectangle((126, 1070, 498, 1140), radius=35, fill=(101, 238, 216, 235))
    d.text((171, 1085), "收藏这份流程", font=font(34, True), fill=(5, 54, 61, 255))
    draw_footer(d, "转给有需要的邻里朋友")
    img.convert("RGB").save(path, quality=95)


def create_audio(path: Path, seconds: float):
    rate = 44100
    t = np.arange(int(rate * seconds), dtype=np.float64) / rate
    # Quiet, original ambient bed: warm triad plus sparse bell pulses.
    audio = 0.035*np.sin(2*np.pi*220*t) + 0.024*np.sin(2*np.pi*277.18*t) + 0.018*np.sin(2*np.pi*329.63*t)
    audio *= 0.55 + 0.45*np.sin(np.pi*np.minimum(t/2.0, 1.0))
    for start, freq in [(0.4, 659.25), (2.9, 523.25), (5.4, 659.25), (7.9, 783.99), (10.4, 659.25), (12.9, 880.0)]:
        dt = t-start
        pulse = (dt >= 0) * np.exp(-np.maximum(dt, 0)*3.2) * np.sin(2*np.pi*freq*np.maximum(dt, 0))
        audio += 0.045*pulse
    # Fade out.
    fade = np.ones_like(t)
    fade[t > seconds-1.2] = np.maximum(0, (seconds-t[t > seconds-1.2])/1.2)
    audio *= fade
    pcm = np.int16(np.clip(audio, -1, 1)*32767)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm.tobytes())


def run(cmd):
    print("RUN:", " ".join(map(str, cmd)))
    subprocess.run([str(x) for x in cmd], check=True)


def main():
    if not FFMPEG.exists():
        raise FileNotFoundError(f"FFmpeg not found: {FFMPEG}")
    shutil.rmtree(SLIDES, ignore_errors=True)
    shutil.rmtree(SEGMENTS, ignore_errors=True)
    SLIDES.mkdir(parents=True)
    SEGMENTS.mkdir(parents=True)

    slide_paths = [SLIDES / f"slide-{i:02d}.png" for i in range(1, 7)]
    save_title_slide(slide_paths[0])
    steps = [
        (1, "查看活动公告", "确认时间、地点｜以及参与要求", (102, 235, 215)),
        (2, "准备报名信息", "按公告要求整理｜必要的报名资料", (109, 220, 247)),
        (3, "按指引提交", "核对填写内容｜在截止前提交", (143, 225, 196)),
        (4, "留意后续通知", "关注确认信息｜及时查看活动提醒", (121, 226, 240)),
    ]
    for i, title, detail, accent in steps:
        save_step_slide(slide_paths[i], i, title, detail, accent)
    save_end_slide(slide_paths[5])
    shutil.copy2(slide_paths[0], OUT / "community-activity-guide-cover.png")

    frames = int(FPS * SEGMENT_SECONDS)
    segment_paths = []
    for i, slide in enumerate(slide_paths, 1):
        seg = SEGMENTS / f"segment-{i:02d}.mp4"
        segment_paths.append(seg)
        # Gentle zoom; H.264/yuv420p guarantees broad platform compatibility.
        zoom = "min(zoom+0.00055,1.035)" if i % 2 else "if(lte(zoom,1.0),1.035,max(1.0,zoom-0.00055))"
        vf = f"zoompan=z='{zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={W}x{H}:fps={FPS},format=yuv420p"
        run([FFMPEG, "-y", "-loop", "1", "-i", slide, "-vf", vf, "-frames:v", str(frames), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", seg])

    concat_file = OUT / "segments.txt"
    concat_file.write_text("".join(f"file '{p.as_posix()}'\n" for p in segment_paths), encoding="utf-8")
    silent_video = OUT / "video-silent.mp4"
    run([FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", concat_file, "-c", "copy", silent_video])

    audio = OUT / "background.wav"
    create_audio(audio, len(slide_paths)*SEGMENT_SECONDS)
    final = OUT / VIDEO_NAME
    run([FFMPEG, "-y", "-i", silent_video, "-i", audio, "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", final])

    # Keep reusable source slides and script, remove only intermediate encodes/audio.
    shutil.rmtree(SEGMENTS, ignore_errors=True)
    concat_file.unlink(missing_ok=True)
    silent_video.unlink(missing_ok=True)
    audio.unlink(missing_ok=True)
    print(f"Created: {final}")


if __name__ == "__main__":
    main()
