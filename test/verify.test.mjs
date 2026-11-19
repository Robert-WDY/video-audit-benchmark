import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../src/timeline.mjs';
import { H, W, sourceTime, verifyCase } from '../src/verify.mjs';

const fps = 10;
const frame = (v = 100) => Buffer.alloc(W * H * 3, v);
const clean = Array.from({ length: 60 }, (_, i) => frame(50 + i));      // 每帧亮度不同，便于检查时间映射
const truthOf = (errs) => ({ injected: errs });
const err = (id, method, windows) => ({ id, method, windows });

test('源时间映射：倒放与抽帧', () => {
  const rev = applyOps(6, [{ op: 'reverse', from: 2, to: 4, id: 'E' }]);
  assert.equal(sourceTime(rev.pieces, 1), 1);
  assert.equal(sourceTime(rev.pieces, 3), null);           // 被标记为错误的片段
  const drop = applyOps(6, [{ op: 'drop', from: 2, to: 3, id: 'E' }]);
  assert.equal(sourceTime(drop.pieces, 2.5), 3.5);
});

test('窗口内有变化、窗口外一致 → 通过', () => {
  const tl = applyOps(6, [{ op: 'tint', from: 2, to: 4, region: [0, 0, 1, 1], id: 'T' }]);
  const frames = clean.map((f, i) => (i >= 20 && i <= 40 ? frame(250) : f));
  const r = verifyCase({ gen: tl, truth: truthOf([err('T', 'tint', [[2, 4]])]) }, frames, clean, fps);
  assert.equal(r.status, 'ok');
});

test('窗口外也被改了 → 报告意外变化', () => {
  const tl = applyOps(6, [{ op: 'tint', from: 2, to: 3, region: [0, 0, 1, 1], id: 'T' }]);
  const frames = clean.map((f, i) => (i >= 20 && i <= 50 ? frame(250) : f));
  const r = verifyCase({ gen: tl, truth: truthOf([err('T', 'tint', [[2, 3]])]) }, frames, clean, fps);
  assert.equal(r.problems[0].kind, 'unintended_change');
});

test('窗口内看不到变化 → 报告错误没做出来', () => {
  const tl = applyOps(6, [{ op: 'tint', from: 2, to: 3, region: [0, 0, 1, 1], id: 'T' }]);
  const r = verifyCase({ gen: tl, truth: truthOf([err('T', 'tint', [[2, 3]])]) }, clean, clean, fps);
  assert.equal(r.problems[0].kind, 'not_visible');
});

test('剪辑样本按源时间对齐比较，纯声音错误不检查', () => {
  const tl = applyOps(6, [{ op: 'drop', from: 2, to: 3, id: 'D' }, { op: 'mute', from: 0, to: 6, id: 'M' }]);
  const frames = Array.from({ length: 50 }, (_, i) => clean[Math.round((sourceTime(tl.pieces, i / fps) ?? 0) * fps)]);
  const r = verifyCase({ gen: tl, truth: truthOf([err('D', 'drop', tl.windows.D), err('M', 'mute', [[0, 6]])]) }, frames, clean, fps);
  assert.equal(r.status, 'ok');
});
