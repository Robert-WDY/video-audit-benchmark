// 用例展开：场景 × 底片 → clean / control / decoy / single / multi / combo。
// 每个用例产出三份互相隔离的数据：
//   gen     —— 怎么做出这条视频（剪辑操作、手工任务）；只给制作方
//   input   —— 审核能看到的东西，与线上 runQc 的 request/plan 同构；绝不含注入信息
//   truth   —— 真值，只给评分脚本和人工复核
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ConflictError, OVERLAY_OPS, applyOps, isPieceOp, resolveTime } from './timeline.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DEFAULT_TAXONOMY = path.join(ROOT, 'taxonomy.json');
export const DEFAULT_SCENES = path.join(ROOT, 'scenes');

export async function loadTaxonomy(file = DEFAULT_TAXONOMY) { return JSON.parse(await readFile(file, 'utf8')); }

export async function loadScenes(dir = DEFAULT_SCENES) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
}

const MANUAL_METHODS = new Set(['prompt', 'ref_edit', 'inpaint', 'splice', 'shoot']);
const TIME_KEYS = ['from', 'to', 'at', 'a_from', 'a_to', 'b_from', 'b_to', 'src_from'];
const DRIFT_SUBS = new Set(['PF1', 'PF2', 'PF3', 'PF4', 'PF5', 'PF6', 'VT2']);

// —— 校验 ——
export function validateScene(scene, tax) {
  const errs = []; const e = (m) => errs.push(`${scene.id || '?'}: ${m}`);
  for (const k of ['id', 'name', 'product', 'script', 'markers', 'injections']) if (!scene[k]) e(`缺少 ${k}`);
  if (!scene.product?.appearance) e('product.appearance 为空');
  if (!Array.isArray(scene.product?.facts) || !scene.product.facts.length) e('product.facts 为空');
  const markers = new Set([...Object.keys(scene.markers || {}), 'start', 'end']);
  const ids = new Set();
  const checkOps = (owner, ops) => {
    if (!Array.isArray(ops) || !ops.length) return e(`${owner}: ops 为空`);
    for (const o of ops) {
      if (o.op === 'manual') {
        if (!MANUAL_METHODS.has(o.method)) e(`${owner}: 手工方式 ${o.method} 未知`);
        if (!o.instruction) e(`${owner}: 手工操作缺少 instruction`);
      } else if (!isPieceOp(o.op) && !OVERLAY_OPS.has(o.op)) e(`${owner}: 未知操作 ${o.op}`);
      const times = [...TIME_KEYS.map((k) => o[k]), o.window?.from, o.window?.to].filter((v) => v !== undefined);
      for (const v of times) {
        if (typeof v === 'number') continue;
        const name = /^\s*([A-Za-z_]\w*)/.exec(String(v))?.[1];
        if (!markers.has(name)) e(`${owner}: 引用了未定义的标记点 ${v}`);
      }
    }
  };
  for (const inj of scene.injections || []) {
    if (ids.has(inj.id)) e(`重复的 id ${inj.id}`); ids.add(inj.id);
    if (!inj.id?.startsWith(`${scene.id}.`)) e(`${inj.id}: id 应以 ${scene.id}. 开头`);
    const cat = tax.categories[inj.category];
    if (!cat) { e(`${inj.id}: 未知类别 ${inj.category}`); continue; }
    if (!cat.subs[inj.sub]) e(`${inj.id}: 子类 ${inj.sub} 不属于 ${inj.category}`);
    for (const s of inj.secondary || []) {
      if (!Object.values(tax.categories).some((c) => c.subs[s])) e(`${inj.id}: 次类别 ${s} 未定义`);
    }
    if (!tax.evidence_levels[inj.evidence]) e(`${inj.id}: evidence ${inj.evidence} 未定义`);
    if (!tax.visibility_levels[inj.visibility]) e(`${inj.id}: visibility ${inj.visibility} 未定义`);
    if (!tax.dispositions[inj.disposition]) e(`${inj.id}: disposition ${inj.disposition} 未定义`);
    if (!inj.description) e(`${inj.id}: 缺少 description`);
    checkOps(inj.id, inj.ops);
    if (inj.ops?.filter((o) => o.op === 'manual').length > 1) e(`${inj.id}: 一个错误最多一个手工操作`);
    if (inj.control) checkOps(`${inj.id}.control`, inj.control);
  }
  for (const d of scene.decoys || []) {
    if (ids.has(d.id)) e(`重复的 id ${d.id}`); ids.add(d.id);
    if (!d.looks_like) e(`${d.id}: 干扰项需写明 looks_like（看起来像哪类错误）`);
    checkOps(d.id, d.ops);
  }
  for (const c of scene.chains || []) for (const id of c.ids || []) if (!ids.has(id)) e(`chains 引用了不存在的 ${id}`);
  for (const b of scene.bundles || []) {
    if (!Array.isArray(b.ids) || b.ids.length < 2) e('bundles 每组至少两个错误');
    for (const id of b.ids || []) if (!ids.has(id)) e(`bundles 引用了不存在的 ${id}`);
  }
  return errs;
}

