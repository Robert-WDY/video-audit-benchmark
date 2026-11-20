import hashlib
import json
import os
from pathlib import Path

def fingerprint(mode):
    root=Path(__file__).resolve().parent.parent
    paths=[root.parent/"taxonomy.json",root.parent/"v2"/"taxonomy.json"]
    for name in (["frozen","candidate"] if mode=="candidate" else ["frozen"]):
        paths.extend(p for p in (root/name).iterdir() if p.suffix in {".py",".mjs",".ps1",".txt"} and not p.name.startswith("test"))
    digest=hashlib.sha256()
    for path in sorted(paths):
        digest.update(path.relative_to(root.parent).as_posix().encode()+b"\0"+path.read_bytes()+b"\0")
    config={k:os.getenv(k) for k in ("REVIEW_MODEL","AICENTRE_BASE_URL","AICENTRE_REVIEW_CHANNEL","FROZEN_BOARD_BASE","FROZEN_BOARD_MODEL","AUDIT_OCR","TESSERACT_LANG")}
    digest.update(json.dumps(config,sort_keys=True).encode())
    return digest.hexdigest()
