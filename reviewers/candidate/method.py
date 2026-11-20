"""Candidate decision policy. The same function is used in the CLI and the repeated trial."""
from collections import Counter
import json
from pathlib import Path
import numpy as np
from frames import board, decode, proposals
from judge import ask
from provider import save

TAX=json.loads((Path(__file__).resolve().parents[2]/"v2/taxonomy.json").read_text(encoding="utf8"))
NAMES={k:v["name"] for k,v in TAX["categories"].items()}
VERIFY="""只核对给出的逐条指控；创意是要求，图片才是实际画面。每项独立判断。必须指向同一对象和同一错误。只有在所给原始画格可见且违反要求时 confirmed；明确与画面矛盾 refuted；遮挡、模糊、声音、动作未被连续取样等不能判断 uncertain。静态外形也要明确可见。输出 JSON {"items":[{"id":0,"state":"confirmed|refuted|uncertain","frame":整数画格号,"category":"v2代码","object":"具体对象","note":"只陈述所见及违反哪一要求"}]}。逐项保留输入编号。"""
JUMP="""逐组看标有 frame 的全景和同帧局部，找同一物体突然消失或出现、空间断裂、动作回跳或重复。正常运镜剪辑、快速运动、遮挡或高像素差本身不能证明出错。每组返回一项，id 为组号。逐帧可见的跳变为 confirmed（说明前后物体位置和可见性，frame 取异常发生帧）；合理连续为 refuted；看不清为 uncertain。输出 JSON {"items":[{"id":0,"state":"confirmed|refuted|uncertain","frame":整数,"object":"对象","note":"观察"}]}。"""
PLAN="""仅根据创意要求，挑出至多两个能直接从画面分别测量的物理因果关系。没有这样的关系就返回空数组。不要推断隐藏开关、抽象功能、情绪。分别定义可见的原因条件、可见的结果状态（用单调的二值判据，如液面超过固定参照线）、从什么初态开始、验收时应否已产生结果。不要把剪辑先后或可选的关系当物理必然。返回 {"chains":[{"cause":"原因发生或正在发生的可视判据","effect":"结果状态成立的可视判据","initial_absent":true,"required_by_end":true}]}，布尔值须由创意支持。"""
OBS="""逐帧读取状态，只填图上看见的。不要预测结果。cause/effect 独立记录，0 表示清楚看见条件不成立，1 表示清楚看见成立，? 表示未入镜/遮挡/无参照。液位比较须以同一容器可见固定参照为准；姿态角度或反光不足以测量。每个条目 observation 必须描述可见物体/位置，frame 必须用图上的整数。按给出的判据顺序返回 JSON {"tracks":[{"id":0,"rows":[{"frame":0,"cause":"0|1|?","effect":"0|1|?","observation":"原因及结果的原始画面证据"}]}]}。"""
def dump(x):
    return json.dumps(x,ensure_ascii=False)

def causal(chain, rows, ids):
    if [r.get("frame") for r in rows]!=ids or any(r.get(k) not in ("0","1","?") for r in rows for k in ("cause","effect")) or any(not str(r.get("observation") or "").strip() for r in rows):
        return None,"uncertain"
    triggers=[i for i,r in enumerate(rows) if r["cause"]=="1"]
    effects=[i for i,r in enumerate(rows) if r["effect"]=="1"]
    if chain["initial_absent"] and rows[0]["effect"]=="0" and effects and (not triggers or effects[0]<triggers[0]):
        # An unseen short trigger between sampled frames is possible. Escalate rather than certify it.
        return effects[0],"uncertain"
    if chain["required_by_end"] and triggers and triggers[0]<len(rows)-1 and rows[0]["effect"]=="0" and rows[-1]["effect"]=="0" and not effects and all(r["effect"]=="0" for r in rows[triggers[0]:]):
        return len(rows)-1,"confirmed"
    if not triggers or not effects:
        return None,"uncertain"
    return None,"refuted"

