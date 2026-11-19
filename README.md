# 视频审核评测集

用来评测 AI 生成视频的审核机制（成片审片 + 确定性质检）：先定义一个**正确的视频世界**，再注入**可控的错误**，然后看审核能不能判断出：有没有错、是什么错、错在哪一秒、多个错误能不能分别找出来。

## 设计原则

1. **最小差异对照**。每个错误视频和对照视频都来自同一条正确底片，唯一差别就是注入的那个错误。
2. **能剪辑出来的错误不靠提示词**。时序、因果、物理、技术类错误，用时间轴剪辑（倒放、抽帧、重复、换序、插帧）和后期叠加（区域换色、字幕、黑场、静音）直接从正确底片做出来，真值精确到帧。只有剪不出来的错误（结构变形、手指异常、乱码等）才用提示词、参考图编辑或局部修补来做。
3. **对照组走同一条管线**。对照组在错误样本相同的位置切开再接回去，用同样参数重新编码。这样审核就不能靠"这里被剪过"来猜错误，只能看内容。
4. **三份数据互相隔离**。`gen.json`（怎么做）只给制作方；`input.json`（审核能看到什么，和线上 `runQc` 的 `request/plan` 结构相同）不含任何注入信息，有测试保证；`truth.json`（真值）只给评分脚本和复核人。
5. **真值以人工定稿为准**。注入记录只代表"想做出的错误"。人工先盲审、再复核，定稿后的 `actual` 才是真值。模型没做出来的错误会被剔除，顺带做出来的意外错误会被补进去。没定稿的用例默认不计分。

## 错误分类（`taxonomy.json`）

一级类别**互斥**：一个异常只取一个主类别，按下表顺序依次判断，命中第一个就停；其余相关类别写进 `secondary`。

| 顺序 | 类别 | 判断问题 | 判定依据 | 对应审核项 |
|---|---|---|---|---|
| 1 | TE 技术缺陷 | 是编码或播放层面的问题吗？ | 常识 | black_silence + 黑场/冻帧/静音硬门槛 |
| 2 | PF 产品事实 | 和给定的外观或事实（封闭世界：没列出的功能都算不存在）矛盾吗？ | 事实 | product_drift、fact_error |
| 3 | SA 脚本偏离 | 和镜头卡的起始状态、动作、终态不一致吗？ | **脚本** | 无专属审核项 |
| 4 | TC 时序/因果 | 要对比两个以上时刻才能发现吗？ | 常识 | physics |
| 5 | PH 物理 | 单个时刻或一小段运动就违反物理吗？ | 常识 | physics |
| 6 | VT 文字/视觉 | 不违反事实和物理，只是画面本身坏了？ | 常识 | garbled_text、product_drift |

每个错误另外标注几个互相独立的维度，评分时按每个维度分别切分：

- **发现所需证据** E1 单帧 / E2 动作过程 / E3 跨帧对比 / E4 结合脚本或全片
- **显著度** V1 明显 / V2 中等 / V3 细微
- **持续时长** instant（跳变点）/ flash（不到 0.2 秒，低于审核每秒 5 帧的抽帧间隔）/ short / long
- **处置** block 必须拦 / fix 应返修 / accept 可接受（不计入"应拦"）
- **判定依据** common_sense / facts / script

易混组：`{SA, TC, PH}`、`{PF, VT}`。审核报到同一组的其他类别，算"检出但分类偏了"（group），单独统计。

现有审核只拿到外观、事实和字幕，**拿不到镜头脚本**。所以 SA 类在 `facts` 配置下原理上很难判断。`review --config script` 会把镜头卡追加进事实列表（不改审核代码）。两种配置的召回率差多少，就能回答"要不要把镜头卡也传给审核"。

## 场景库（`scenes/`）

| 场景 | 内容 | 主要考什么 |
|---|---|---|
| S01 | 保温杯转台旋转展示 | 颜色（持续 / 一闪而过）、字幕规格、Logo、部件 |
| S02 | 拧开杯盖 | 动作反向、有果无因、重复、冻帧、杯盖数量、手指 |
| S03 | 倒水 | 液体倒流、瞬移、状态回跳、静音、终态错 |
| S04 | 耳机开盒取出 | 瞬移、回跳、指示灯颜色（细微）、耳机数量、伪文字 |
| S05 | 手机放上无线充电板 | 顺序颠倒、字幕功率、黑场、悬浮、虚构功能、有因无果 |
| S06 | 穿运动鞋 | 倒放脱鞋、标识变色（细微）、瞬间穿入、左右脚、穿模 |
| S07 | 音箱按键开机 | 先亮后按、续航字幕、冻帧、全片无声、按键数量 |
| S08 | 面霜取用涂抹 | 霜体变色、重复蘸取、回跳、0.2 秒短黑场（低于硬门槛）、乱码、融化、可接受的闪烁 |