export function validateTake(take, scene) {
  const errs = []; const e = (m) => errs.push(`${take.id}: ${m}`);
  if (!scene) return [`${take.id}: 场景 ${take.scene} 不存在`];
  if (!(take.duration > 0)) e('duration 必须大于 0');
  if (!['real', 'ai'].includes(take.kind)) e('kind 必须是 real 或 ai');
  for (const m of Object.keys(scene.markers || {})) {
    const v = take.markers?.[m];
    if (!Number.isFinite(v)) e(`缺少标记点 ${m}`);
    else if (v < 0 || v > take.duration) e(`标记点 ${m}=${v} 超出时长`);
  }
  const vals = Object.keys(scene.markers || {}).map((m) => take.markers?.[m]).filter(Number.isFinite);
  for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1]) e('标记点应按场景里定义的顺序递增');
  const regions = new Set();
  for (const x of [...scene.injections, ...(scene.decoys || [])]) {
    for (const o of [...x.ops, ...(x.control || [])]) if (typeof o.region === 'string') regions.add(o.region);
  }
  for (const r of regions) {
    const b = take.regions?.[r];
    if (!Array.isArray(b) || b.length !== 4 || b.some((v) => !(v >= 0 && v <= 1))) e(`区域 ${r} 需为 0-1 的 [x,y,w,h]`);
  }
  return errs;
}

// —— 解析 ——
export function resolveOps(ops, take, id) {
  const markers = { ...take.markers, start: 0, end: take.duration };
  return ops.map((o) => {
    const r = { ...o, id };
    for (const k of TIME_KEYS) if (o[k] !== undefined) r[k] = Math.min(take.duration, Math.max(0, resolveTime(o[k], markers)));
    if (o.window) r.window = { from: resolveTime(o.window.from, markers), to: resolveTime(o.window.to, markers) };
    if (typeof o.region === 'string') r.region = take.regions?.[o.region];
    return r;
  });
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const spanOf = (ws) => [Math.min(...ws.map((w) => w[0])), Math.max(...ws.map((w) => w[1]))];

export function durationBucket(windows, method, tax) {
  if (method === 'drop') return 'instant';
  const len = windows.reduce((s, w) => s + (w[1] - w[0]), 0);
  for (const [k, [lo, hi]] of Object.entries(tax.duration_buckets)) if (len >= lo && (hi === null || len < hi)) return k;
  return 'long';
}

function truthOf(inj, tax, windows) {
  const cat = tax.categories[inj.category];
  const main = inj.ops.find((o) => o.op === 'manual') || inj.ops[0];
  const method = main.op === 'manual' ? main.method : main.op;
  const ws = windows[inj.id];
  if (!ws?.length) throw new Error(`${inj.id}: 没有算出时间窗口`);
  return {
    id: inj.id, category: inj.category, sub: inj.sub, secondary: inj.secondary || [],
    category_name: cat.name, sub_name: cat.subs[inj.sub],
    evidence: inj.evidence, visibility: inj.visibility, disposition: inj.disposition,
    judge_basis: inj.judge_basis || cat.judge_basis,
    description: inj.description, method, auto: main.op !== 'manual',
    windows: ws, window_status: main.op === 'manual' ? 'estimated' : 'exact',
    duration_bucket: durationBucket(ws, method, tax),
    expected_checks: cat.reviewer_checks,
    expected_fix: DRIFT_SUBS.has(inj.sub) ? 'replace_plate' : 'regen',
  };
}

export function reviewInput(scene, overlays, duration, { withScript = false } = {}) {
  const facts = scene.product.facts.map((f, i) => ({ id: f.id || `F${i + 1}`, claim: f.claim, text: f.claim }));
  if (withScript) {
    const s = scene.script;
    const lines = [`镜头脚本-起始状态：${s.start_state}`,
      ...s.actions.map((a, i) => `镜头脚本-动作${i + 1}（${a.actor}）：${a.desc}`),
      `镜头脚本-终态：${s.end_state}`];
    lines.forEach((t, i) => facts.push({ id: `S${i + 1}`, claim: t, text: t }));
  }
  const captions = overlays.filter((o) => o.op === 'caption').map((o, i) => ({ id: `c${i + 1}`, text: o.text, shot: 's1' }));
  return {
    request: { product: { name: scene.product.name, appearance: scene.product.appearance, facts } },
    plan: { captions, shots: [{ id: 's1', kind: 'product', uses_product: true, use_s: [0, duration], dur: duration }] },
  };
}

export const blindId = (caseId, salt = '') => `v_${createHash('sha256').update(`${salt}|${caseId}`).digest('hex').slice(0, 10)}`;

// 组合关系：显式链式 > 掩盖（明显+细微且相近）> 时间重叠 > 时间分离
export function patternOf(errs, scene) {
  if ((scene.chains || []).some((c) => errs.every((e) => c.ids.includes(e.id)))) return 'chain';
  const spans = errs.map((e) => spanOf(e.windows));
  let minGap = Infinity;
  for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
    const [a, b] = [spans[i], spans[j]];
    minGap = Math.min(minGap, Math.max(0, Math.max(a[0], b[0]) - Math.min(a[1], b[1])));
  }
  const vis = new Set(errs.map((e) => e.visibility));
  if (vis.has('V1') && vis.has('V3') && minGap <= 2) return 'mask';
  return minGap === 0 ? 'overlap' : 'separate';
}

