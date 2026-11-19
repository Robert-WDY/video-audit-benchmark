import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTaxonomy } from '../src/cases.mjs';
import { aggregate, normalizePrediction, reportMarkdown, scoreCase, wilson } from '../src/score.mjs';

const tax = await loadTaxonomy();
const err = (id, category, windows, extra = {}) => ({ id, category, sub: `${category}1`, windows, evidence: 'E1', visibility: 'V1',
  disposition: 'block', judge_basis: 'common_sense', method: 'drop', duration_bucket: 'long',
  expected_checks: tax.categories[category].reviewer_checks, ...extra });
const truth = (errors, extra = {}) => ({ case_id: 'c', tier: errors.length ? 'single' : 'clean', pattern: null, source_kind: 'real',
  injected: errors, actual: errors, annotation_status: 'final', ...extra });
const ev = (t, check) => ({ t, check, confirmed: true, note: '' });

test('没定稿的用例默认不计分', () => {
  const r = scoreCase(truth([], { annotation_status: 'pending', actual: null }), { ok: true, checks: {}, evidence: [] }, tax);
  assert.equal(r.status, 'unannotated');
});

test('只统计复核确认的证据；时间容差 ±1 秒', () => {
  const t = truth([err('A', 'TC', [[3, 4]])]);
  const hit = scoreCase(t, { ok: false, checks: {}, evidence: [ev(4.9, 'physics')] }, tax);
  assert.equal(hit.errors[0].detected, true);
  assert.equal(hit.errors[0].category_result, 'correct');
  const miss = scoreCase(t, { ok: false, checks: {}, evidence: [ev(5.2, 'physics')] }, tax);
  assert.equal(miss.errors[0].detected, false);
  assert.equal(miss.false_positives.length, 1);
  const unconfirmed = scoreCase(t, { ok: true, checks: {}, evidence: [{ ...ev(3.5, 'physics'), confirmed: false }] }, tax);
  assert.equal(unconfirmed.errors[0].detected, false);
});

test('一条证据只能命中一个错误', () => {
  const t = truth([err('A', 'PF', [[2, 4]]), err('B', 'TC', [[2.5, 3.5]])]);
  const one = scoreCase(t, { ok: false, checks: {}, evidence: [ev(3, 'product_drift')] }, tax);
  assert.equal(one.errors.filter((e) => e.detected).length, 1);
  const two = scoreCase(t, { ok: false, checks: {}, evidence: [ev(3, 'product_drift'), ev(3.2, 'physics')] }, tax);
  assert.equal(two.errors.filter((e) => e.detected).length, 2);
});

test('分类结果：本类 / 同易混组 / 无关', () => {
  const t = truth([err('A', 'SA', [[1, 2]])]);
  assert.equal(scoreCase(t, { ok: false, checks: {}, evidence: [ev(1.5, 'physics')] }, tax).errors[0].category_result, 'group');
  assert.equal(scoreCase(t, { ok: false, checks: {}, evidence: [ev(1.5, 'garbled_text')] }, tax).errors[0].category_result, 'other');
  const pf = truth([err('B', 'PF', [[1, 2]])]);
  assert.equal(scoreCase(pf, { ok: false, checks: {}, evidence: [ev(1.5, 'fact_error')] }, tax).errors[0].category_result, 'correct');
});

test('可接受瑕疵附近的多报不算误报', () => {
  const t = truth([err('A', 'VT', [[0, 8]], { disposition: 'accept' })]);
  const r = scoreCase(t, { ok: false, checks: {}, evidence: [ev(3, 'product_drift')] }, tax);
  assert.equal(r.should_block, false);
  assert.equal(r.false_positives.length, 0);
});

test('审核不可用单独计数，不算漏报', () => {
  const r = scoreCase(truth([err('A', 'TE', [[1, 2]])]), { ok: false, reason: 'review_unavailable', checks: {}, evidence: [] }, tax);
  assert.equal(r.status, 'unavailable');
  assert.equal(normalizePrediction(null).unavailable, true);
});

test('通用输出格式也能评分', () => {
  const r = scoreCase(truth([err('A', 'PH', [[1, 2]])]), { ok: false, errors: [{ t: 1.2, category: 'PH' }] }, tax);
  assert.equal(r.errors[0].category_result, 'correct');
});

test('汇总与报告', () => {
  const rs = [
    scoreCase(truth([err('A', 'TC', [[1, 2]])]), { ok: false, checks: {}, evidence: [ev(1.5, 'physics')] }, tax),
    scoreCase(truth([err('B', 'PF', [[1, 2]])]), { ok: true, checks: {}, evidence: [] }, tax),
    scoreCase(truth([]), { ok: false, checks: {}, evidence: [ev(3, 'physics')] }, tax),
    scoreCase(truth([]), { ok: true, checks: {}, evidence: [] }, tax),
  ];
  const agg = aggregate(rs);
  assert.equal(agg.video.block_rate, 0.5);
  assert.equal(agg.video.false_block_rate, 0.5);
  assert.equal(agg.errors.recall, 0.5);
  const md = reportMarkdown(agg, { tax });
  assert.match(md, /应拦视频的拦截率 \| 50\.0%/);
  assert.match(md, /⚠/);
  const [lo, hi] = wilson(6, 10);
  assert.ok(lo > 0.29 && lo < 0.32 && hi > 0.82 && hi < 0.85);
});
