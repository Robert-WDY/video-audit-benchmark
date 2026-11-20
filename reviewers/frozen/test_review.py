import os
import tempfile
import unittest

os.environ.setdefault("FROZEN_SCRATCH", tempfile.gettempdir())
from evidence import known
from review import decision


def vote(verdict, issues=(), job="first"):
    return {"verdict": verdict, "issues": list(issues), "job_id": job}


class DecisionTest(unittest.TestCase):
    def test_confirm_by_subtype_and_time(self):
        issue = {"subtype": "SA2", "t": 1.5}
        for subtype, time, expected in [
            ("SA2", 2.5, "fail"),
            ("SA2", 2.51, "uncertain"),
            ("SA3", 1.5, "uncertain"),
        ]:
            with self.subTest(subtype=subtype, time=time):
                views = {
                    "assisted": vote("FAIL", [issue], "a"),
                    "uniform": vote("FAIL", [{"subtype": subtype, "t": time}], "b"),
                }
                out = decision(
                    vote("PASS"),
                    {"numeric": [], "jumps": [1], "repeats": []},
                    known,
                    {"issues": []},
                    views.__getitem__,
                )
                self.assertEqual(out["verdict"], expected)
                self.assertEqual(out["issues"], [issue] if expected == "fail" else [])
                self.assertEqual(out["receipts"], ["first", "a", "b"])

    def test_technical_evidence_prevents_rerouting(self):
        issue = {"category": "TE", "subtype": "TE1", "t": 0.5, "end_s": 1.1, "note": "连续黑场"}
        out = decision(
            vote("UNCERTAIN"),
            {"numeric": [], "jumps": [1], "repeats": []},
            known,
            {"issues": [issue]},
            lambda mode: self.fail(mode),
        )
        self.assertEqual((out["verdict"], out["issues"]), ("fail", [issue]))
