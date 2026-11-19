// 评分：真值（人工复核后的 actual）对审核输出。
// 规则见 taxonomy.matching：时间点落在窗口 ±tol 内才算命中；一条证据只能命中一个错误（一对一），
// 所以两个重叠错误需要审核给出两条证据，不能用一句笼统结论同时「覆盖」。

export const MIN_CELL = 15; // 每个切分格子少于这个样本量，只报数字不下结论

export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n; const d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d; const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// 支持两种审核输出：review.mjs 的 {ok, checks, evidence[]}，或通用 {ok, errors:[{t, check|category}]}
export function normalizePrediction(raw) {
  if (!raw || typeof raw !== 'object') return { unavailable: true, blocked: false, preds: [] };
  if (raw.reason === 'review_unavailable' || (raw.ok === false && !raw.checks && !raw.errors)) {
    return { unavailable: true, blocked: true, preds: [] };
  }
  if (Array.isArray(raw.errors)) {
    const preds = raw.errors.map((e) => ({ t: Number(e.t), check: e.check || null, category: e.category || null, note: e.note || '' }))
      .filter((p) => Number.isFinite(p.t));
    return { unavailable: false, blocked: raw.ok === false || preds.length > 0, preds };
  }
  const preds = (raw.evidence || []).filter((e) => e && e.confirmed === true)
    .map((e) => ({ t: Number(e.t), check: e.check, category: null, note: e.note || '' }))
    .filter((p) => Number.isFinite(p.t));
  return { unavailable: false, blocked: raw.ok === false, preds };
}

const dist = (t, ws) => Math.min(...ws.map(([s, e]) => (t < s ? s - t : t > e ? t - e : 0)));

export function categoryOfCheck(check, tax) {
  return Object.entries(tax.categories).filter(([, c]) => c.reviewer_checks.includes(check)).map(([k]) => k);
}

function groupOf(cat, tax) {
  return Object.values(tax.confusion_groups).find((g) => g.includes(cat)) || [cat];
}

export function judgeCategory(pred, err, tax) {
  const cats = pred.category ? [pred.category] : categoryOfCheck(pred.check, tax);
  if (cats.includes(err.category) || (pred.check && err.expected_checks.includes(pred.check))) return 'correct';
  const g = groupOf(err.category, tax);
  if (cats.some((c) => g.includes(c))) return 'group';
  return 'other';
}

export function effectiveTier(truth) {
  if (truth.tier === 'decoy' || truth.tier === 'control' || truth.tier === 'clean') {
    return (truth.actual || truth.injected).filter((e) => e.disposition !== 'accept').length ? 'contaminated' : truth.tier;
  }
  const errs = (truth.actual || truth.injected).filter((e) => e.disposition !== 'accept');
  if (!errs.length) return 'clean';
  if (errs.length === 1) return 'single';
  return new Set(errs.map((e) => e.category)).size === 1 ? 'multi' : 'combo';
}

export function scoreCase(truth, raw, tax, { useInjected = false } = {}) {
  const tol = tax.matching.time_tolerance_s;
  const final = truth.annotation_status === 'final' && Array.isArray(truth.actual);
  if (!final && !useInjected) return { case_id: truth.case_id, status: 'unannotated' };
  if (truth.annotation_status === 'rejected') return { case_id: truth.case_id, status: 'rejected' };
  const errors = final ? truth.actual : truth.injected;
  const pred = normalizePrediction(raw);
  const shouldBlock = errors.some((e) => e.disposition !== 'accept');
  const base = { case_id: truth.case_id, tier: truth.tier, effective_tier: effectiveTier({ ...truth, actual: errors }),
    pattern: truth.pattern, source_kind: truth.source_kind, should_block: shouldBlock };
  if (pred.unavailable) return { ...base, status: 'unavailable', blocked: pred.blocked };

  const cand = [];
  pred.preds.forEach((p, i) => errors.forEach((e, j) => {
    const d = dist(p.t, e.windows);
    if (d <= tol) cand.push({ i, j, d });
  }));
  cand.sort((a, b) => a.d - b.d);
  const usedP = new Set(); const usedE = new Map();
  for (const c of cand) {
    if (usedP.has(c.i) || usedE.has(c.j)) continue;
    usedP.add(c.i); usedE.set(c.j, c.i);
  }
  const perError = errors.map((e, j) => {
    const i = usedE.get(j);
    const hit = i !== undefined ? pred.preds[i] : null;
    return {
      id: e.id, category: e.category, sub: e.sub, evidence: e.evidence, visibility: e.visibility,
      duration_bucket: e.duration_bucket, judge_basis: e.judge_basis, method: e.method, disposition: e.disposition,
      source: e.source || 'injected', detected: !!hit, category_result: hit ? judgeCategory(hit, e, tax) : 'missed',
      hit_t: hit?.t ?? null, hit_check: hit?.check ?? hit?.category ?? null,
    };
  });
  const fps = [];
  pred.preds.forEach((p, i) => {
    if (usedP.has(i)) return;
    // 落在「可接受」瑕疵附近的多报不算误报
    if (errors.some((e) => e.disposition === 'accept' && dist(p.t, e.windows) <= tol)) return;
    fps.push(p);
  });
  return { ...base, status: 'scored', blocked: pred.blocked, errors: perError, false_positives: fps };
}

function bucket(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = r[key] ?? '-'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
}

