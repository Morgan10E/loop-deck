#!/usr/bin/env python3
"""Synthesize the bundled demo track: Beethoven's "Fur Elise".

The composition (1810) is in the public domain, and this recording is generated
from scratch here — no sampled or third-party audio — so the resulting WAV
carries no separate performance/recording copyright. Standard library only.

Usage:
    python3 tools/make-demo.py
    -> writes ../assets/fur-elise.wav relative to this file
"""
import math
import os
import struct
import wave

SR = 22050            # sample rate (mono keeps the file small)
EIGHTH = 0.22         # seconds per eighth-note (our base beat unit)

SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def midi(note):
    """'E5' / 'D#5' / 'A4' -> MIDI number. 'R' -> None (rest)."""
    if note == "R":
        return None
    letter = note[0]
    acc = 0
    i = 1
    if note[i] in "#b":
        acc = 1 if note[i] == "#" else -1
        i += 1
    octave = int(note[i:])
    return (octave + 1) * 12 + SEMI[letter] + acc


def freq(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


# --- The score: (note, duration-in-eighths) -------------------------------
# Opening theme of Fur Elise, arranged monophonically. The A-theme recurs,
# which is handy for demonstrating loops.
THEME_A = [
    ("E5", 1), ("D#5", 1), ("E5", 1), ("D#5", 1), ("E5", 1),
    ("B4", 1), ("D5", 1), ("C5", 1), ("A4", 2), ("R", 1),
    ("C4", 1), ("E4", 1), ("A4", 1), ("B4", 2), ("R", 1),
    ("E4", 1), ("G#4", 1), ("B4", 1), ("C5", 2), ("R", 1),
]
THEME_A2 = [
    ("E4", 1),  # pickup
    ("E5", 1), ("D#5", 1), ("E5", 1), ("D#5", 1), ("E5", 1),
    ("B4", 1), ("D5", 1), ("C5", 1), ("A4", 2), ("R", 1),
    ("C4", 1), ("E4", 1), ("A4", 1), ("B4", 2), ("R", 1),
    ("E4", 1), ("C5", 1), ("B4", 1), ("A4", 3), ("R", 2),
]

# Two passes through the theme so the demo is long enough to drop several loops.
SCORE = THEME_A + THEME_A2 + THEME_A + THEME_A2

# Additive timbre: harmonic number -> relative amplitude.
HARMONICS = [(1, 1.0), (2, 0.5), (3, 0.28), (4, 0.13), (6, 0.06)]


def envelope(t, dur):
    """Plucked music-box envelope: fast attack, exponential decay, short release."""
    attack = 0.006
    release = 0.04
    if t < attack:
        amp = t / attack
    else:
        amp = math.exp(-3.2 * (t - attack))  # decay
    if t > dur - release:                     # fade tail to avoid clicks
        amp *= max(0.0, (dur - t) / release)
    return amp


def render_note(m, dur):
    n = int(dur * SR)
    out = [0.0] * n
    if m is None:
        return out
    f = freq(m)
    two_pi = 2 * math.pi
    for i in range(n):
        t = i / SR
        e = envelope(t, dur)
        if e <= 0:
            continue
        s = 0.0
        for h, amp in HARMONICS:
            s += amp * math.sin(two_pi * f * h * t)
        out[i] = e * s
    return out


def main():
    samples = []
    for note, beats in SCORE:
        samples.extend(render_note(midi(note), beats * EIGHTH))

    peak = max((abs(s) for s in samples), default=1.0) or 1.0
    scale = 0.85 / peak  # headroom so nothing clips

    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "..", "assets", "fur-elise.wav")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for s in samples:
            v = int(max(-1.0, min(1.0, s * scale)) * 32767)
            frames += struct.pack("<h", v)
        w.writeframes(bytes(frames))

    print("wrote", os.path.normpath(path))
    print("duration", round(len(samples) / SR, 2), "s")
    print("size", round(len(samples) * 2 / 1024, 1), "KB")


if __name__ == "__main__":
    main()
