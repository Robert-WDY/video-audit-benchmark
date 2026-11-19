// 人工复核流程（两轮）：
//   第一轮 盲审：标注员只拿到 blind_id 命名的视频和空白表，不知道注入了什么，独立找出所有错误。
//   第二轮 复核：把盲审结果和注入记录并排，逐条裁定 present / partial / absent / accidental / reject。
//   定稿：按裁定生成 truth.actual，评分只认定稿后的 actual。

const tolOf = (tax) => tax?.matching?.time_tolerance_s ?? 1;

// —— CSV（RFC 4180 子集；输出带 BOM 方便 Excel 打开中文）——
export function toCsv(header, rows) {
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [header, ...rows.map((r) => header.map((h) => r[h]))].map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

export function parseCsv(text) {
  const s = text.replace(/^﻿/, ''); const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((x) => x.trim() !== ''));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

export const BLIND_HEADER = ['blind_id', 'video_file', 'duration_s', 'has_error', 'category', 'sub', 't_start', 't_end', 'visibility', 'disposition', 'note'];

// 打乱顺序，避免同一场景的用例挨在一起被对比出差异
export function blindSheet(truths, { seed = 1 } = {}) {
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 2 ** 32; };
  const rows = truths.map((t) => ({ blind_id: t.blind_id, video_file: `${t.blind_id}.mp4`, duration_s: t.duration,
    has_error: '', category: '', sub: '', t_start: '', t_end: '', visibility: '', disposition: '', note: '' }));
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  return toCsv(BLIND_HEADER, rows);
}

// 盲审表 → 按 blind_id 汇总的标注；一个错误一行，同一视频多个错误就复制多行
export function readBlind(rows, annotator) {
  const by = new Map();
  for (const raw of rows) {
    const r = Object.fromEntries(BLIND_HEADER.map((h) => [h, String(raw[h] ?? '').trim()]));
    if (!r.blind_id) continue;
    if (!by.has(r.blind_id)) by.set(r.blind_id, { judged: false, errors: [] });
    const v = by.get(r.blind_id);
    const has = /^(是|有|y|yes|1|true)$/i.test(r.has_error);
    const no = /^(否|无|n|no|0|false)$/i.test(r.has_error);
    if (has || no) v.judged = true;
    if (has && (r.category || r.t_start)) {
      const s = Number(r.t_start); const e = r.t_end === '' ? s : Number(r.t_end);
      if (!Number.isFinite(s)) throw new Error(`${annotator}: ${r.blind_id} 的 t_start 不是数字`);
      v.errors.push({ annotator, category: r.category.toUpperCase(), sub: r.sub.toUpperCase(), window: [Math.min(s, e), Math.max(s, e)],
        visibility: r.visibility, disposition: r.disposition, note: r.note });
    }
  }
  return by;
}

const overlaps = (w, ws, tol) => ws.some(([s, e]) => w[0] <= e + tol && w[1] >= s - tol);

export const RECONCILE_HEADER = ['blind_id', 'case_id', 'kind', 'ref', 'category', 'sub', 'description', 't_start', 't_end',
  'blind_hits', 'suggested', 'verdict', 'disposition', 'note'];

export function reconcileSheet(truths, blinds, tax) {
  const tol = tolOf(tax); const rows = [];
  for (const t of truths) {
    const anns = blinds.flatMap((b) => b.get(t.blind_id)?.errors || []);
    const used = new Set();
    for (const e of [...t.injected, ...(t.base_errors || [])]) {
      const hits = anns.filter((a) => overlaps(a.window, e.windows, tol));
      hits.forEach((h) => used.add(h));
      const span = [Math.min(...e.windows.map((w) => w[0])), Math.max(...e.windows.map((w) => w[1]))];
      rows.push({ blind_id: t.blind_id, case_id: t.case_id, kind: e.source === 'base' ? 'base' : 'injected', ref: e.id, category: e.category, sub: e.sub,
        description: e.description, t_start: span[0], t_end: span[1],
        blind_hits: `${hits.length}/${blinds.length}` + (hits.length ? ` (${hits.map((h) => `${h.annotator}:${h.category}${h.sub ? '/' + h.sub : ''}`).join(' ')})` : ''),
        suggested: e.source === 'base' ? 'present（底片已人工确认）' : hits.length ? 'present' : (e.auto ? 'present?' : 'absent?'), verdict: '', disposition: e.disposition, note: '' });
    }
    anns.filter((a) => !used.has(a)).forEach((a, i) => rows.push({ blind_id: t.blind_id, case_id: t.case_id, kind: 'blind',
      ref: `${a.annotator}#${i + 1}`, category: a.category, sub: a.sub, description: a.note, t_start: a.window[0], t_end: a.window[1],
      blind_hits: '', suggested: 'accidental?', verdict: '', disposition: a.disposition || 'block', note: '' }));
    if (!t.injected.length && !(t.base_errors || []).length && !anns.length) {
      rows.push({ blind_id: t.blind_id, case_id: t.case_id, kind: 'none', ref: '', category: '', sub: '', description: t.decoy ? `干扰项：${t.decoy.description}` : '正确视频',
        t_start: '', t_end: '', blind_hits: `0/${blinds.length}`, suggested: 'clean', verdict: '', disposition: '', note: '' });
    }
  }
  return toCsv(RECONCILE_HEADER, rows);
}

