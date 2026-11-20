from pathlib import Path
from collections import defaultdict
import json
import os
import re
import subprocess
import tempfile
import unicodedata

import numpy as np
from PIL import Image, ImageDraw, ImageOps

PACKAGE = Path(__file__).resolve().parent
OUT = Path(os.environ["FROZEN_SCRATCH"])
tax = json.loads((PACKAGE.parents[1] / "taxonomy.json").read_text(encoding="utf8"))["categories"]


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf8")


def ff(args):
    return subprocess.run(args, check=True, capture_output=True, timeout=120)


def extract(r):
    k = r["blind_id"]
    folder = OUT / "frames" / k
    detail = folder / "signals.json"
    if detail.exists():
        return
    folder.mkdir(parents=True, exist_ok=True)
    path = r["video"]
    data = ff(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
            path,
        ]
    )
    pts = [float(i["best_effort_timestamp_time"]) for i in json.loads(data.stdout)["frames"]]
    chosen = [0]
    for i, t in enumerate(pts[1:], 1):
        if t >= pts[chosen[-1]] + 0.24999:
            chosen.append(i)
    if chosen[-1] != len(pts) - 1:
        chosen.append(len(pts) - 1)
    select = "+".join(f"eq(n,{i})" for i in chosen)
    ff(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-threads",
            "1",
            "-i",
            path,
            "-vf",
            f"select='{select}',scale='min(640,iw)':-2",
            "-threads",
            "1",
            "-fps_mode",
            "passthrough",
            "-q:v",
            "3",
            str(folder / "%04d.jpg"),
        ]
    )
    times = [round(pts[i] - pts[0], 4) for i in chosen]
    assert len(list(folder.glob("*.jpg"))) == len(times)
    small = np.stack(
        [
            np.asarray(Image.open(folder / f"{i+1:04d}.jpg").convert("L").resize((48, 32)), dtype=float)
            for i in range(len(times))
        ]
    )
    dist = np.abs(small[:, None] - small).mean(axis=(2, 3))
    motion = np.diag(dist, 1)
    typical = np.median(motion) if motion.size else 0.0
    jumps = [i + 1 for i, d in enumerate(motion) if d >= max(15, 4 * typical)]
    jumps = sorted(jumps, key=lambda i: -motion[i - 1])[:3]
    repeats = []
    for j in range(1, len(times) - 2):
        for i in range(j):
            if times[j] - times[i] < 1 or times[j + 2] - times[j] < 0.4:
                continue
            score = float(np.mean([dist[i + h, j + h] for h in range(3)]))
            if score <= 3 and min(np.mean(motion[i : i + 2]), np.mean(motion[j : j + 2])) >= 3:
                repeats.append((round(score, 3), i, j))
    repeats = sorted(repeats)[:1]
    write(detail, dict(times=times, jumps=jumps, repeats=repeats, median_motion=round(float(typical), 3)))


def frame(r, i):
    return OUT / "frames" / r["blind_id"] / f"{i+1:04d}.jpg"


def run_ocr(chunk):
    folder = OUT / "ocr"
    folder.mkdir(exist_ok=True)
    tasks = []
    span = {}
    for r in chunk:
        k = r["blind_id"]
        if (folder / (k + ".json")).exists():
            continue
        t = read(frame(r, 0).parent / "signals.json")["times"]
        inds = list(range(0, len(t), 4))
        if len(t) - 1 not in inds:
            inds.append(len(t) - 1)
        span[k] = [(f"{k}_{i}", t[i]) for i in inds]
        tasks.extend(dict(image_id=f"{k}_{i}", url=str(frame(r, i))) for i in inds)
    if not tasks:
        return
    backend=os.getenv("AUDIT_OCR") or ("windows" if os.name=="nt" else "tesseract")
    if backend=="tesseract":
        lang=os.getenv("TESSERACT_LANG") or "chi_sim+eng"
        byid={}
        for item in tasks:
            res=ff(["tesseract",item["url"],"stdout","-l",lang,"--psm","11"])
            # Tesseract may exit successfully after silently dropping one language.
            if b"Failed loading language" in res.stderr:
                raise RuntimeError("Missing requested Tesseract language data")
            byid[item["image_id"]]=res.stdout.decode("utf8").splitlines()
        for k,items in span.items():
            write(folder/(k+".json"),[dict(t=t,lines=byid[f]) for f,t in items])
        return
    if backend!="windows":
        raise ValueError("Unknown OCR backend")
    with tempfile.TemporaryDirectory(dir=folder) as tmp:
        manifest = Path(tmp) / "queue.json"
        write(manifest, {"images": tasks})
        res = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(PACKAGE / "ocr.ps1"),
                "-Manifest",
                str(manifest),
            ],
            capture_output=True,
            timeout=540,
            check=True,
        )
    byid = {
        x["image_id"]: [y["text"] for y in x.get("items", [])]
        for x in json.loads(res.stdout.decode("utf-8-sig"))["results"]
    }
    for k, items in span.items():
        write(folder / (k + ".json"), [dict(t=t, lines=byid[f]) for f, t in items])


def numbers(text):
    s = re.sub(r"\s+", "", unicodedata.normalize("NFKC", text).lower())
    result = []
    for m in re.finditer(r"(?<![\d.])(\d+(?:\.\d+)?)(毫升|ml|瓦特|瓦|w|小时|hours?|hrs?|h|克|g)(?![a-z])", s):
        u = m[2]
        unit = (
            "ml"
            if u in ("ml", "毫升")
            else "w" if u in ("瓦特", "瓦", "w") else "g" if u in ("克", "g") else "h"
        )
        result.append((float(m[1]), unit))
    return result