function makeCase({ tier, scene, take, tax, injections = [], extra = [], ref = null, decoy = null, salt }) {
  const manual = []; const ops = [];
  const addOps = (list, id) => {
    for (const o of resolveOps(list, take, id)) { (o.op === 'manual' ? manual : ops).push(o); }
  };
  for (const inj of injections) addOps(inj.ops, inj.id);
  for (const x of extra) addOps(x.ops, x.id ?? null);
  if (manual.length > 1) throw new ConflictError('一个用例最多一个手工步骤');
  // 手工操作的窗口要参与时间映射，所以一起交给 applyOps
  const tl = applyOps(take.duration, [...ops, ...manual]);
  const errors = injections.map((inj) => truthOf(inj, tax, tl.windows));
  const idPart = [...injections.map((i) => i.id), ...(decoy ? [decoy.id] : [])].join('+') || 'base';
  const caseId = `${take.id}__${tier}__${idPart}`;
  const pattern = errors.length > 1 ? patternOf(errors, scene) : null;
  // 时间轴没被剪过（只有一个正放片段）= 所有错误都在同一段连续镜头里，不是拼接
  const real = tl.pieces.filter((p) => !p.marker);
  const continuous = real.length === 1 && !!real[0].src && !real[0].rev && (real[0].speed || 1) === 1;
  const video = `${videoName(caseId, errors, decoy)}.mp4`;
  return {
    id: caseId, blind_id: blindId(caseId, salt), tier, pattern,
    gen: {
      case_id: caseId, scene: scene.id, take: take.id, source: take.path,
      needs_manual: manual.length > 0, manual_tasks: manual.map((m) => ({ for: m.id, method: m.method, instruction: m.instruction })),
      ops, pieces: tl.pieces, overlays: tl.overlays, duration: tl.duration,
    },
    input: reviewInput(scene, tl.overlays, tl.duration),
    input_script: reviewInput(scene, tl.overlays, tl.duration, { withScript: true }),
    truth: {
      case_id: caseId, blind_id: blindId(caseId, salt), video, tier, pattern, continuous, ref,
      scene: scene.id, take: take.id, source_kind: take.kind, baseline_verified: !!take.verified_clean,
      duration: r3(tl.duration), decoy: decoy ? { id: decoy.id, looks_like: decoy.looks_like, description: decoy.description } : null,
      should_block: errors.some((e) => e.disposition !== 'accept'),
      injected: errors, actual: null, annotation_status: 'pending',
    },
  };
}

