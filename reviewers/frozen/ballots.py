import json

SCHEMA = """只返回 JSON：
{"verdict":"PASS|FAIL|UNCERTAIN","summary":"实际观察和判定原因","issues":[{"category":"TE|PF|SA|TC|PH|VT","t":0.0,"note":"可见或可听证据"}]}
逐段观察实际媒体，核对产品外观和事实、起点、动作因果与终态，再检查新增缺陷。
提交确定错误的时间点和内容。多个错误分别列证据。关键细节看不清或音频无法判断时用 UNCERTAIN。
代码字幕依然要与产品事实核对。事实没有被演示不等于事实错误。
不把脚本当作观察，不把不相关的画面风格当作缺陷。画面证据充分且符合任务才 PASS。
只有图片时核对其应呈现的状态与产品，时间 t 用 0。不要要求一张图展示完整动作。"""


def ballot(payload):
    start = payload.find("{")
    if start < 0:
        raise ValueError("Review did not return a JSON object")
    obj, _ = json.JSONDecoder().raw_decode(payload[start:])
    verdict, summary, issues = obj.get("verdict"), obj.get("summary"), obj.get("issues")
    if verdict not in {"PASS", "FAIL", "UNCERTAIN"} or not isinstance(summary, str) or not summary.strip():
        raise ValueError("Review decision or summary missing")
    if not isinstance(issues, list) or (verdict == "FAIL" and not issues) or (verdict == "PASS" and issues):
        raise ValueError("Review verdict inconsistent with its evidence")
    for issue in issues:
        if not isinstance(issue, dict) or issue.get("category") not in {"TE", "PF", "SA", "TC", "PH", "VT"}:
            raise ValueError("Unrecognized issue category")
        at = issue.get("t")
        if type(at) not in (int, float) or not 0 <= at < float("inf"):
            raise ValueError("Issue missing a valid time")
        if not isinstance(issue.get("note"), str) or not issue["note"].strip():
            raise ValueError("Issue missing observable evidence")
    return {"verdict": verdict, "summary": summary.strip(), "issues": issues}
