// 时间轴剪辑模型：把一条底片表示为有序片段（piece），错误注入 = 对片段做变换。
// 片段全部用「源时间」描述，变换后统一计算「输出时间」，所以真值窗口精确到帧且可组合。
//
// piece 形态：
//   { src: [a, b], rev, speed, tag }   源视频 [a,b] 段；rev 倒放；speed 播放速度
//   { hold: t, dur, tag }              定格在源时间 t 的一帧，持续 dur 秒
//   { black: dur, tag }                黑场 dur 秒
//   { marker: true, tag }              零时长标记（抽帧处的跳变点）
// tag 是注入错误的 id（或 null）。

const EPS = 1e-6;

export class ConflictError extends Error {
  constructor(msg) { super(msg); this.name = 'ConflictError'; }
}

// 时间值：数字，或 "marker"、"marker+0.5"、"marker-0.3"
export function resolveTime(v, markers = {}) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = /^\s*([A-Za-z_][\w]*)\s*(?:([+-])\s*([\d.]+))?\s*$/.exec(String(v ?? ''));
  if (!m) throw new Error(`无法解析时间值: ${JSON.stringify(v)}`);
  if (!(m[1] in markers)) throw new Error(`底片缺少标记点 ${m[1]}`);
  const base = Number(markers[m[1]]);
  if (!Number.isFinite(base)) throw new Error(`标记点 ${m[1]} 不是数字`);
  return m[2] ? base + (m[2] === '+' ? 1 : -1) * Number(m[3]) : base;
}

export const pieceDur = (p) => {
  if (p.src) return (p.src[1] - p.src[0]) / (p.speed || 1);
  if (p.hold !== undefined) return p.dur;
  if (p.black !== undefined) return p.black;
  return 0;
};

export const totalDur = (pieces) => pieces.reduce((s, p) => s + pieceDur(p), 0);

export function initial(duration) {
  if (!(duration > 0)) throw new Error('底片时长必须大于 0');
  return [{ src: [0, duration], rev: false, speed: 1, tag: null }];
}

// 在源时间 t 处切开所有覆盖 t 的片段（倒放片段切开后顺序也要倒过来）
export function splitAt(pieces, t) {
  const out = [];
  for (const p of pieces) {
    if (p.src && p.src[0] + EPS < t && t < p.src[1] - EPS) {
      const a = { ...p, src: [p.src[0], t] };
      const b = { ...p, src: [t, p.src[1]] };
      out.push(...(p.rev ? [b, a] : [a, b]));
    } else out.push(p);
  }
  return out;
}

// 源时间 [from,to] 内的片段下标；要求是一段连续的、未被其他错误占用的正放片段
function claim(pieces, from, to, id) {
  if (!(to > from + EPS)) throw new Error(`区间无效: [${from}, ${to}]`);
  let ps = splitAt(splitAt(pieces, from), to);
  const idx = [];
  ps.forEach((p, i) => { if (p.src && p.src[0] >= from - EPS && p.src[1] <= to + EPS) idx.push(i); });
  if (!idx.length) throw new ConflictError(`${id}: 源区间 [${from}, ${to}] 已不存在（可能被其他错误剪掉）`);
  for (let k = 1; k < idx.length; k++) {
    if (idx[k] !== idx[k - 1] + 1) throw new ConflictError(`${id}: 源区间 [${from}, ${to}] 不连续`);
  }
  for (const i of idx) {
    const p = ps[i];
    if (p.tag && p.tag !== id) throw new ConflictError(`${id}: 与 ${p.tag} 作用于同一段画面`);
    if (p.rev || (p.speed || 1) !== 1) throw new ConflictError(`${id}: 源区间已被倒放或变速`);
  }
  const covered = idx.reduce((s, i) => s + (ps[i].src[1] - ps[i].src[0]), 0);
  if (Math.abs(covered - (to - from)) > 1e-3) throw new ConflictError(`${id}: 源区间 [${from}, ${to}] 部分已被剪掉`);
  return { ps, idx };
}

// 源时间 t 之后的插入位置：第一个以 t 结尾的正放片段之后
function insertIndex(pieces, t, id) {
  const ps = splitAt(pieces, t);
  const i = ps.findIndex((p) => p.src && !p.rev && Math.abs(p.src[1] - t) < 1e-4);
  if (i >= 0) return { ps, at: i + 1 };
  if (t <= EPS) return { ps, at: 0 };
  throw new ConflictError(`${id}: 找不到源时间 ${t} 的插入点`);
}

const clone = (ps, idx, tag) => idx.map((i) => ({ ...ps[i], tag }));

