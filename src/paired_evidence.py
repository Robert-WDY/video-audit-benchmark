"""Case-paired comparison of three evidence-score reports from each reviewer."""
import argparse
import json
from math import comb
from pathlib import Path

def summarize(rounds):
    if len(rounds)!=3:
        raise ValueError("Three reports are required")
    indexed=[]
    for report in rounds:
        rows=report["cases"]
        lookup={r["id"]:r for r in rows}
        if len(lookup)!=len(rows) or not rows:raise ValueError("Missing or duplicate case IDs")
        indexed.append(lookup)
    if any(set(x)!=set(indexed[0]) for x in indexed):raise ValueError("Input case IDs differ")
    out={}
    for k in indexed[0]:
        rows=[idx[k] for idx in indexed]
        totals={r["reference_errors"] for r in rows}
        if len(totals)!=1:raise ValueError("Reference errors changed")
        n=totals.pop()
        ready=all(r["evidence"] is not None and r["status"] in {"pass","fail","uncertain"} for r in rows)
        result={"references":n,"complete":ready}
        if ready:
            result["flip"]=len({r["status"] for r in rows})>1
            for metric in ("semantic","strict"):
                ids=[{p[0] for p in r["evidence"][metric]} for r in rows]
                result[metric]=sorted(set.intersection(*ids))
        out[k]=result
    return out

def compare(before,after):
    if set(before)!=set(after):raise ValueError("Reviewer arms contain different inputs")
    keys=[k for k in before if before[k]["complete"] and after[k]["complete"]]
    out={"total_cases":len(before),"paired_complete":len(keys)}
    for arm in (before,after):
        if any(arm[k]["references"]!=before[k]["references"] for k in keys):raise ValueError("Different references")
    out["paired_flips"]=[sum(a[k]["flip"] for k in keys) for a in (before,after)]
    for m in ("semantic","strict"):
        gained=lost=old=new=ref_old=ref_new=ref_total=0
        for k in keys:
            n=before[k]["references"]
            if not n:continue
            a,b=[set(arm[k][m]) for arm in (before,after)]
            ref_old+=len(a);ref_new+=len(b);ref_total+=n
            # One observation per case for the sign test: all reference errors stable.
            old+=len(a)==n;new+=len(b)==n
            gained+=len(b)==n and len(a)<n
            lost+=len(a)==n and len(b)<n
        swaps=gained+lost
        p=min(1,2*sum(comb(swaps,j) for j in range(min(gained,lost)+1))/2**swaps)
        out[m]=dict(before_all_errors=old,after_all_errors=new,gained_cases=gained,lost_cases=lost,
                    before_reference_hits=ref_old,after_reference_hits=ref_new,reference_total=ref_total,p_two_sided=p)
    return out

if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    for arm in ("before","after"):p.add_argument("--"+arm,nargs=3,type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    if len({f.resolve() for f in a.before+a.after})!=6:raise ValueError("Six distinct round reports required")
    def arm(files):return summarize([json.loads(f.read_text(encoding="utf8")) for f in files])
    result=compare(arm(a.before),arm(a.after))
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf8")
