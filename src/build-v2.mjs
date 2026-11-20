#!/usr/bin/env node
// 组装 v2 评测集：每个用例 = 创意要求（brief.json）+ 视频 + 结论（truth.json）。
//   node src/build-v2.mjs --config v2/sources.json --out <目录>
// 三种来源：
//   pairs   —— 创意一致性对比对：两条视频只在一个维度上不同，交叉配对得到「符合 / 不符合」
//   edits   —— 旧样本中只保留明显（V1）的错误，且底片经人工确认干净
//   bases   —— 底片本身带人工确认的错误，原片直接作为错误样本
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: { config: { type: 'string' }, out: { type: 'string', default: '.work/v2out' } } });
const J = (x) => JSON.stringify(x, null, 2) + '\n';
const readJson = async (f) => JSON.parse(await readFile(f, 'utf8'));
const cfgDir = path.dirname(path.resolve(a.config));
const cfg = await readJson(a.config);
const tax = await readJson(path.resolve(cfgDir, cfg.taxonomy));
const out = path.resolve(a.out);
const cases = [];

const cat = (code) => ({ category: code, category_name: tax.categories[code].name, group: tax.categories[code].group });

async function emit({ id, brief, video, errors, source, verified_by, note }) {
  const d = path.join(out, 'cases', id);
  await mkdir(d, { recursive: true });
  await mkdir(path.join(out, 'videos'), { recursive: true });
  const file = `${id}.mp4`;
  await copyFile(video, path.join(out, 'videos', file));
  // verified_by：human = 人工确认；claude = Claude 看帧复核，待人工确认；none = 未复核
  const truth = { id, video: file, verdict: errors.length ? 'fail' : 'pass', errors, source, verified_by: verified_by || 'none', verification_note: note || '' };
  await writeFile(path.join(d, 'brief.json'), J(brief));
  await writeFile(path.join(d, 'truth.json'), J(truth));
  cases.push(truth);
}

// —— 1. 对比对 ——
for (const src of cfg.pairs) {
  const spec = await readJson(path.resolve(cfgDir, src.file));
  for (const p of spec.pairs) {
    const v = src.videos[p.id];
    if (!v) continue;
    for (const briefSide of ['A', 'B']) {
      for (const videoSide of ['A', 'B']) {
        const ok = briefSide === videoSide;
        const brief = {
          product: p.product,
          requirements: [p.base_brief || p.base, `${p.dim_name}：${p[briefSide].label}`],
          checks: [{ dimension: p.dim_name, expected: p[briefSide].label }],
        };
        const errors = ok ? [] : [{ ...cat(p.category), description: `创意要求「${p[briefSide].label}」，成片是「${p[videoSide].label}」`, windows: null }];
        const id = `${ok ? 'OK' : p.category}__${p.id}__brief${briefSide}-video${videoSide}`;
        await emit({ id, brief, video: path.resolve(cfgDir, v[videoSide].path), errors, source: 'pair',
          verified_by: v[videoSide].verified_by, note: v[videoSide].note });
      }
    }
  }
}

