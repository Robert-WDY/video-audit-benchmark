"""Visual review transports. Persistent state contains job IDs, not API credentials."""

import base64
import hashlib
import json
import os
import time
from uuid import uuid4

import requests

from ballots import SCHEMA, ballot


def save(path, value):
    tmp = path.with_name(path.name + "." + uuid4().hex + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf8")
    tmp.replace(path)


def first_pass(video, context, state, *, temperature=None, media_url=None):
    base = os.environ["AICENTRE_BASE_URL"].rstrip("/")
    token = os.environ["AICENTRE_API_KEY"]
    model = os.getenv("REVIEW_MODEL") or "qwen3.8-omni-flash"
    channel = os.getenv("AICENTRE_REVIEW_CHANNEL") or "dashscope"
    endpoint = base + "/v1/text-generations/jobs"
    headers = {"Authorization": "Bearer " + token}
    path = state / "first.json"
    rec = json.loads(path.read_text(encoding="utf8")) if path.exists() else {}
    if "answer" in rec:
        return rec["answer"]
    if not rec.get("job_id"):
        if media_url is None:
            with video.open("rb") as stream:
                upload = requests.post(
                    base + "/v1/uploads", headers=headers, files={"file": ("asset.mp4", stream)}, timeout=180
                )
            upload.raise_for_status()
            media_url = upload.json()["url"]
        body = {
            "model": model,
            "channel": channel,
            "prompt": SCHEMA + "\n\n本次镜头的产品事实与制作要求：\n" + context.strip(),
            "reference_video_urls": [media_url],
            "max_tokens": 2000,
            "external_ref": rec.get("external_ref") or "visual-qa-" + uuid4().hex[:25],
        }
        if temperature is not None:
            body["temperature"] = temperature
        rec = {"external_ref": body["external_ref"], "temperature": temperature}
        save(path, rec)
        for admission in range(13):
            # AI Centre binds the same external_ref to the job's idempotency key.
            # A lost response or a concurrency rejection must retain this identity.
            response = requests.post(endpoint, json=body, headers={**headers, "Idempotency-Key": rec["external_ref"]}, timeout=90)
            if response.status_code != 429 or "concurrency" not in response.text.lower() or admission == 12:
                break
            time.sleep(min(2**admission, 12))
        response.raise_for_status()
        rec["job_id"] = response.json()["job_id"]
        save(path, rec)
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        try:
            result = requests.get(endpoint + "/" + rec["job_id"], headers=headers, timeout=30)
        except (requests.ConnectionError, requests.Timeout):
            time.sleep(3)
            continue
        if result.status_code in {429, 500, 502, 503, 504}:
            time.sleep(3)
            continue
        result.raise_for_status()
        data = result.json()
        if data.get("status") == "succeeded":
            upstream = data.get("upstream_response") or {}
            try:
                answer = ballot(upstream.get("plain") or upstream.get("text") or data.get("text") or "")
            except (ValueError, TypeError, AttributeError):
                answer = {"verdict": "UNCERTAIN", "summary": "模型返回的证据格式不足以判定", "issues": []}
            rec["answer"] = dict(answer, job_id=rec["job_id"], model=model)
            save(path, rec)
            return rec["answer"]
        if data.get("status") in {"failed", "cancelled", "canceled", "expired", "rejected"}:
            raise RuntimeError("Whole-video provider job did not succeed")
        time.sleep(2)
    raise TimeoutError("Whole-video job timed out")


def assess_board(image, context, check, schema, state, mode):
    model = os.environ["FROZEN_BOARD_MODEL"]
    content = [
        {"type": "text", "text": schema + "\n镜头合同：\n" + context},
        {
            "type": "image_url",
            "image_url": {
                "url": "data:image/jpeg;base64," + base64.b64encode(image.read_bytes()).decode("ascii")
            },
        },
    ]
    body = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.1,
        "max_tokens": 2000,
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
    }
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    cache = state / (mode + "-" + digest + ".json")
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf8"))
    url = os.environ["FROZEN_BOARD_BASE"].rstrip("/") + "/chat/completions"
    headers = {"Authorization": "Bearer " + os.environ["FROZEN_BOARD_KEY"]}
    res = requests.post(url, headers=headers, json=body, timeout=165)
    res.raise_for_status()
    response = res.json()
    try:
        answer = check(response["choices"][0]["message"]["content"])
    except (ValueError, TypeError, KeyError, AttributeError):
        answer = {"verdict": "UNCERTAIN", "summary": "证据字段或时间无效", "issues": []}
    answer.update(job_id=response["id"], model=response.get("model", model))
    save(cache, answer)
    return answer