// 片段级操作。spec 里的时间已解析成数字。返回新的 pieces。
export const PIECE_OPS = {
  // 倒放 [from,to]：动作反向、液体倒流、状态回跳
  reverse(pieces, { from, to }, id) {
    const { ps, idx } = claim(pieces, from, to, id);
    const seg = idx.map((i) => ({ ...ps[i], rev: true, tag: id })).reverse();
    return [...ps.slice(0, idx[0]), ...seg, ...ps.slice(idx[idx.length - 1] + 1)];
  },
  // 剪掉 [from,to]：瞬移、动作缺失、有果无因
  drop(pieces, { from, to }, id) {
    const { ps, idx } = claim(pieces, from, to, id);
    return [...ps.slice(0, idx[0]), { marker: true, tag: id }, ...ps.slice(idx[idx.length - 1] + 1)];
  },
  // [from,to] 播完后再播一遍：动作重复
  repeat(pieces, { from, to }, id) {
    const { ps, idx } = claim(pieces, from, to, id);
    const end = idx[idx.length - 1] + 1;
    return [...ps.slice(0, end), ...clone(ps, idx, id), ...ps.slice(end)];
  },
  // 把源 [from,to] 复制一份插到源时间 at 之后：状态回跳、物体重新出现
  insert(pieces, { from, to, at }, id) {
    const c = claim(pieces, from, to, id);
    const copy = clone(c.ps, c.idx, id).map((p) => ({ ...p, tag: id }));
    // 原片段只是被借来复制，不应占用
    const base = c.ps.map((p) => (p.tag === id ? { ...p, tag: null } : p));
    const { ps, at: k } = insertIndex(base, at, id);
    if (at > from + EPS && at < to - EPS) throw new ConflictError(`${id}: 插入点落在被复制区间内`);
    return [...ps.slice(0, k), ...copy, ...ps.slice(k)];
  },
  // 交换两段：[a_from,a_to] 与 [b_from,b_to]（a 在前）：顺序颠倒
  swap(pieces, { a_from, a_to, b_from, b_to }, id) {
    if (!(a_to <= b_from + EPS)) throw new Error(`${id}: swap 要求 a 段在 b 段之前`);
    let { ps } = claim(pieces, a_from, a_to, id);
    ({ ps } = claim(ps, b_from, b_to, id));
    const inA = (p) => p.src && !p.rev && p.src[0] >= a_from - EPS && p.src[1] <= a_to + EPS;
    const inB = (p) => p.src && !p.rev && p.src[0] >= b_from - EPS && p.src[1] <= b_to + EPS;
    const ia = ps.findIndex(inA); const ja = ps.length - 1 - [...ps].reverse().findIndex(inA);
    const ib = ps.findIndex(inB); const jb = ps.length - 1 - [...ps].reverse().findIndex(inB);
    const A = ps.slice(ia, ja + 1).map((p) => ({ ...p, tag: id }));
    const B = ps.slice(ib, jb + 1).map((p) => ({ ...p, tag: id }));
    return [...ps.slice(0, ia), ...B, ...ps.slice(ja + 1, ib), ...A, ...ps.slice(jb + 1)];
  },
  // 在源时间 at 之后插入定格帧
  freeze(pieces, { at, dur }, id) {
    if (!(dur > 0)) throw new Error(`${id}: freeze 需要 dur > 0`);
    const { ps, at: k } = insertIndex(pieces, at, id);
    return [...ps.slice(0, k), { hold: Math.max(0, at - 1 / 60), dur, tag: id }, ...ps.slice(k)];
  },
  // 在源时间 at 之后插入黑场
  black(pieces, { at, dur }, id) {
    if (!(dur > 0)) throw new Error(`${id}: black 需要 dur > 0`);
    const { ps, at: k } = insertIndex(pieces, at, id);
    return [...ps.slice(0, k), { black: dur, tag: id }, ...ps.slice(k)];
  },
  // 变速（干扰项：刻意慢动作）
  slow(pieces, { from, to, factor }, id) {
    if (!(factor >= 0.5 && factor <= 2)) throw new Error(`${id}: slow.factor 需在 [0.5, 2]`);
    const { ps, idx } = claim(pieces, from, to, id);
    for (const i of idx) ps[i] = { ...ps[i], speed: factor, tag: id };
    return ps;
  },
  // 只切不改：对照组用，复现错误样本同样的剪辑点和重编码
  cut(pieces, { at }) {
    return splitAt(pieces, at);
  },
};

// 叠加层操作在拼接后的输出时间上生效；spec 用源时间写，渲染前映射
export const OVERLAY_OPS = new Set(['tint', 'caption', 'mute', 'flash', 'clone', 'freeze_region', 'retime_region', 'flip_region', 'scale_region', 'warp_region', 'text_overlay', 'zoom', 'grade', 'av_offset']);
// 局部操作：只改画面的一块区域，时间轴不动，可以和其他错误在同一段连续镜头里叠加
export const LOCAL_OPS = new Set(['tint', 'clone', 'freeze_region', 'retime_region', 'flip_region', 'scale_region', 'warp_region', 'text_overlay']);