每个场景包含：产品事实、镜头脚本（起始状态 → 动作 → 终态）、标记点、5～7 个错误、2 个**干扰项**（看起来像错误、其实正确，比如光照变暗、慢动作、真实遮挡、正常形变、0.6 秒刻意定格），以及可选的链式组合。

时间全部用**标记点名称**来写（比如 `pour_start+1.0`）。同一个场景可以拍多条底片（实拍、AI 生成），每条底片只需要在 `takes.json` 里校准标记点。

## 用例类型

`build` 会把每条底片展开成下面几类用例：

| 类型 | 说明 |
|---|---|
| clean | 正确底片原样重新编码 |
| control | 匹配对照：和某个单错误样本剪辑点相同，但内容不改；字幕类错误的对照组用正确字幕 |
| decoy | 干扰项，测误报 |
| single | 一个错误 |
| multi | 两个同类错误 |
| combo | 两个不同类错误，或按 `chains` 指定的三个错误 |

多错误和组合错误按关系自动标注 `pattern`，并按关系轮流挑选，保证每种关系都有代表：

- `chain` 链式：场景里显式声明的因果链
- `mask` 掩盖：一个明显错误加一个细微错误，相距不超过 2 秒
- `overlap` 时间重叠
- `separate` 时间分离

两个错误作用在同一段画面上（比如整段倒放再抽帧）时，组合会自动跳过，记录在 `skipped.json`，不会生成错误的真值。一个用例最多包含一个手工步骤。

用 `takes.example.json`（9 条底片）展开，大约得到 177 个用例、198 个错误实例，其中 115 个可以全自动渲染，62 个需要手工制作。

## 流程

```bash
node src/cli.mjs validate --takes takes.json          # 校验场景和底片清单
node src/cli.mjs build    --takes takes.json --out out
#   → out/cases/<用例>/{gen,input,input.script,truth}.json
#   → out/manual-tasks.csv（手工制作清单）、out/skipped.json

# 手工制作：按 manual-tasks.csv 做出素材，放到 out/manual/<case_id>.mp4（时长和标记点要与底片一致）
node src/cli.mjs render --out out --ffmpeg $FFMPEG_PATH --font /path/NotoSansCJK.ttc   # 先加 --dry-run 检查
#   → out/videos/<blind_id>.mp4（文件名是不透明 id，看不出场景和错误）

node src/cli.mjs sheets --out out                      # 生成盲审表 annotation/blind-template.csv
#   每位标注员复制一份，命名为 <名字>.csv；只把 out/videos/ 给标注员
node src/cli.mjs agreement --blind out/annotation/a.csv,out/annotation/b.csv
node src/cli.mjs reconcile --out out --blind out/annotation/a.csv,out/annotation/b.csv
#   在 annotation/reconcile.csv 里逐行填写 verdict
node src/cli.mjs finalize  --out out                   # 写入 truth.actual，状态改为 final

export REVIEW_MODULE=/path/to/review.mjs REVIEW_RELAY_BASE=... REVIEW_RELAY_KEY=...
node src/cli.mjs review --out out --config facts
node src/cli.mjs review --out out --config script
node src/cli.mjs score --out out --config facts        # → out/report-facts.md、results-facts.json
```

`score --use-injected` 用注入记录代替定稿真值，**只用于调试流程**，不能当正式结论。

## 生成底片（可选）

`src/generate.mjs` 从场景卡拼提示词，调用 AI Centre 的 MiniMax H3 自建池生成底片或提示词诱导的错误样本。正确版与错误版共用同一个 seed，错误版只在末尾追加「本镜头必须出现的不合理之处」，并删掉与之冲突的那条约束。

```bash
export AICENTRE_BASE_URL=https://<AI Centre 地址> AICENTRE_API_KEY=<密钥>   # 只放环境变量，不要写进文件
node src/generate.mjs --scene S03 --dry-run           # 只看提示词
node src/generate.mjs --scene S03                     # 正确底片
node src/generate.mjs --scene S03 --inj S03.I6        # 同 seed 的错误版
```

