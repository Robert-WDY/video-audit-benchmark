import sys
import json
import os
import unittest
from unittest.mock import Mock, patch
import tempfile
from pathlib import Path
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/"src"),str(ROOT/"reviewers/candidate"),str(ROOT/"reviewers/frozen")]
from frames import proposals
from evidence_score import score,digest
from method import causal, evaluate
from provider import first_pass

class ReviewRegression(unittest.TestCase):
    def test_ambiguous_admission_reuses_the_recorded_key(self):
        answer={"verdict":"PASS","summary":"画面可辨","issues":[]}
        admitted=Mock(status_code=200)
        admitted.json.return_value={"job_id":"existing-job"}
        polled=Mock(status_code=200)
        polled.json.return_value={"status":"succeeded","text":json.dumps(answer)}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,AICENTRE_BASE_URL="https://example.test",AICENTRE_API_KEY="test"), patch("provider.requests.post",return_value=admitted) as post, patch("provider.requests.get",return_value=polled) as get:
            state=Path(tmp)
            (state/"first.json").write_text(json.dumps({"external_ref":"prior-ref","temperature":0}),encoding="utf8")
            out=first_pass(None,"创意",state,temperature=0,media_url="https://example.test/video")
            self.assertEqual(out["job_id"],"existing-job")
            self.assertEqual(post.call_args.kwargs["headers"]["Idempotency-Key"],"prior-ref")
            self.assertEqual(post.call_args.kwargs["json"]["external_ref"],"prior-ref")
            self.assertTrue(get.call_args.args[0].endswith("/existing-job"))

    def test_transient_survives_three_unsubstantiated_fail_ballots(self):
        frames=np.zeros((9,64,96,3),dtype=np.uint8)
        frames[4,:16,32:48]=210
        first=[dict(job_id=str(i),verdict="FAIL",issues=[dict(t=0,note="静态字样错误")]) for i in range(3)]
        replies={"verify-0":{"items":[{"id":0,"state":"refuted"}]},
                 "jump-judge-0":{"items":[{"id":0,"state":"confirmed","frame":4,"object":"部件","note":"相邻帧局部消失并恢复"}]},
                 "causal-plan":{"chains":[]}}
        def answer(state,tag,*_):
            return dict(data=replies[tag],receipt=tag)
        with tempfile.TemporaryDirectory() as tmp, patch("method.decode",return_value=(np.arange(9)/24,frames)), patch("method.ask",side_effect=answer):
            out=evaluate(None,{},first,dict(repeats=[],numeric=[]),dict(issues=[]),Path(tmp))
        self.assertEqual(out["verdict"],"fail")
        self.assertEqual([(i["category_v2"],i["frame"]) for i in out["issues"]],[("B2",4)])
        self.assertEqual(out["receipts"][3:],list(replies))

    def test_one_native_frame_local_flash(self):
        frames=np.zeros((21,64,96,3),dtype=np.uint8)
        frames[7,:16,32:48]=128
        out=proposals(np.arange(21)/30,frames)
        self.assertEqual((out[0]["frame"],out[0]["cell"]),(7,[2,0]))
        self.assertEqual(proposals(np.arange(21)/30,frames*0),[])

    def test_unknown_is_not_missing_effect(self):
        chain={"initial_absent":True,"required_by_end":True}
        rows=[dict(frame=i,cause=c,effect=e,observation="同一参照") for i,(c,e) in enumerate([("0","0"),("1","0"),("0","?")])]
        self.assertEqual(causal(chain,rows,[0,1,2])[1],"uncertain")
        rows[-1]["effect"]="0"
        self.assertEqual(causal(chain,rows,[0,1,2]),(2,"confirmed"))

    def test_event_time_and_one_to_one(self):
        refs=[{"category":"B2","windows":[[2,3]]}]*2
        issues=[{"subtype":"TC1","t":4}]
        labels=dict(digest=digest([refs,issues]),pairs=[dict(ref=i,issue=0,same_event=True,same_object=True) for i in range(2)])
        self.assertEqual(len(score(refs,issues,labels)["strict"]),1)
        issues[0]["t"]=4.01
        with self.assertRaises(ValueError):score(refs,issues,labels)
        labels["digest"]=digest([refs,issues])
        self.assertEqual(score(refs,issues,labels)["strict"],[])
        for item in labels["pairs"]:item["same_event"]=False
        self.assertEqual(score(refs,issues,labels)["semantic"],[])

if __name__=="__main__":unittest.main()