def evaluate(video,brief,first,signals,technical,state):
    times,frames=decode(video)
    n=len(times)
    receipts=[f["job_id"] for f in first]
    if len(set(receipts))!=3 or len(first)!=3:
        raise ValueError("Three independent first ballots required")
    issue=list(technical["issues"])+list(signals["numeric"])
    pending=[]
    trace={}
    def call(tag,prompt,pics=()):
        answer=ask(state,tag,prompt,pics)
        receipts.append(answer["receipt"])
        trace[tag]=answer["data"]
        return answer["data"]
    def make(tag,slots):
        path=state/(tag+".jpg")
        return path,board(times,frames,slots,path)
    def items(tag,result,allowed,fixed=None):
        rows=result.get("items")
        if not isinstance(rows,list) or any(not isinstance(x,dict) for x in rows) or Counter(x.get("id") for x in rows)!=Counter(list(allowed)):
            pending.append(tag+":invalid")
            return
        for row in rows:
            idx=row["id"]
            if row.get("state")=="refuted":
                continue
            at=row.get("frame")
            category=fixed or row.get("category")
            if row.get("state")!="confirmed" or type(at)!=int or at not in allowed[idx] or category not in NAMES or not row.get("object") or not row.get("note"):
                pending.append(f"{tag}:{idx}")
                continue
            issue.append(dict(category_v2=category,t=round(float(times[at]),4),frame=at,object=row["object"],note=row["note"],source=tag))
    # Verify all FAIL allegations, including those on a minority ballot.
    allegations=list(dict.fromkeys((float(i["t"]),i["note"]) for f in first if f["verdict"]=="FAIL" for i in f["issues"]))
    overview=list(np.linspace(0,n-1,min(n,9)).round().astype(int))
    full,full_ids=make("overview",[(i,None) for i in overview])
    for start in range(0,len(allegations),5):
        group=allegations[start:start+5]
        extra=[]
        for t,_ in group:
            for off in (-.3,0,.3):
                extra.append((int(np.argmin(abs(times-t-off))),None))
        tag=f"verify-{start}"
        pic,ids=make(tag,extra)
        payload=[dict(id=i,t=t,allegation=v) for i,(t,v) in enumerate(group)]
        items(tag,call(tag,VERIFY+dump(NAMES)+"\n创意要求 "+dump(brief)+"\n待核 "+dump(payload),[full,pic]),{i:ids+full_ids for i in range(len(group))})
    candidates=proposals(times,frames)
    groups=[[(i,c["cell"]) for i in sorted({max(0,min(n-1,c["frame"]+d)) for d in (-2,-1,0,1,2)})] for c in candidates]
    for _,a,b in signals["repeats"]:
        group=[(int(np.argmin(abs(times-signals["times"][j]))),None) for j in (a,a+1,a+2,b,b+1,b+2)]
        groups.append(group)
    # Independent of the whole-video verdict.
    trace["changes"]=candidates
    for start in range(0,len(groups),3):
        chosen=groups[start:start+3]
        pics=[make(f"jump-{start+j}",s) for j,s in enumerate(chosen)]
        items("jump",call(f"jump-judge-{start}",JUMP+"图片顺序分别对应组 id 0 开始。",[p for p,_ in pics]),dict(enumerate(ids for _,ids in pics)),"B2")
    chains=call("causal-plan",PLAN+dump(brief)).get("chains")
    if not isinstance(chains,list) or len(chains)>2 or any(not isinstance(c,dict) or not all(isinstance(c.get(k),str) and c[k].strip() for k in ("cause","effect")) or any(type(c.get(k))!=bool for k in ("initial_absent","required_by_end")) for c in chains):
        pending.append("invalid-causal-plan")
    elif chains:
        ids=sorted({int(np.argmin(abs(times-t))) for t in np.arange(0,times[-1],1)}|{0,n-1})
        pic,_=make("states",[(i,None) for i in ids])
        tracks=call("causal-states",OBS+dump([{k:c[k] for k in ("cause","effect")} for c in chains]),[pic]).get("tracks")
        if not isinstance(tracks,list) or any(not isinstance(x,dict) for x in tracks) or Counter(x.get("id") for x in tracks)!=Counter(range(len(chains))):
            pending.append("invalid-causal-states")
        else:
            for track in tracks:
                c=chains[track["id"]]; rows=track.get("rows")
                if not isinstance(rows,list) or any(not isinstance(x,dict) for x in rows):
                    pending.append("invalid-track")
                    continue
                at,status=causal(c,rows,ids)
                if at is not None and status=="uncertain":
                    # Inspect the entire prefix at native cadence before inferring absence.
                    # If it exceeds the visual budget the evidence stays explicitly uncertain.
                    stop=ids[at]
                    if stop<=48:
                        dense=[]
                        for a in range(0,stop+1,12):
                            ids2=list(range(a,min(a+12,stop+1)))
                            tag=f"prefix-{track['id']}-{a}"
                            picture,_=make(tag,[(f,None) for f in ids2])
                            batch=call(tag,OBS+dump([{k:c[k] for k in ("cause","effect")}]),[picture]).get("tracks")
                            if not isinstance(batch,list) or len(batch)!=1 or not isinstance(batch[0],dict):
                                break
                            observed=batch[0].get("rows")
                            if not isinstance(observed,list) or any(not isinstance(v,dict) for v in observed) or [v.get("frame") for v in observed]!=ids2:
                                break
                            dense.extend(observed)
                        idx=next((i for i,v in enumerate(dense) if v.get("effect")=="1"),None)
                        if len(dense)==stop+1 and idx and dense[0].get("effect")=="0" and all(v.get("cause")=="0" and v.get("effect") in ("0","1") and v.get("observation") for v in dense[:idx+1]):
                            issue.append(dict(category_v2="B1",frame=idx,t=float(times[idx]),object=c["effect"],note=dump([dense[0],dense[idx-1],dense[idx]]),source="causal-prefix"))
                            continue
                if status=="confirmed":
                    f=ids[at]
                    issue.append(dict(category_v2="B1",frame=f,t=float(times[f]),object=c["effect"],note="；".join(r["observation"] for r in rows),source="causal"))
                elif status=="uncertain":
                    pending.append("causal:"+str(track["id"]))
    votes=Counter(x["verdict"] for x in first)
    verdict="fail" if issue else "uncertain" if pending or votes["PASS"]<2 else "pass"
    save(state/"observations.json",dict(votes=dict(votes),pending=pending,stages=trace))
    return dict(verdict=verdict,issues=issue,receipts=receipts,pending=pending)
