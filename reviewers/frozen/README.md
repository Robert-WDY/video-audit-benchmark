# 冻结版单镜头审核

`frozen-shot-v1` 接收一个匿名 MP4 和对应的创意要求。审核输入不含评分映射、参考错误、生成提示词及历史判词。每条结果保留结论、问题与时间点、视频 SHA-256 和模型调用编号。

## 运行

需要 Node.js 20+、Python 3.11+、FFmpeg 和 ffprobe。基准记录使用 Windows.Media.Ocr。指定 `AUDIT_OCR=tesseract` 时需要 Tesseract 和 `chi_sim+eng` 语言包。服务配置通过进程环境传入。三首审、局部跳变和物理因果实验可使用[候选审核器](../candidate/README.md)。

| 环境变量 | 用途 |
|---|---|
| `AICENTRE_BASE_URL`、`AICENTRE_API_KEY` | 支持文件上传和异步文本审核任务的 AI Centre 服务地址及密钥 |
| `FROZEN_BOARD_BASE`、`FROZEN_BOARD_KEY` | 画格复核服务的 API 根地址及密钥。客户端追加 `/chat/completions` |
| `FROZEN_BOARD_MODEL` | 支持图片、JSON 输出和关闭思考的模型 ID。冻结实验使用 `doubao-seed-2-1-turbo-260628` 对应的部署 |
| `REVIEW_MODEL`、`AICENTRE_REVIEW_CHANNEL` | 整片审核默认使用 `qwen3.8-omni-flash` 和 `dashscope` |
| `REVIEW_PYTHON` | 可选，指定已安装依赖的 Python 可执行文件 |

在仓库根目录执行。先按 v2 说明组装并导出匿名输入。[数据组装与匿名导出](../../v2/README.md)

```powershell
python -m pip install -r reviewers/frozen/requirements.txt
node src/eval-v2.mjs review --input .work/v2-blind/inputs --out .work/review-r1
node src/eval-v2.mjs score --key .work/v2-blind/key.json --reviews .work/review-r1 --out .work/score-r1.json
```

未设置 `REVIEW_MODULE` 时使用内置审核器。已配置其他适配器时，在当前 PowerShell 会话运行 `Remove-Item Env:REVIEW_MODULE -ErrorAction SilentlyContinue` 可选回内置实现。模型请求会产生供应商费用。中断后用同一输出目录续跑。测同片重复性时，各轮使用独立输出目录，如 `.work/review-r2` 和 `.work/review-r3`。切换输入、模型或审核版本时另选结果目录。

## 审核规则

三轮审核同一匿名输入包后，用下列命令计算每个用例的翻转、两两不一致和相邻轮次变化。缺少有效判词的用例单列；同一用例复用已知首审回执时会报错。

```powershell
node src/eval-v2.mjs stability --input .work/v2-blind/inputs --round .work/review-r1 --round .work/review-r2 --round .work/review-r3 --out .work/stability.json
```

1. 整片模型对照产品外观、事实、起态、动作与终态，返回观察到的异常及秒数。
2. FFmpeg 检查连续黑场、冻结和孤立的全幅闪帧。v2 默认允许无音轨。OCR 从约 4 fps 的帧序列每隔四帧抽取一帧并补末帧。数值冲突需要唯一可比较的同单位声明，且至少两处不符读数相隔 0.4 秒。技术或 OCR 的确定错误可以拦截。
3. 初步放行或待复核的片子如有突变或重复运动信号，再审一份包含全景与局部细节的画格。模型指出错误后，用均匀取帧的另一份画格核验。两份判词命中同一子类且相差不超过 1 秒，才据此拦截。证据分歧记待复核。
4. `reviewed` 含 `pass` 或 `fail`，`uncertain` 表示证据不足，`unavailable` 表示服务或执行不可用。计分分别报告确定判词覆盖率、确定判词准确率、全样本判对率。用于经验学习时仍需核对具体对象、异常与时间窗。

## 冻结基线的实测表现

数据版本为 `45f1ad4`，97 个“视频＋创意要求”组合，83 份不同视频。下表是同步前冻结流程的三轮独立实审。参考标注中 9 条由人工确认，88 条由 Claude 复核。

| 轮次 | 判对 / 97 | 误放 / 48 | 误退 / 49 | 待复核 | 正确拦截 | 指出标注错误 | 错因和时间均命中 / 34 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 76 | 15 | 4 | 2 | 33 | 27 | 13 |
| 2 | 74 | 15 | 4 | 4 | 32 | 29 | 16 |
| 3 | 74 | 15 | 6 | 2 | 33 | 27 | 14 |

20/97 条至少有一次结论翻转，17 条既被放行过也被拦截过。48 条应拦用例中，24 条三次均指出标注的具体错误。