// —— 2. 旧样本中的明显错误（只用人工确认干净的底片） ——
const scenes = new Map();
for (const f of await readdir(path.resolve(cfgDir, cfg.scenes))) {
  const s = await readJson(path.resolve(cfgDir, cfg.scenes, f)); scenes.set(s.id, s);
}
const sceneBrief = (s, captions = []) => ({
  product: { name: s.product.name, appearance: s.product.appearance },
  facts: s.product.facts.map((f) => f.claim),
  requirements: [`开始：${s.script.start_state}`, ...s.script.actions.map((x, i) => `动作 ${i + 1}：${x.actor}${x.desc}`), `结束：${s.script.end_state}`],
  copy: captions,
});
const OBVIOUS = new Set(cfg.edits.visibility || ['V1']);
const SKIP_SUBS = new Set(cfg.edits.skip_subs || []);
for (const dirSpec of cfg.edits.dirs) {
  const dir = path.resolve(cfgDir, dirSpec.path);
  for (const c of await readdir(path.join(dir, 'cases'))) {
    const t = await readJson(path.join(dir, 'cases', c, 'truth.json'));
    if (!dirSpec.takes.includes(t.take)) continue;
    const video = path.join(dir, 'videos', t.video);
    if (!existsSync(video)) continue;
    const inj = t.injected;
    // 只要单错误、设计好的同镜头组合、正确片、干扰项、对照；全部错误都必须是明显的
    const keep = t.tier === 'clean' || t.tier === 'decoy' || t.tier === 'control' || t.tier === 'single' || !!t.bundle;
    if (!keep) continue;
    if (inj.some((e) => !OBVIOUS.has(e.visibility) || SKIP_SUBS.has(e.sub))) continue;
    const input = await readJson(path.join(dir, 'cases', c, 'input.json'));
    const s = scenes.get(t.scene);
    const brief = sceneBrief(s, input.plan.captions.map((x) => x.text));
    // 字幕类：创意要求里的文案是正确版本，成片字幕是错的
    const capErr = inj.find((e) => e.sub === 'PF8');
    if (capErr) brief.copy = (s.injections.find((i) => i.id === capErr.id)?.control || []).map((o) => o.text);
    // 描述写「观众看到了什么不对」，不写制作手法；可在配置里按错误编号改写
    const errors = inj.map((e) => ({ ...cat(tax.from_v1[e.sub]), description: (cfg.edits.descriptions || {})[e.id] || e.description, windows: e.windows, from_v1: e.sub }));
    const kind = t.tier === 'decoy' ? `OK-decoy` : t.tier === 'control' ? 'OK-control' : t.tier === 'clean' ? 'OK' : [...new Set(errors.map((e) => e.category))].join('+');
    const id = `${kind}__${t.case_id.replace(/__(single|multi|combo|clean|decoy|control)__/, '__')}`;
    await emit({ id, brief, video, errors, source: 'edit', verified_by: dirSpec.verified_by[t.take] || 'none',
      note: (t.decoy ? `干扰项：${t.decoy.description}。` : '') + '注入错误由确定性剪辑/合成产生，已通过逐帧真值校验；底片干净与否见 verified_by' });
  }
}

// —— 3. 底片本身带人工确认错误的原片 ——
for (const b of [...(cfg.bases || []), ...(cfg.generated || []).map((g) => ({ ...g, source: 'generated' }))]) {
  const s = scenes.get(b.scene);
  const errors = b.errors.map((e) => ({ ...cat(e.category), description: e.description, windows: e.windows || null }));
  await emit({ id: `${[...new Set(errors.map((e) => e.category))].join('+')}__${b.id}`, brief: sceneBrief(s, []),
    video: path.resolve(cfgDir, b.path), errors, source: b.source || 'base', verified_by: b.verified_by || 'human', note: b.note || '人工复核确认' });
}

// —— 清单 ——
cases.sort((x, y) => x.id.localeCompare(y.id));
const VB = { human: '人工确认', claude: 'Claude 复核', none: '未复核' };
const row = (t) => `| [${t.id}](videos/${encodeURIComponent(t.video)}) | ${t.verdict === 'pass' ? '放行' : '拦截'} | ${t.errors.map((e) => `**${e.category} ${e.category_name}**：${e.description}`).join('<br>') || '—'} | ${t.source} | ${VB[t.verified_by]} |`;
await writeFile(path.join(out, 'INDEX.md'), ['# 用例清单', '', `共 ${cases.length} 条。`, '',
  '| 用例 | 结论 | 错误 | 来源 | 状态 |', '|---|---|---|---|---|', ...cases.map(row), ''].join('\n'));
const cnt = (f) => cases.reduce((m, t) => { for (const k of [].concat(f(t))) m[k] = (m[k] || 0) + 1; return m; }, {});
const summary = { total: cases.length, verdict: cnt((t) => t.verdict), by_category: cnt((t) => t.errors.map((e) => e.category)),
  by_source: cnt((t) => t.source), verified_by: cnt((t) => t.verified_by) };
await writeFile(path.join(out, 'summary.json'), J(summary));
console.log(J(summary));