export function isPieceOp(op) { return Object.hasOwn(PIECE_OPS, op); }

// 源时间 → 输出时间：取第一个覆盖 t 的正放片段
export function srcToOut(pieces, t) {
  let cur = 0;
  for (const p of pieces) {
    const d = pieceDur(p);
    if (p.src && !p.rev && t >= p.src[0] - EPS && t <= p.src[1] + EPS) {
      return cur + (t - p.src[0]) / (p.speed || 1);
    }
    cur += d;
  }
  return null;
}

// 每个 tag 在输出中的时间窗口（同一 tag 的不连续片段合并成多个窗口）
export function tagWindows(pieces, { markerPad = 0.3 } = {}) {
  const map = new Map(); let cur = 0;
  const push = (tag, w) => {
    const arr = map.get(tag) || [];
    const last = arr[arr.length - 1];
    if (last && w[0] <= last[1] + 1e-4) last[1] = Math.max(last[1], w[1]); else arr.push([...w]);
    map.set(tag, arr);
  };
  for (const p of pieces) {
    const d = pieceDur(p);
    if (p.tag) push(p.tag, p.marker ? [Math.max(0, cur - markerPad), cur + markerPad] : [cur, cur + d]);
    cur += d;
  }
  return map;
}

// 片段的切点（源时间），用来给对照组复现同样的剪辑边界
export function cutPoints(pieces) {
  const pts = new Set();
  for (const p of pieces) if (p.src) { pts.add(+p.src[0].toFixed(4)); pts.add(+p.src[1].toFixed(4)); }
  return [...pts].sort((a, b) => a - b);
}

const round = (x) => Math.round(x * 1000) / 1000;

// 把一组已解析的操作应用到底片上，返回片段、叠加层（输出时间）与每个错误的输出窗口
export function applyOps(duration, ops) {
  let pieces = initial(duration);
  const overlaySpecs = [];
  for (const o of ops) {
    if (o.op === 'manual') continue;
    if (OVERLAY_OPS.has(o.op)) { overlaySpecs.push(o); continue; }
    if (!isPieceOp(o.op)) throw new Error(`未知操作 ${o.op}`);
    pieces = PIECE_OPS[o.op](pieces, o, o.id);
  }
  const windows = {};
  for (const [tag, ws] of tagWindows(pieces)) windows[tag] = ws.map((w) => w.map(round));
  const overlays = [];
  const outDur = totalDur(pieces);
  for (const o of overlaySpecs) {
    const from = o.op === 'flash' ? o.at : o.from;
    const to = o.op === 'flash' ? o.at : o.to;
    const s = srcToOut(pieces, from); const e = srcToOut(pieces, to);
    if (s === null || e === null) throw new ConflictError(`${o.id}: 叠加层所在画面已被剪掉`);
    const ov = { ...o, out: [round(s), round(o.op === 'flash' ? s + (o.frames || 1) / 30 : Math.min(e, outDur))] };
    overlays.push(ov);
    if (o.id && !o.control) windows[o.id] = [...(windows[o.id] || []), ov.out];
  }
  // 手工操作：窗口按源时间映射（估计值，人工审核时校准）
  for (const o of ops) {
    if (o.op !== 'manual' || !o.window) continue;
    const s = srcToOut(pieces, o.window.from); const e = srcToOut(pieces, o.window.to);
    if (s === null || e === null) throw new ConflictError(`${o.id}: 手工错误所在画面已被剪掉`);
    windows[o.id] = [[round(s), round(e)]];
  }
  return { pieces, overlays, windows, duration: round(outDur) };
}

// 底片上一段源时间 [a,b] 在输出里出现在哪些窗口（考虑倒放、变速、重复、定格；被剪掉的部分不出现）
export function srcWindowToOut(pieces, [a, b]) {
  const out = []; let cur = 0;
  for (const p of pieces) {
    const d = pieceDur(p);
    if (p.src) {
      const s = Math.max(a, p.src[0]); const e = Math.min(b, p.src[1]);
      if (e > s + EPS || (Math.abs(a - b) < EPS && a >= p.src[0] - EPS && a <= p.src[1] + EPS)) {
        const sp = p.speed || 1;
        const w = p.rev ? [cur + (p.src[1] - e) / sp, cur + (p.src[1] - s) / sp] : [cur + (s - p.src[0]) / sp, cur + (e - p.src[0]) / sp];
        out.push(w);
      }
    } else if (p.hold !== undefined && p.hold >= a - EPS && p.hold <= b + EPS) out.push([cur, cur + d]);
    cur += d;
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const w of out) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1] + 1e-3) last[1] = Math.max(last[1], w[1]); else merged.push([...w]);
  }
  return merged.map((w) => w.map((x) => Math.round(x * 1000) / 1000));
}
