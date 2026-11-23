"""Regenerate the original Steady Type stems; Python 3 and NumPy, no samples."""

import json
from pathlib import Path
import wave

import numpy as np


HERE = Path(__file__).resolve().parent
SR = 44100
SAMPLES = SR * 15


def generate():
    catalog = json.loads((HERE.parent / "catalog.json").read_text(encoding="utf-8"))
    template = next(item for item in catalog if item["id"] == "steady-type")
    track = template["soundtrack"]
    beat = 60 / track["bpm"]
    music = np.zeros((SAMPLES, 2))
    sfx = np.zeros_like(music)
    rng = np.random.default_rng(627)

    def grid(seconds):
        return np.arange(round(SR * seconds)) / SR

    def add(stem, t, sound, pan=0):
        start = round(SR * t)
        count = min(len(sound), SAMPLES - start)
        if count > 0:
            stem[start:start + count] += sound[:count, None] * np.array([1 - pan, 1 + pan])

    for n in range(32):
        t = n * beat
        x = grid(.31)
        kick = np.sin(2 * np.pi * (49 * x + 4.7 * (1 - np.exp(-32 * x)))) * np.exp(-14 * x)
        if n % 4 != 3 or n > 22:
            add(music, t, kick * .65)
        if n % 4 in (1, 3):
            x = grid(.17)
            noise = np.r_[0, np.diff(rng.standard_normal(len(x)))]
            snare = noise * .22 + np.sin(2 * np.pi * 184 * x) * .23
            add(music, t, snare * np.exp(-24 * x) * .68)
        subdivisions = 4 if n in (7, 15, 23) else 2
        for h in range(subdivisions):
            x = grid(.064)
            hat = np.r_[0, np.diff(rng.standard_normal(len(x)))] * np.exp(-75 * x)
            add(music, t + h * beat / subdivisions, hat * .105, (-1) ** n * .24)

        root = [130.81, 103.83, 155.56, 116.54][n // 8]
        x = grid(.30)
        env = np.minimum(1, x / .009) * np.exp(-11 * x) * np.minimum(1, (.30 - x) / .035)
        bass = np.sin(2 * np.pi * root / 2 * x) + .19 * np.sin(2 * np.pi * root * x)
        add(music, t + .012, bass * env * .39)
        notes = [(.5, [2, 3, 2.5, 3.75][n % 4])]
        if n % 4 == 2:
            notes.append((.75, 4))
        for offset, ratio in notes:
            x = grid(.29)
            env = np.minimum(1, x / .004) * np.exp(-14 * x) * np.minimum(1, (.29 - x) / .04)
            pluck = sum(np.sin(2 * np.pi * root * ratio * h * x) / h ** 1.7 for h in (1, 2, 3))
            add(music, t + offset * beat, pluck * env * .16, (-1) ** n * .32)

    for cue in track["cues"]:
        x = grid(.18)
        sweep = np.r_[0, np.diff(rng.standard_normal(len(x)))]
        env = np.minimum(1, (x / .16) ** 2) * np.minimum(1, (.18 - x) / .02)
        add(sfx, cue["cutFrame"] / 30 - .16, sweep * env * .07)

    music = np.tanh(music * 1.35)
    music *= np.minimum(1, np.arange(SAMPLES)[::-1] / (SR * .16))[:, None]
    # Preserve headroom even when operators audition both stems at full gain.
    gain = .91 / max(1, np.abs(music + sfx).max(), np.abs(music).max(), np.abs(sfx).max())
    for stem, name in [(music, track["musicFile"]), (sfx, track["sfxFile"])]:
        with wave.open(str(HERE / name), "wb") as out:
            out.setparams((2, 2, SR, SAMPLES, "NONE", "not compressed"))
            out.writeframes(np.rint(stem * gain * 32767).astype("<i2").tobytes())


if __name__ == "__main__":
    generate()
