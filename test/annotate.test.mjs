import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTaxonomy } from '../src/cases.mjs';
import { agreement, blindSheet, finalize, parseCsv, readBlind, reconcileSheet, toCsv } from '../src/annotate.mjs';

const tax = await loadTaxonomy();

test('CSV 往返（引号、逗号、换行、BOM）', () => {
  const csv = toCsv(['a', 'b'], [{ a: '有,逗号', b: '有"引号"\n换行' }, { a: 1, b: '' }]);
  assert.ok(csv.startsWith('﻿'));
  assert.deepEqual(parseCsv(csv), [{ a: '有,逗号', b: '有"引号"\n换行' }, { a: '1', b: '' }]);
});

const T = [
  { case_id: 'k1', blind_id: 'v_1', duration: 8, injected: [{ id: 'S03.I1', category: 'PH', sub: 'PH2', description: '倒流', windows: [[2, 5]], auto: true, window_status: 'exact', disposition: 'block' }] },
  { case_id: 'k2', blind_id: 'v_2', duration: 8, injected: [{ id: 'S03.I5', category: 'SA', sub: 'SA5', description: '杯空', windows: [[5.6, 8]], auto: false, window_status: 'estimated', disposition: 'block' }] },
  { case_id: 'k3', blind_id: 'v_3', duration: 8, injected: [], decoy: null },
];

test('盲审表不含真值信息且顺序打乱', () => {
  const csv = blindSheet(T, { seed: 7 });
  assert.doesNotMatch(csv, /S03|倒流|PH2|k1/);
  assert.equal(parseCsv(csv).length, 3);
});

test('复核 → 定稿：确认、改窗口、补意外错误、未裁定不定稿', () => {
  const a = readBlind([
    { blind_id: 'v_1', has_error: '是', category: 'ph', sub: 'PH2', t_start: '3', t_end: '4' },
    { blind_id: 'v_2', has_error: '否' },
    { blind_id: 'v_3', has_error: '是', category: 'PH', sub: 'PH4', t_start: '1', t_end: '1.5', note: '六指' },
  ], 'ann1');
  const rows = parseCsv(reconcileSheet(T, [a], tax));
  const r1 = rows.find((r) => r.case_id === 'k1');
  assert.equal(r1.suggested, 'present');
  assert.match(r1.blind_hits, /^1\/1/);
  assert.equal(rows.find((r) => r.case_id === 'k2').suggested, 'absent?');
  const acc = rows.find((r) => r.case_id === 'k3');
  assert.equal(acc.kind, 'blind');

  r1.verdict = 'present';
  const r2 = rows.find((r) => r.case_id === 'k2'); r2.verdict = 'partial'; r2.t_start = '6'; r2.t_end = '8';
  acc.verdict = 'accidental';
  const { truths, pending } = finalize(T, rows, tax);
  assert.deepEqual(pending, []);
  assert.equal(truths[0].annotation_status, 'final');
  assert.deepEqual(truths[0].actual[0].windows, [[2, 5]]); // 精确窗口不被人工改写
  assert.deepEqual(truths[1].actual[0].windows, [[6, 8]]); // 估计窗口按人工校准
  assert.equal(truths[1].actual[0].partial, true);
  assert.equal(truths[2].actual[0].source, 'accidental');
  assert.equal(truths[2].should_block, true);

  r1.verdict = '';
  assert.equal(finalize(T, rows, tax).pending.length, 1);
});

test('标注一致性：kappa 与错误级 F1', () => {
  const a = readBlind([
    { blind_id: 'v_1', has_error: '是', category: 'PH', t_start: '3', t_end: '4' },
    { blind_id: 'v_2', has_error: '否' }, { blind_id: 'v_3', has_error: '否' },
  ], 'a');
  const b = readBlind([
    { blind_id: 'v_1', has_error: '是', category: 'TC', t_start: '3.5', t_end: '3.5' },
    { blind_id: 'v_2', has_error: '否' }, { blind_id: 'v_3', has_error: '是', category: 'PH', t_start: '1', t_end: '1' },
  ], 'b');
  const r = agreement(a, b, tax);
  assert.equal(r.videos, 3);
  assert.ok(Math.abs(r.video_agreement - 2 / 3) < 1e-9);
  assert.equal(r.matched, 1);
  assert.equal(r.category_agreement, 0);
  assert.ok(Math.abs(r.error_f1 - 2 / 3) < 1e-9);
});
