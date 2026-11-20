"""Score locked judgments against private v2 errors. Never imported by the reviewer."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path

TAX=json.loads((Path(__file__).resolve().parents[1]/"v2/taxonomy.json").read_text(encoding="utf8"))
def digest(x):
    return hashlib.sha256(json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()

def maximum(edges):
    owners={}
    def assign(ref,seen):
        for i in sorted(edges[ref]):
            if i in seen:
                continue
            seen.add(i)
            if i not in owners or assign(owners[i],seen):
                owners[i]=ref
                return True
        return False
    for ref in range(len(edges)):
        assign(ref,set())
    return sorted((ref,i) for i,ref in owners.items())

def score(errors,issues,labels):
    if labels.get("digest")!=digest([errors,issues]):
        raise ValueError("Evidence annotation is for different inputs")
    category=labels.get("categories",{})
    pairs={(p["ref"],p["issue"]):p for p in labels["pairs"]}
    if len(pairs)!=len(labels["pairs"]) or set(pairs)!={(r,i) for r in range(len(errors)) for i in range(len(issues))}:
        raise ValueError("Incomplete or duplicate object/event annotation")
    semantic=[[] for _ in errors];strict=[[] for _ in errors];details=[]
    for (r,i),p in pairs.items():
        a,b=errors[r],issues[i]
        cat=b.get("category_v2") or TAX["from_v1"].get(b.get("subtype")) or category.get(str(i))
        t=b.get("t");windows=a.get("windows") or []
        hit=any(lo-1<=t<=hi+1 for lo,hi in windows) if windows and type(t) in (float,int) and math.isfinite(t) else None
        same=all(p.get(k) is True for k in ("same_object","same_event"))
        if same:semantic[r].append(i)
        if same and cat==a["category"] and (not windows or hit is True):strict[r].append(i)
        details.append(dict(ref=r,issue=i,category=cat,category_match=cat==a["category"],window_hit=hit,
                            same_object=p.get("same_object"),same_event=p.get("same_event")))
    return dict(reference_errors=len(errors),issued=len(issues),semantic=maximum(semantic),strict=maximum(strict),details=details)

def annotate(errors,issues,cache,ask):
    stamp=digest([errors,issues])
    if not errors or not issues:
        return dict(digest=stamp,pairs=[],categories={})
    # Infer missing categories from the judgment in isolation, before showing the answer key.
    missing={str(i):b["note"] for i,b in enumerate(issues) if not b.get("category_v2") and not TAX["from_v1"].get(b.get("subtype"))}
    categories={}
    if missing:
        names={k:v["name"] for k,v in TAX["categories"].items()}
        res=ask(cache,"classification","只看判词，逐条归类。若无法辨认类别填 unknown。返回 JSON 对象，以输入编号为键、单个类别代码为值。字典和判词："+json.dumps([names,missing],ensure_ascii=False))
        categories=res["data"]
        if set(categories)!=set(missing):raise ValueError("Incomplete category classification")
    q="""逐对比对文字。判断判词是否指向标注的同一对象和同一错误事件。多出部件与形状不符是不同事件；若错误是顺序或缺失，必须说出相应关系。不要由笼统描述补全。不确定用 null。只比较语义，不参考时间、类别或其他项。返回 {"pairs":[{"ref":标注下标,"issue":判词下标,"same_object":布尔或null,"same_event":布尔或null}]}。必须覆盖全部组合。"""
    res=ask(cache,"match",q+json.dumps([[a["description"] for a in errors],[b["note"] for b in issues]],ensure_ascii=False))
    labels=dict(digest=stamp,pairs=res["data"].get("pairs",[]),categories=categories,receipt=res["receipt"])
    try:
        score(errors,issues,labels)
    except (ValueError,KeyError,TypeError):
        labels["pairs"]=[]
        labels["pair_receipts"]=[]
        for r,err in enumerate(errors):
            for i,issue in enumerate(issues):
                one=ask(cache,"single-match","只比对标注与判词是否明确指同一对象、同一错误事件。不确定填 null。返回 JSON 对象，字段 same_object 和 same_event。"+json.dumps([err["description"],issue["note"]],ensure_ascii=False))
                item=one["data"]
                if any(k not in item or (item[k] is not None and type(item[k])!=bool) for k in ("same_object","same_event")):
                    raise ValueError("Invalid single object/event annotation")
                labels["pairs"].append(dict(ref=r,issue=i,same_object=item["same_object"],same_event=item["same_event"]))
                labels["pair_receipts"].append(one["receipt"])
        score(errors,issues,labels)
    return labels

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for k in ("key","reviews","matches","out"):p.add_argument("--"+k,required=True,type=Path)
    p.add_argument("--annotate",action="store_true",help="Use configured fixed AI to fill missing object/event decisions")
    a=p.parse_args()
    if a.annotate:
        import sys
        base=Path(__file__).resolve().parents[1]/"reviewers"
        sys.path[:0]=[str(base/"candidate"),str(base/"frozen")]
        from judge import ask
    rows=[]
    for ref in json.loads(a.key.read_text(encoding="utf8")):
        if "errors" not in ref: raise ValueError("Prepare a blind package with the evidence-enabled key")
        results=a.reviews/(ref["id"]+".json")
        rec=json.loads(results.read_text(encoding="utf8")) if results.exists() else {}
        status=rec.get("verdict") or rec.get("status","missing")
        errors=ref["errors"]
        issues=rec.get("issues",[]) if status=="fail" else []
        target=a.matches/(ref["id"]+"-"+digest([errors,issues])+".json")
        if target.exists(): labels=json.loads(target.read_text(encoding="utf8"))
        elif not errors or not issues: labels=dict(digest=digest([errors,issues]),pairs=[])
        elif a.annotate:
            work=a.matches/"receipts";work.mkdir(parents=True,exist_ok=True)
            labels=annotate(errors,issues,work,ask)
            from provider import save
            save(target,labels)
        else:labels=None
        rows.append(dict(id=ref["id"],status=status,reference_errors=len(errors),evidence=score(errors,issues,labels) if labels else None))
    total=sum(r["reference_errors"] for r in rows)
    result=dict(total_reference_errors=total,strict_hits=sum(len(r["evidence"]["strict"]) for r in rows if r["evidence"]),
                semantic_hits=sum(len(r["evidence"]["semantic"]) for r in rows if r["evidence"]),pending_annotations=sum(r["evidence"] is None for r in rows),cases=rows)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf8")
if __name__=="__main__":main()
