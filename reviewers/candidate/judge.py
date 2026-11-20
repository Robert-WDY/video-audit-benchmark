"""One independent visual judgment per round and stage. No answer keys in this interface."""
import base64
import hashlib
import json
import os
from pathlib import Path

import requests
from provider import save


def ask(state, stage, text, pictures=()):
    content=[{"type":"text","text":"仅输出 JSON。\n"+text}]
    for path in pictures:
        data=base64.b64encode(path.read_bytes()).decode("ascii")
        content.append({"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+data}})
    body={"model":os.environ["FROZEN_BOARD_MODEL"],"messages":[{"role":"user","content":content}],
          "temperature":0,"max_tokens":4000,"response_format":{"type":"json_object"},"thinking":{"type":"disabled"}}
    key=hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest()
    path=state/(stage+"-"+key+".json")
    if path.exists():
        return json.loads(path.read_text(encoding="utf8"))
    res=requests.post(os.environ["FROZEN_BOARD_BASE"].rstrip("/")+"/chat/completions",
        headers={"Authorization":"Bearer "+os.environ["FROZEN_BOARD_KEY"]},json=body,timeout=150)
    if not res.ok:
        raise RuntimeError(f"{stage}: HTTP {res.status_code}")
    reply=res.json()
    try:
        data=json.loads(reply["choices"][0]["message"]["content"])
        assert isinstance(data,dict)
    except (ValueError,KeyError,TypeError,AssertionError):
        data={"invalid":True}
    result={"data":data,"receipt":reply["id"],"model":reply.get("model",body["model"])}
    save(path,result)
    return result