首批试验的经验：剪辑注入 13/13 成功；提示词诱导 4 条只做出 1 条（乱码文字），模型常把要求的错误「修正」掉，或换拍摄角度回避（比如从手背拍手）。所以提示词诱导只用于剪辑做不出来的类别，每条都必须复核。AI 生成的「正确底片」也常带意外错误，必须先盲审。

## 底片要求

- 先拍正确底片，盲审确认干净后再把 `verified_clean` 改成 `true`。AI 生成的"正确"底片常带手指、文字、液体方面的瑕疵，必须过一遍盲审。
- 实拍和 AI 生成两种来源都要有，报告里按 `source_kind` 分开统计。线上审核看的是 AI 视频，只用实拍会有来源差异。
- 固定机位，产品在 `regions` 框里的时间段内基本不动，否则区域换色会对不准。
- 标记点要逐帧校准。抽帧、倒放的真值完全依赖它们。
- 需要开机提示音、倒水声的场景（S03、S07）要收录现场声，否则静音类错误没有意义。

## 标注手册

**第一轮：盲审**（标注员不知道注入了什么）

- 每条视频都要填 `has_error`（是/否）。有错误时，一个错误占一行；同一条视频有多个错误就复制多行，每行填 blind_id。
- `category` 按上面的判定顺序取主类别，`sub` 尽量填。`t_start`/`t_end` 填秒；瞬间跳变只填 `t_start`。
- **计数单位**：一段连续的异常算一个错误。同一异常隔一段时间再次出现（比如红→蓝→红→蓝），每次出现算一个。
- 不确定算不算错误时，按处置填 `accept`，并在 note 里写明理由，不要直接漏标。
- 以下情况**不算错误**：光照、反光、阴影造成的视觉色调变化；透视或旋转造成的形状变化；真实的遮挡和重新出现；刻意的慢动作和 1 秒以内的定格；画面里真实存在的文字；脚本里写明的代码字幕。

**第二轮：复核**（`reconcile.csv`，可以看注入记录）

| verdict | 含义 |
|---|---|
| present | 注入的错误确实出现了 |
| partial | 出现了，但程度或范围和描述不完全一致（估计窗口可以直接改 t_start/t_end） |
| absent | 没做出来；这个错误不进真值 |
| accidental | 盲审发现的、不在注入记录里的意外错误，进真值 |
| ignore | 盲审误标，不进真值 |
| clean | 没有错误的视频，确认干净 |
| reject | 视频本身不可用（比如手工素材时长对不上），整条用例作废 |

`blind_hits` 列显示有几位标注员独立发现了这个错误。人类盲看都发现不了的错误，不应该要求审核一定发现，这一列就是人类基线。

**一致性**：先抽 20% 的视频让两个人独立标注，用 `agreement` 计算视频级 kappa 和错误级 F1。某个类别的一致率明显偏低时，先改定义或补充参考片段，再扩大规模。

## 指标（`report-*.md`）

- **视频级**：应拦视频的拦截率，不应拦视频（clean / control / decoy / 只有可接受瑕疵）的误拦率。
- **错误级**：召回率，必须时间定位在 ±1 秒内才算命中。**一条证据只能命中一个错误**，所以重叠的两个错误需要审核给出两条证据。
- 召回率按类别、子类、证据需求、显著度、时长、判定依据、注入方式、用例类型、组合关系、底片来源、错误来源分别切分；分类结果分 correct / group / other 三种。
- 所有比例都附 Wilson 95% 区间。样本少于 15 的格子标 ⚠，只报数字，不下结论。
- 审核不可用（`review_unavailable`）单独计数，不算漏报。

## 扩展

- **加底片**：在 `takes.json` 加一项。每多一条底片，用例就多一倍，这是提高每格样本量最便宜的办法。
- **加场景**：复制一个 `scenes/*.json`，`validate` 会检查类别、子类、标记点引用和 id。
- **加错误**：自动操作见 `src/timeline.mjs` 的 `PIECE_OPS`（reverse、drop、repeat、insert、swap、freeze、black、slow、cut）和叠加层（tint、caption、mute、flash）；手工操作写 `{"op":"manual","method":"prompt|ref_edit|inpaint|splice|shoot","instruction":…,"window":…}`。
- **当前缺口**：SA、PH、VT 三类和 V3 细微档的样本偏少，因为它们大多需要手工制作。正式评测前，应该优先补这几类的手工素材，或者增加底片条数。
