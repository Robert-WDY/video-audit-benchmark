# 单镜头审核候选版

每条输入包含视频和创意要求。首审使用三个独立任务，提交温度为 0。每轮将三个任务中的具体指控送入画格复核，即使只有少数票提出该指控也会查证。任何可证实的问题可以触发拦截。没有确定问题时，至少两票通过且各检查均无待核项才放行。每次判断保留首审与复核回执、画格编号和时间。

局部跳变检测按视频显示时间戳逐帧扫描，将相邻画面分成 6×4 块，按每块自己的运动基线找异常，最多选 4 个间隔至少 0.30 秒的候选。每个候选展示原位全景和相同位置的局部画格，前后各两帧。运动片段重复单独提供两个时间段。上述分支始终运行，候选像素差本身不会触发拦截。

因果检查先从创意提取最多两条可以分别观察原因和结果的关系，逐秒记录状态。程序检查终态缺失和结果先于可见原因；需要断言此前未发生触发时，补查从片头到结果的每一帧，超出 49 帧预算或遮挡则保留待核。结论依赖状态读数质量，完整规则和逐轮状态位于 observations.json。

## 复现实验

按冻结版说明配置两个模型端点。Windows 默认调用系统中文 OCR；在安装 Tesseract 和中文、英文语言包的环境可指定 AUDIT_OCR=tesseract，默认语言 chi_sim+eng。跨 OCR 后端的结果应单独计分。[依赖与服务配置](../frozen/README.md)

```powershell
$env:REVIEW_MODULE = (Resolve-Path reviewers/candidate/index.mjs).Path
node src/eval-v2.mjs prepare --dataset .work/v2 --out .work/blind
foreach ($round in 1..3) {
  node src/eval-v2.mjs review --input .work/blind/inputs --out ".work/r$round"
  python src/evidence_score.py --key .work/blind/key.json --reviews ".work/r$round" --matches .work/semantic-labels --out ".work/evidence-$round.json" --annotate
}
node src/eval-v2.mjs stability --input .work/blind/inputs --round .work/r1 --round .work/r2 --round .work/r3 --out .work/stability.json
```

只把 inputs 交给审核器。评分时才使用 key.json 中的错误与窗口。评分器先按判词独立归类，再用指定语义模型判断是否同一对象、同一事件，保存原始回执。再次计分可以直接读取匹配文件。严格命中要求类别相符、对象和事件均匹配、已标时间窗向两侧各放宽 1 秒后包含报错时间。未标窗口的案例只核对类别和语义。多错误采用一对一最大匹配。未提供匹配决定的样本单列为待标注。

冻结候选时需同时保留代码指纹、模型部署标识、OCR 后端和三轮原始结果。以同一 97 个用例配对，全部有结果才计算准入。至少一次结论不同的用例应至多 4 个。对 48 个故障例同时报告三次均指出正确错误的数量、严格时间命中、误放、误退、待核以及数据缺失。

新旧两版各自完成三轮独立性检查与证据评分后，可用下列命令计算同片得失。它追踪每一条参考错误能否三轮命中，同时以每个用例为单位对“所有参考错误均稳定命中”做配对精确检验。

```powershell
python src/paired_evidence.py --before old/r1.json old/r2.json old/r3.json --after new/r1.json new/r2.json new/r3.json --out paired.json
```
