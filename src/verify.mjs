// 真值准确性校验：把每条样本逐帧对照同一底片的正确视频。
//   1. 真值窗口之外，画面必须与正确视频一致（剪辑过的样本按片段映射回源时间再比）；
//   2. 每个画面类错误的窗口之内，必须能测到明显变化（否则错误没有真正做出来）。
// 比较用「明显变化的像素占比」（RGB 任一通道），对编码噪声不敏感；只换颜色不换亮度的错误也能测到。
// 剪辑样本有 1～2 帧的取整误差，比较时取前后几帧中最接近的一帧。纯声音错误不在这里检查。
import { spawn } from 'node:child_process';

export const W = 128; export const H = 224;
const AUDIO = new Set(['mute', 'av_offset']);
const PIX_DIFF = 28;          // 单个像素灰度差超过这个值算「明显变化」
const OUTSIDE_MAX = 0.004;    // 窗口外：明显变化像素占比上限
const INSIDE_MIN = 0.0008;    // 窗口内：整帧至少要有这么多像素明显变化（约 23 个像素）
const REGION_MIN = 0.01;      // 有区域的局部错误：区域内至少 1% 的像素明显变化（小部件如指示灯按区域算才公平；按颜色换色只改区域里的一部分像素）
const PAD = 0.12;             // 窗口边缘容差（秒）：编码参考帧会把变化带到相邻一两帧
const SLACK = 2;              // 帧对齐容差：剪辑后的取整误差

export function decodeGray(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H},format=rgb24`, '-f', 'rawvideo', 'pipe:1']);
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim().slice(0, 200)));
      const buf = Buffer.concat(out); const n = W * H * 3; const frames = [];
      for (let i = 0; i + n <= buf.length; i += n) frames.push(buf.subarray(i, i + n));
      resolve(frames);
    });
  });
}

export function changedFraction(a, b, box = null) {
  // box: [x, y, w, h]（0-1），只统计这个区域内的像素
  const [x0, y0, x1, y1] = box ? [Math.floor(box[0] * W), Math.floor(box[1] * H), Math.ceil((box[0] + box[2]) * W), Math.ceil((box[1] + box[3]) * H)] : [0, 0, W, H];
  let c = 0; let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const i = (y * W + x) * 3; n++;
      if (Math.abs(a[i] - b[i]) > PIX_DIFF || Math.abs(a[i + 1] - b[i + 1]) > PIX_DIFF || Math.abs(a[i + 2] - b[i + 2]) > PIX_DIFF) c++;
    }
  }
  return n ? c / n : 0;
}

// 输出时间 t 对应底片源时间；落在被打上标记（错误）的片段、定格、黑场里时返回 null
export function sourceTime(pieces, t, { ignoreTag = false } = {}) {
  let cur = 0;
  for (const p of pieces) {
    const d = p.src ? (p.src[1] - p.src[0]) / (p.speed || 1) : p.hold !== undefined ? p.dur : p.black !== undefined ? p.black : 0;
    if (t < cur + d - 1e-6) {
      if (!p.src || (p.tag && !ignoreTag)) return null;
      const off = (t - cur) * (p.speed || 1);
      return p.rev ? p.src[1] - off : p.src[0] + off;
    }
    cur += d;
  }
  return null;
}

const inAny = (t, ws, pad = PAD) => ws.some(([s, e]) => t >= s - pad && t <= e + pad);

// 返回 { status, problems[], stats }
export function verifyCase({ gen, truth }, caseFrames, cleanFrames, fps) {
  const problems = [];
  // 允许变化的窗口：画面类注入错误 + 对照/干扰项的叠加层（它们本来就会改画面）
  const visualErr = truth.injected.filter((e) => !AUDIO.has(e.method));
  const allowed = [...visualErr.flatMap((e) => e.windows),
    ...gen.overlays.filter((o) => !AUDIO.has(o.op) && (!o.id || o.control)).map((o) => o.out)];
  // 干扰项的整片操作（调色、推近）从窗口开始一直影响到结尾
  for (const o of gen.overlays) if (['grade', 'zoom'].includes(o.op)) allowed.push([o.out[0], 1e9]);
  let worst = { t: null, frac: 0 };
  const best = (f, s) => {
    const j = Math.round(s * fps); let m = 1;
    for (let k = Math.max(0, j - SLACK); k <= Math.min(cleanFrames.length - 1, j + SLACK); k++) m = Math.min(m, changedFraction(f, cleanFrames[k]));
    return m;
  };
  const perFrame = caseFrames.map((f, i) => {
    const t = i / fps;
    const s = sourceTime(gen.pieces, t);
    // 叠在剪辑片段上的画面错误（例如字幕叠在被换序的片段上）：忽略片段标记，用片段自己的源时间比较
    const s2 = s === null ? sourceTime(gen.pieces, t, { ignoreTag: true }) : s;
    return { t, frac: s === null ? null : best(f, s), any: s2 === null ? null : (s === null ? best(f, s2) : null) };
  });
  for (const { t, frac } of perFrame) {
    if (frac === null || inAny(t, allowed)) continue;
    if (frac > worst.frac) worst = { t, frac };
  }
  if (worst.frac > OUTSIDE_MAX) problems.push({ kind: 'unintended_change', t: +worst.t.toFixed(2), frac: +worst.frac.toFixed(4) });
  // 每个画面类错误：窗口内要有可测变化。剪辑类错误（片段被标记）本身就是画面重排，视为可见
  for (const e of visualErr) {
    const tagged = gen.pieces.some((p) => p.tag === e.id);
    if (tagged) continue;
    // 有区域的局部错误按区域内比例判断（文字叠加的区域只给了位置，按整帧判断）
    const ov = gen.overlays.find((o) => o.id === e.id && Array.isArray(o.region) && o.op !== 'text_overlay');
    let box = ov?.region || null;
    // 区域复制的变化发生在目标位置；拉伸会超出原区域（向上、向两侧）
    if (ov?.op === 'clone') box = [box[0] + (ov.dx || 0), box[1] + (ov.dy || 0), box[2], box[3]];
    if (ov?.op === 'scale_region') { const sw = box[2] * (ov.sx ?? 1); const sh = box[3] * (ov.sy ?? 1); box = [box[0] - (sw - box[2]) / 2, box[1] - (sh - box[3]), sw, sh]; }
    const idx = perFrame.map((x, i) => ({ i, t: x.t, s: x.frac !== null ? sourceTime(gen.pieces, x.t) : sourceTime(gen.pieces, x.t, { ignoreTag: true }) }))
      .filter(({ t, s }) => s !== null && inAny(t, e.windows, 0));
    let max = 0;
    for (const { i, s } of idx) {
      const j = Math.round(s * fps); let m = 1;
      for (let k = Math.max(0, j - SLACK); k <= Math.min(cleanFrames.length - 1, j + SLACK); k++) m = Math.min(m, changedFraction(caseFrames[i], cleanFrames[k], box));
      max = Math.max(max, m);
    }
    if (!idx.length || max < (box ? REGION_MIN : INSIDE_MIN)) problems.push({ kind: 'not_visible', error: e.id, max: +max.toFixed(5), scope: box ? 'region' : 'frame' });
  }
  return { status: problems.length ? 'problem' : 'ok', problems, stats: { frames: caseFrames.length, worst_outside: +worst.frac.toFixed(4) } };
}