// 对照组只做「内容对照」（例如同位置的正确字幕）。只切不改的对照渲染出来与正确底片逐帧相同，
// 正确底片本身也走同一条编码管线，所以不再生成。
function controlFor(single, inj, scene, take, tax, salt) {
  if (!inj.control) return null;
  const extra = [{ id: null, ops: inj.control.map((o) => ({ ...o, control: true })) }];
  const c = makeCase({ tier: 'control', scene, take, tax, extra, ref: single.id, salt });
  c.id = `${take.id}__control__${inj.id}`;
  c.gen.case_id = c.id; c.truth.case_id = c.id;
  c.blind_id = c.truth.blind_id = blindId(c.id, salt);
  return c;
}

const AUDIO_OPS = new Set(['mute']);
export const isAudioOnly = (inj) => inj.ops.every((o) => AUDIO_OPS.has(o.op));

// 把相邻、连续、同方向同速度的片段合并，得到与切点无关的规范形式
function canonicalPieces(pieces) {
  const out = [];
  for (const p of pieces) {
    if (p.marker) continue;
    const q = { ...p, tag: undefined };
    const last = out[out.length - 1];
    if (last && last.src && q.src && !last.rev && !q.rev && (last.speed || 1) === (q.speed || 1) && Math.abs(last.src[1] - q.src[0]) < 1e-4) {
      last.src = [last.src[0], q.src[1]];
    } else out.push(q);
  }
  return out.map((p) => (p.src ? { src: p.src.map((x) => +x.toFixed(3)), rev: !!p.rev, speed: p.speed || 1 } : p.hold !== undefined ? { hold: p.hold, dur: p.dur } : { black: p.black }));
}

// 用例的画面指纹：规范化的片段 + 所有改变画面的叠加层。两条用例指纹相同 = 画面逐帧相同
export function visualSignature(c) {
  const ov = c.gen.overlays.filter((o) => !AUDIO_OPS.has(o.op))
    .map((o) => ({ op: o.op, out: o.out, text: o.text, region: o.region, hue: o.hue, key: o.key, color: o.color, frames: o.frames }));
  // 手工步骤会产生不同的素材，必须计入指纹，否则会被误判为与正确底片相同
  const manual = c.gen.manual_tasks.map((m) => `${m.for}|${m.method}|${m.instruction}`);
  return JSON.stringify([canonicalPieces(c.gen.pieces), ov, manual]);
}

// 可读文件名：底片__类型__错误编号__子类，例如 S05-h3b__combo__S05.I2+S05.I4__PF8+PF5
export function videoName(caseId, errors, decoy) {
  const tag = errors.length ? errors.map((e) => e.sub).join('+') : decoy ? `looks-${decoy.looks_like}` : 'ok';
  return `${caseId}__${tag}`.replace(/[^\w.+-]/g, '_');
}

function pairs(xs) { const out = []; for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]]); return out; }

