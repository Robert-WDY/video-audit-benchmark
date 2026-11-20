import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

HERE=Path(__file__).resolve().parent
FROZEN=HERE.parent/"frozen"
sys.path.append(str(FROZEN))
from filelock import FileLock
from method import evaluate
from provider import first_pass, save
from technical import inspect_technical
import importlib.util
spec=importlib.util.spec_from_file_location("frozen_gate",FROZEN/"review.py")
gate=importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

def execute(video,brief,state,first=None):
    import evidence as ev
    from identity import fingerprint
    sha=hashlib.file_digest(video.open("rb"),"sha256").hexdigest()
    briefsha=hashlib.sha256(json.dumps(brief,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    version=fingerprint("candidate")
    state=state/hashlib.sha256((version+sha+briefsha).encode()).hexdigest()
    state.mkdir(parents=True,exist_ok=True)
    with FileLock(str(state/"lock"),timeout=2500):
        result=state/"result.json"
        if result.exists():
            return json.loads(result.read_text(encoding="utf8"))
        product,context=gate.contract(brief)
        if first is None:
            first=[]
            for i in range(3):
                p=state/str(i)
                p.mkdir(exist_ok=True)
                first.append(first_pass(video,context,p,temperature=0))
        r=dict(blind_id=sha,video=str(video),contract=product)
        ev.extract(r)
        ev.run_ocr([r])
        out=evaluate(video,brief,first,ev.probes(r),inspect_technical(video),state)
        out.update(reviewer="candidate-v2",fingerprint=version,media_sha256=sha,brief_sha256=briefsha)
        save(result,out)
        return out

if __name__=="__main__":
    req=json.load(sys.stdin)
    with tempfile.TemporaryDirectory(prefix="review-candidate-") as scratch:
        os.environ["FROZEN_SCRATCH"]=scratch
        print(json.dumps(execute(Path(req["video"]),req["brief"],Path(req["state"])),ensure_ascii=False))
