"""Run the frozen shot gate on a blind v2 video and its authored brief."""

import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

from filelock import FileLock

from ballots import ballot
from provider import assess_board, first_pass
from technical import inspect_technical


def contract(brief):
    captions = brief.get("copy", [])
    claims = list(brief.get("facts", []))
    claims.extend("镜头脚本要求：" + text for text in brief["requirements"])
    claims.extend("验收项：" + c["dimension"] + "；" + c["expected"] for c in brief.get("checks", []))
    claims.extend("指定字幕：" + text for text in captions)
    product = dict(brief["product"], facts=[{"claim": x} for x in claims])
    context = (
        "产品："
        + product["name"]
        + "。\n外观："
        + product["appearance"]
        + "。\n"
        + "\n".join(claims)
        + "\n片中编排字幕（仍须核对事实）："
        + ("、".join(captions) or "无")
    )
    return product, context


def decision(first, signals, known, technical, review_view):
    current = known(technical["issues"], signals["numeric"], first)
    verdict, issues = current["verdict"], current["issues"]
    receipts = [first["job_id"]]
    if verdict in ("PASS", "UNCERTAIN") and (signals["jumps"] or signals["repeats"]):
        second = review_view("assisted")
        receipts.append(second.get("job_id"))
        verdict = second["verdict"]
        if verdict == "FAIL":
            uniform = review_view("uniform")
            receipts.append(uniform.get("job_id"))
            issues = [
                a
                for a in second["issues"]
                if uniform["verdict"] == "FAIL"
                and a.get("subtype")
                and any(
                    a["subtype"] == b.get("subtype") and abs(a["t"] - b["t"]) <= 1 for b in uniform["issues"]
                )
            ]
            verdict = "FAIL" if issues else "UNCERTAIN"
    return {"verdict": verdict.lower(), "issues": issues, "receipts": receipts}


def review(video, brief, state_root):
    import evidence as ev

    with video.open("rb") as stream:
        sha = hashlib.file_digest(stream, "sha256").hexdigest()
    product, context = contract(brief)
    config = {
        k: os.getenv(k)
        for k in (
            "REVIEW_MODEL",
            "AICENTRE_REVIEW_CHANNEL",
            "AICENTRE_BASE_URL",
            "FROZEN_BOARD_MODEL",
            "FROZEN_BOARD_BASE",
        )
    }
    from identity import fingerprint
    version = fingerprint("frozen")
    identity = json.dumps([version, sha, brief, config], ensure_ascii=False, sort_keys=True)
    key = hashlib.sha256(identity.encode()).hexdigest()
    state = state_root / key
    state.mkdir(parents=True, exist_ok=True)
    with FileLock(str(state / "review.lock"), timeout=1200):
        first = first_pass(video, context, state)
        r = {"blind_id": key, "video": str(video), "contract": product}
        ev.extract(r)
        ev.run_ocr([r])
        signals = ev.probes(r)
        technical = inspect_technical(video)

        def review_view(mode):
            text = (
                product["name"]
                + "；"
                + product["appearance"]
                + "\n"
                + "\n".join(x["claim"] for x in product["facts"])
            )
            if mode == "assisted":
                cue = {
                    "相对邻帧变化突出的秒数": [signals["times"][i] for i in signals["jumps"]],
                    "外观相似且运动的两个起点": [
                        [signals["times"][i], signals["times"][j]] for _, i, j in signals["repeats"]
                    ],
                    "画面OCR带单位的原始行": signals["visible"][:18],
                }
                text += "\n程序候选观察：" + json.dumps(cue, ensure_ascii=False)

            def check(payload):
                a = ballot(payload)
                for issue in a["issues"]:
                    if (
                        issue.get("subtype") not in ev.tax[issue["category"]]["subs"]
                        or not 0 <= issue["t"] <= signals["times"][-1] + 0.05
                    ):
                        raise ValueError("Invalid local evidence")
                return a

            try:
                return assess_board(ev.sheet(r, signals, mode), text, check, ev.SCHEMA, state, mode)
            except (OSError, RuntimeError, ValueError, KeyError) as exc:
                raise RuntimeError(f"{mode}: {type(exc).__name__}") from exc

        out = decision(first, signals, ev.known, technical, review_view)
        brief_hash = hashlib.sha256(json.dumps(brief, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        out.update(reviewer="frozen-shot-v1", fingerprint=version, media_sha256=sha, brief_sha256=brief_hash)
        return out


if __name__ == "__main__":
    request = json.load(sys.stdin)
    with tempfile.TemporaryDirectory(prefix="frozen-shot-") as scratch:
        os.environ["FROZEN_SCRATCH"] = scratch
        print(
            json.dumps(
                review(Path(request["video"]), request["brief"], Path(request["state"])), ensure_ascii=False
            )
        )