export function aggregate(results, { minCell = MIN_CELL } = {}) {
  const scored = results.filter((r) => r.status === 'scored');
  const errs = scored.flatMap((r) => r.errors.filter((e) => e.disposition !== 'accept')
    .map((e) => ({ ...e, tier: r.effective_tier, pattern: r.pattern, source_kind: r.source_kind })));
  const recallBy = (key) => bucket(errs, key).map(([k, rs]) => {
    const n = rs.length; const k1 = rs.filter((e) => e.detected).length;
    const correct = rs.filter((e) => e.category_result === 'correct').length;
    return { key: k, n, detected: k1, recall: n ? k1 / n : 0, ci: wilson(k1, n),
      category_acc: k1 ? correct / k1 : null, enough: n >= minCell };
  });
  const videoBy = bucket(scored, 'effective_tier').map(([k, rs]) => {
    const n = rs.length; const b = rs.filter((r) => r.blocked).length;
    return { key: k, n, blocked: b, rate: n ? b / n : 0, ci: wilson(b, n),
      fp_per_video: n ? rs.reduce((s, r) => s + r.false_positives.length, 0) / n : 0, enough: n >= minCell };
  });
  const pos = scored.filter((r) => r.should_block); const neg = scored.filter((r) => !r.should_block);
  const tp = pos.filter((r) => r.blocked).length; const fpv = neg.filter((r) => r.blocked).length;
  return {
    total: results.length,
    status: Object.fromEntries(bucket(results, 'status').map(([k, rs]) => [k, rs.length])),
    video: {
      block_rate: pos.length ? tp / pos.length : null, block_ci: wilson(tp, pos.length), positives: pos.length,
      false_block_rate: neg.length ? fpv / neg.length : null, false_block_ci: wilson(fpv, neg.length), negatives: neg.length,
      by_tier: videoBy,
    },
    errors: {
      n: errs.length,
      recall: errs.length ? errs.filter((e) => e.detected).length / errs.length : null,
      by: Object.fromEntries(['category', 'sub', 'evidence', 'visibility', 'duration_bucket', 'judge_basis', 'method', 'tier', 'pattern', 'source_kind', 'source']
        .map((k) => [k, recallBy(k)])),
      category_confusion: Object.fromEntries(bucket(errs.filter((e) => e.detected), 'category')
        .map(([k, rs]) => [k, Object.fromEntries(bucket(rs, 'category_result').map(([c, x]) => [c, x.length]))])),
    },
  };
}

const pct = (x) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);
const ci = ([a, b]) => `${(a * 100).toFixed(0)}–${(b * 100).toFixed(0)}%`;

export function reportMarkdown(agg, { title = '视频审核评测报告', config = 'facts', tax } = {}) {
  const L = [`# ${title}`, '', `审核输入配置：\`${config}\`。样本少于 ${MIN_CELL} 的格子标 ⚠，只看数字，不下结论。`, ''];
  L.push('## 总体', '', '| 指标 | 值 | 95% 区间 | 样本 |', '|---|---|---|---|');
  L.push(`| 应拦视频的拦截率 | ${pct(agg.video.block_rate)} | ${ci(agg.video.block_ci)} | ${agg.video.positives} |`);
  L.push(`| 不应拦视频的误拦率 | ${pct(agg.video.false_block_rate)} | ${ci(agg.video.false_block_ci)} | ${agg.video.negatives} |`);
  L.push(`| 错误实例召回率（时间定位 ±${tax?.matching.time_tolerance_s ?? 1}s） | ${pct(agg.errors.recall)} | | ${agg.errors.n} |`);
  L.push('', `用例状态：${Object.entries(agg.status).map(([k, v]) => `${k} ${v}`).join('，')}。`, '');
  L.push('## 按用例类型（视频级）', '', '| 类型 | 样本 | 拦截 | 拦截率 | 95% 区间 | 每条误报证据数 |', '|---|---|---|---|---|---|');
  for (const r of agg.video.by_tier) L.push(`| ${r.key}${r.enough ? '' : ' ⚠'} | ${r.n} | ${r.blocked} | ${pct(r.rate)} | ${ci(r.ci)} | ${r.fp_per_video.toFixed(2)} |`);
  const names = {
    category: '一级类别', sub: '二级子类', evidence: '发现所需证据', visibility: '显著度', duration_bucket: '持续时长',
    judge_basis: '判定依据', method: '注入方式', tier: '用例类型（复核后）', pattern: '组合关系', source_kind: '底片来源', source: '错误来源',
  };
  const label = (dim, k) => {
    if (!tax) return k;
    if (dim === 'category') return `${k} ${tax.categories[k]?.name || ''}`;
    if (dim === 'sub') { const c = Object.values(tax.categories).find((x) => x.subs[k]); return c ? `${k} ${c.subs[k]}` : k; }
    if (dim === 'evidence') return `${k} ${tax.evidence_levels[k] || ''}`;
    if (dim === 'visibility') return `${k} ${(tax.visibility_levels[k] || '').split('：')[0]}`;
    return k;
  };
  for (const [dim, rows] of Object.entries(agg.errors.by)) {
    if (!rows.length) continue;
    L.push('', `## 召回率 · ${names[dim] || dim}`, '', '| 取值 | 样本 | 检出 | 召回率 | 95% 区间 | 检出中分类正确 |', '|---|---|---|---|---|---|');
    for (const r of rows) L.push(`| ${label(dim, r.key)}${r.enough ? '' : ' ⚠'} | ${r.n} | ${r.detected} | ${pct(r.recall)} | ${ci(r.ci)} | ${pct(r.category_acc)} |`);
  }
  L.push('', '## 检出错误的分类结果', '', 'correct：分到该类对应的审核项；group：分到同一易混组的其他类；other：分到无关类别。', '',
    '| 真值类别 | correct | group | other |', '|---|---|---|---|');
  for (const [k, v] of Object.entries(agg.errors.category_confusion)) L.push(`| ${label('category', k)} | ${v.correct || 0} | ${v.group || 0} | ${v.other || 0} |`);
  return L.join('\n') + '\n';
}
