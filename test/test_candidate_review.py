import sys
import unittest
from pathlib import Path
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/"src"),str(ROOT/"reviewers/candidate"),str(ROOT/"reviewers/frozen")]
from frames import proposals
from evidence_score import score,digest
from method import causal

class ReviewRegression(unittest.TestCase):
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
