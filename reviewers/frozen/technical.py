from pathlib import Path
import json
import re
import subprocess


def tool(command, timeout=90):
    return subprocess.run(command, check=True, capture_output=True, timeout=timeout)


def inspect_technical(path, *, audio_required=False, allow_flash=False, allow_hold=False):
    """Run deterministic measurements before applying shot-specific eligibility rules."""
    path = str(Path(path).resolve())
    probe = json.loads(
        tool(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=codec_type,r_frame_rate",
                "-of",
                "json",
                path,
            ]
        ).stdout
    )
    duration = float(probe["format"]["duration"])
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    has_audio = any(s["codec_type"] == "audio" for s in probe["streams"])
    n, d = map(int, video["r_frame_rate"].split("/"))
    fps = n / d if n and d else 24

    log = tool(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-threads",
            "1",
            "-i",
            path,
            "-vf",
            "blackdetect=d=0.18:pix_th=0.10,freezedetect=n=0.003:d=0.8",
            *(["-af", "silencedetect=n=-50dB:d=0.5"] if has_audio else []),
            "-f",
            "null",
            "-",
        ]
    ).stderr.decode("utf8", "replace")
    black = [
        (float(a), float(b)) for a, b in re.findall(r"black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)", log)
    ]

    def segments(prefix):
        starts = [float(x) for x in re.findall(prefix + r"_start:\s*(-?[\d.]+)", log)]
        ends = [float(x) for x in re.findall(prefix + r"_end:\s*([\d.]+)", log)]
        return [(max(0, s), min(duration, e)) for s, e in zip(starts, ends + [duration] * len(starts))]

    freezes = [(s, e) for s, e in segments("freeze") if e - s >= 1.0 - 1e-6]
    silence = segments("silence") if has_audio else [(0.0, duration)]

    sampled = tool(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-v",
            "info",
            "-threads",
            "1",
            "-i",
            path,
            "-an",
            "-vf",
            "scale=48:27,format=gray,showinfo",
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-threads",
            "1",
            "pipe:1",
        ]
    )
    raw = sampled.stdout
    frame_times = [
        float(t)
        for t in re.findall(
            rb"\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[0-9.]+(?:e[-+]?\d+)?)", sampled.stderr
        )
    ]
    size = 48 * 27
    if not frame_times or len(frame_times) * size != len(raw):
        raise ValueError("Cannot align decoded video frames with their timestamps")
    first_frame = frame_times[0]
    frame_times = [t - first_frame for t in frame_times]
    means, flats = [], []
    for i in range(0, len(raw) - size + 1, size):
        frame = raw[i : i + size]
        means.append(sum(frame) / size)
        flats.append(sum(v >= 246 for v in frame) / size > 0.96 or sum(v <= 9 for v in frame) / size > 0.96)
    flashes = []
    if not allow_flash:
        i = 1
        while i < len(means) - 1:
            if not flats[i]:
                i += 1
                continue
            start = i
            while i < len(means) and flats[i]:
                i += 1
            if i >= len(means) or frame_times[i] - frame_times[start] > 0.15:
                continue
            a, b, flash = means[start - 1], means[i], means[start]
            if abs(a - b) <= 20 and min(abs(a - flash), abs(b - flash)) >= 75:
                flashes.append((frame_times[start], frame_times[i - 1]))

    issues = []

    def add(sub, windows, label):
        for start, end in windows:
            issues.append(
                {
                    "category": "TE",
                    "subtype": sub,
                    "t": round(start, 3),
                    "end_s": round(end, 3),
                    "note": f"{label}，{start:.3f}–{end:.3f} 秒",
                    "source": "frame_audio_probe",
                }
            )

    add("TE1", black, "连续黑场")
    if not allow_hold:
        add("TE2", freezes, "连续冻结")
    add("TE4", flashes, "孤立的全幅亮／暗闪帧")
    quiet = sum(e - s for s, e in silence)
    if audio_required and quiet / max(duration, 0.001) >= 0.98:
        add("TE3", [(0, duration)], "镜头要求有声，音轨近乎全静音")
    return {
        "duration_s": duration,
        "fps": fps,
        "has_audio": has_audio,
        "observed_silent_s": round(quiet, 3),
        "audio_required": audio_required,
        "issues": issues,
    }