const VERDICTS = new Set(['present', 'partial', 'absent', 'accidental', 'reject', 'clean', 'ignore']);

// 复核表 → 定稿真值。返回新的 truth 列表，以及未裁定的行（有的话不定稿）
export function finalize(truths, rows, tax) {
  const byCase = new Map();
  for (const r of rows) { if (!byCase.has(r.case_id)) byCase.set(r.case_id, []); byCase.get(r.case_id).push(r); }
  const pending = []; const out = [];
  for (const t of truths) {
    const rs = byCase.get(t.case_id);
    if (!rs) { out.push(t); continue; }
    const bad = rs.filter((r) => !VERDICTS.has(r.verdict));
    if (bad.length) { pending.push(...bad.map((r) => `${r.case_id} ${r.kind} ${r.ref}: verdict=${r.verdict || '(空)'}`)); out.push(t); continue; }
    if (rs.some((r) => r.verdict === 'reject')) { out.push({ ...t, actual: null, annotation_status: 'rejected' }); continue; }
    const actual = [];
    for (const r of rs) {
      if ((r.kind === 'injected' || r.kind === 'base') && (r.verdict === 'present' || r.verdict === 'partial')) {
        const e = [...t.injected, ...(t.base_errors || [])].find((x) => x.id === r.ref);
        if (!e) throw new Error(`${t.case_id}: 复核表引用了不存在的错误 ${r.ref}`);
        const s = Number(r.t_start); const en = Number(r.t_end);
        const adjusted = e.window_status !== 'exact' && Number.isFinite(s) && Number.isFinite(en);
        actual.push({ ...e, source: e.source || 'injected', partial: r.verdict === 'partial',
          disposition: r.disposition || e.disposition,
          ...(adjusted ? { windows: [[s, en]], window_status: 'annotated' } : {}) });
      }
      if (r.kind === 'blind' && r.verdict === 'accidental') {
        const cat = tax.categories[r.category];
        if (!cat) throw new Error(`${t.case_id}: 意外错误 ${r.ref} 的类别 ${r.category} 不在分类体系中`);
        const s = Number(r.t_start); const en = Number(r.t_end);
        actual.push({ id: `${t.case_id}#${r.ref}`, category: r.category, sub: r.sub || null, secondary: [],
          category_name: cat.name, sub_name: cat.subs[r.sub] || null, evidence: null, visibility: null,
          disposition: r.disposition || 'block', judge_basis: cat.judge_basis, description: r.description,
          method: 'accidental', auto: false, windows: [[s, en]], window_status: 'annotated',
          duration_bucket: null, expected_checks: cat.reviewer_checks, source: 'accidental' });
      }
    }
    out.push({ ...t, actual, should_block: actual.some((e) => e.disposition !== 'accept'), annotation_status: 'final' });
  }
  return { truths: out, pending };
}

// 两位标注员的一致性：视频级「有无错误」的 Cohen's kappa；错误级按时间重叠配对的 F1 与类别一致率
export function agreement(a, b, tax) {
  const tol = tolOf(tax);
  const ids = [...new Set([...a.keys(), ...b.keys()])].filter((id) => a.get(id)?.judged && b.get(id)?.judged);
  const yes = (m, id) => m.get(id).errors.length > 0;
  let both = 0; let none = 0; let ay = 0; let by = 0;
  for (const id of ids) { const x = yes(a, id); const y = yes(b, id); if (x && y) both++; if (!x && !y) none++; if (x) ay++; if (y) by++; }
  const n = ids.length;
  const po = n ? (both + none) / n : 0;
  const pe = n ? (ay / n) * (by / n) + (1 - ay / n) * (1 - by / n) : 0;
  let matched = 0; let sameCat = 0; let na = 0; let nb = 0;
  for (const id of ids) {
    const ea = a.get(id).errors; const eb = [...b.get(id).errors]; na += ea.length; nb += eb.length;
    for (const x of ea) {
      const k = eb.findIndex((y) => overlaps(x.window, [y.window], tol));
      if (k >= 0) { matched++; if (eb[k].category === x.category) sameCat++; eb.splice(k, 1); }
    }
  }
  const prec = na ? matched / na : 0; const rec = nb ? matched / nb : 0;
  return {
    videos: n, video_agreement: po, kappa: pe < 1 ? (po - pe) / (1 - pe) : 1,
    errors_a: na, errors_b: nb, matched, error_f1: prec + rec ? (2 * prec * rec) / (prec + rec) : 0,
    category_agreement: matched ? sameCat / matched : null,
  };
}