// 按组合关系轮转挑选，保证 chain/mask/overlap/separate 都有代表
function pickDiverse(cands, cap) {
  const by = new Map();
  // 同一模式内，时间轴未剪辑（同一连续镜头）的组合排在前面
  const sorted = [...cands].sort((a, b) => Number(b.truth.continuous) - Number(a.truth.continuous));
  for (const c of sorted) { const k = c.pattern; if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
  const order = ['chain', 'mask', 'overlap', 'separate'].filter((k) => by.has(k));
  const out = [];
  while (out.length < cap && order.some((k) => by.get(k).length)) {
    for (const k of order) { const q = by.get(k); if (q.length && out.length < cap) out.push(q.shift()); }
  }
  return out;
}

export function expand(scenes, takes, tax, { maxMultiPerTake = 3, maxComboPerTake = 6, salt = 'vr1', skipped = [] } = {}) {
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const cases = [];
  const tryMake = (args) => {
    try { return makeCase({ ...args, tax, salt }); } catch (e) {
      if (e instanceof ConflictError) { skipped.push({ take: args.take.id, ids: (args.injections || []).map((i) => i.id), reason: e.message }); return null; }
      throw e;
    }
  };
  for (const take of takes) {
    const scene = byId.get(take.scene);
    const base = { scene, take };
    cases.push(tryMake({ ...base, tier: 'clean' }));
    for (const d of scene.decoys || []) cases.push(tryMake({ ...base, tier: 'decoy', extra: [{ id: null, ops: d.ops }], decoy: d }));
    for (const inj of scene.injections) {
      const s = tryMake({ ...base, tier: 'single', injections: [inj] });
      if (!s) continue;
      cases.push(s);
      try { cases.push(controlFor(s, inj, scene, take, tax, salt)); } catch (e) { if (!(e instanceof ConflictError)) throw e; }
    }
    const isManual = (inj) => inj.ops.some((o) => o.op === 'manual');
    const combos = []; const multis = [];
    let audioCombo = false;
    for (const [a, b] of pairs(scene.injections)) {
      if (isManual(a) && isManual(b)) continue;
      // 纯声音错误和画面错误组合后，画面与那个单错误完全相同；每条底片只保留一个这种组合
      const audio = isAudioOnly(a) || isAudioOnly(b);
      if (audio && audioCombo) continue;
      const c = tryMake({ ...base, tier: a.category === b.category ? 'multi' : 'combo', injections: [a, b] });
      if (!c) continue;
      if (audio) audioCombo = true;
      (c.tier === 'multi' ? multis : combos).push(c);
    }
    // 场景里显式定义的「同一镜头多错误」组合：数量不限，不占名额
    const bundles = [];
    for (const bd of scene.bundles || []) {
      const injs = bd.ids.map((id) => scene.injections.find((i) => i.id === id));
      const cats = new Set(injs.map((i) => i.category));
      const c = tryMake({ ...base, tier: cats.size === 1 ? 'multi' : 'combo', injections: injs });
      if (c) { c.truth.bundle = bd.note || null; bundles.push(c); }
    }
    for (const ch of scene.chains || []) {
      if (ch.ids.length < 3) continue;
      const injs = ch.ids.map((id) => scene.injections.find((i) => i.id === id));
      const c = tryMake({ ...base, tier: 'combo', injections: injs });
      if (c) combos.push(c);
    }
    cases.push(...bundles, ...pickDiverse(multis, maxMultiPerTake), ...pickDiverse(combos, maxComboPerTake));
  }
  // 兜底去重：画面和声音都相同的用例只留第一个；只有声音不同的，标出它与哪条画面相同
  const out = []; const seen = new Map();
  for (const c of cases.filter(Boolean)) {
    const audio = JSON.stringify(c.gen.overlays.filter((o) => AUDIO_OPS.has(o.op)).map((o) => o.out));
    const vis = `${c.truth.take}|${visualSignature(c)}`;
    const full = `${vis}|${audio}|${JSON.stringify(c.input.plan.captions)}`;
    if (seen.has(full)) { skipped.push({ take: c.truth.take, ids: c.truth.injected.map((e) => e.id), reason: `与 ${seen.get(full)} 完全相同` }); continue; }
    seen.set(full, c.id);
    const twin = out.find((x) => `${x.truth.take}|${visualSignature(x)}` === vis);
    if (twin) c.truth.same_picture_as = twin.id;
    out.push(c);
  }
  return out;
}

export function summarizeCases(cases) {
  const count = (f) => cases.reduce((m, c) => { for (const k of [].concat(f(c))) m[k] = (m[k] || 0) + 1; return m; }, {});
  const errs = cases.flatMap((c) => c.truth.injected.map((e) => ({ ...e, tier: c.tier })));
  const ecount = (f) => errs.reduce((m, e) => { const k = f(e); m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    cases: cases.length,
    by_tier: count((c) => c.tier),
    by_pattern: count((c) => c.pattern || '-'),
    needs_manual: cases.filter((c) => c.gen.needs_manual).length,
    errors: errs.length,
    errors_by_category: ecount((e) => e.category),
    errors_by_evidence: ecount((e) => e.evidence),
    errors_by_visibility: ecount((e) => e.visibility),
    errors_by_duration: ecount((e) => e.duration_bucket),
    errors_by_basis: ecount((e) => e.judge_basis),
  };
}