def known(tech_issues, ocr_issues, model):
    confirmed = list(tech_issues) + list(ocr_issues)
    if model["verdict"] == "FAIL":
        for issue in model["issues"]:
            dup = False
            if issue["category"] == "PF" and ocr_issues:
                for o in ocr_issues:
                    if set(numbers(issue["note"])).intersection(numbers(o["observations"][0][1])) and any(
                        abs(t - issue["t"]) <= 1 for t, _ in o["observations"]
                    ):
                        dup = True
            if not dup:
                confirmed.append(issue)
    return dict(verdict="FAIL" if confirmed else model["verdict"], issues=confirmed)


def probes(r):
    k = r["blind_id"]
    frames = read(OUT / "ocr" / (k + ".json"))
    facts = r["contract"]["facts"]
    factvals = defaultdict(list)
    for fact in facts:
        s = fact["claim"]
        if s.startswith("镜头脚本"):
            continue
        for v, u in numbers(s):
            factvals[u].append((v, s))
    signals = defaultdict(list)
    visible = []
    for fr in frames:
        for line in fr["lines"]:
            if numbers(line):
                visible.append({"t": fr["t"], "quote": line})
            for v, u in numbers(line):
                refs = factvals[u]
                if len(refs) != 1:
                    continue
                ref, claim = refs[0]
                if ref == v:
                    continue
                if re.search("最大|最高|至多|不超过", claim) and v <= ref:
                    continue
                if u == "h" and not any(
                    word in "".join(line.split()) and word in claim
                    for word in ["续航", "保温", "工作", "播放"]
                ):
                    continue
                signals[(u, v, claim)].append((fr["t"], line))
    issues = []
    for (unit, v, claim), observations in signals.items():
        if len({t for t, line in observations}) < 2 or observations[-1][0] - observations[0][0] < 0.4:
            continue
        t, line = observations[0]
        issues.append(
            dict(
                category="PF",
                subtype="PF8",
                t=t,
                note=f"重复帧读到「{line}」，产品声明「{claim}」",
                source="numeric_ocr",
                observations=observations,
            )
        )
    detail = read(frame(r, 0).parent / "signals.json")
    return dict(numeric=issues, visible=visible, **detail)


def indices(s, mode):
    n = len(s["times"])
    count = min(8, n)
    uniform = list(np.linspace(0, n - 1, count).round().astype(int))
    if mode == "uniform":
        return uniform
    slots = [0, n - 1]
    for _, i, j in s["repeats"][:1]:
        slots.extend([i, i + 1, j, j + 1])
    for j in s["jumps"][:2]:
        slots.extend([j - 1, j])
    chosen = list(dict.fromkeys(slots))[:count]
    while len(chosen) < count:
        chosen.append(
            max((i for i in range(n) if i not in chosen), key=lambda i: min(abs(i - j) for j in chosen))
        )
    return sorted(chosen)


def sheet(r, s, mode):
    k = r["blind_id"]
    path = OUT / "boards" / mode / (k + ".jpg")
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    board = Image.new("RGB", (4 * 396, 2 * 314), "#202020")
    draw = ImageDraw.Draw(board)
    for j, i in enumerate(indices(s, mode)):
        im = Image.open(frame(r, i)).convert("RGB")
        w, h = im.size
        x = (j % 4) * 396
        y = (j // 4) * 314
        thumb = ImageOps.contain(im, (220, 278))
        board.paste(thumb, (x + (220 - thumb.width) // 2, y + 23))
        cx, cy = 0.5, 0.5
        if mode == "assisted" and i > 0:
            pre = Image.open(frame(r, i - 1)).convert("L").resize((60, 60))
            diff = np.abs(
                np.array(im.convert("L").resize((60, 60)), dtype=float) - np.array(pre, dtype=float)
            )
            _, yy, xx = max(
                (diff[jj : jj + 24, ii : ii + 24].mean(), jj, ii)
                for jj in range(0, 37, 6)
                for ii in range(0, 37, 6)
            )
            cx, cy = (xx + 12) / 60, (yy + 12) / 60
        roi = (int((cx - 0.2) * w), int((cy - 0.2) * h), int((cx + 0.2) * w), int((cy + 0.2) * h))
        crop = ImageOps.contain(im.crop(roi), (169, 255))
        board.paste(crop, (x + 222 + (169 - crop.width) // 2, y + 26))
        draw.text(
            (x + 3, y + 4), f't={s["times"][i]:.3f}s  FULL                         DETAIL', fill="white"
        )
    board.save(path, quality=92)
    return path


SCHEMA = (
    """你是第二道镜头证据核验员，输入是同一视频按时间排序的八格取证图，每格左边全景，右边是同帧放大。图上 t 是原视频的秒数。对照产品合同，逐项检查起始、关键接触方与部位、动作顺序、每个部件数量和终态，并分别检查结构、物理和字样。跨帧异常须说明前后可见状态。程序信号只用于找证据，跳切、重复纹理、OCR读数或未拍到的中间动作都不能单独证明有错。画面不能直接判断声音。若一个必要视觉条件确实无法判断，使用 UNCERTAIN。可以明确指出多处错误，每个时间点必须取自给出的时间戳。仅返回JSON：{"verdict":"PASS|FAIL|UNCERTAIN","summary":"观察依据","issues":[{"category":"一级代码","subtype":"下列二级代码","t":0.0,"note":"位置和可见证据"}]}。若无明确错误，issues 为空。分类字典："""
    + json.dumps({k: g["subs"] for k, g in tax.items()}, ensure_ascii=False)
)
