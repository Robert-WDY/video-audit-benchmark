import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, PIECE_OPS, applyOps, cutPoints, initial, resolveTime, srcToOut, totalDur } from '../src/timeline.mjs';

test('标记点表达式解析', () => {
  const m = { pour_start: 2.5 };
  assert.equal(resolveTime(3, m), 3);
  assert.equal(resolveTime('pour_start', m), 2.5);
  assert.equal(resolveTime('pour_start+1.5', m), 4);
  assert.equal(resolveTime('pour_start - 0.5', m), 2);
  assert.throws(() => resolveTime('nope', m), /缺少标记点/);
});

test('倒放中段：时长不变，窗口就是倒放段', () => {
  const r = applyOps(8, [{ op: 'reverse', from: 2, to: 5, id: 'E' }]);
  assert.equal(r.duration, 8);
  assert.deepEqual(r.windows.E, [[2, 5]]);
  const rev = r.pieces.filter((p) => p.rev);
  assert.equal(rev.length, 1);
  assert.deepEqual(rev[0].src, [2, 5]);
});

test('抽帧：时长变短，真值是跳变点前后 0.3 秒', () => {
  const r = applyOps(8, [{ op: 'drop', from: 2, to: 3.5, id: 'E' }]);
  assert.equal(r.duration, 6.5);
  assert.deepEqual(r.windows.E, [[1.7, 2.3]]);
});

test('重复：窗口是第二次出现', () => {
  const r = applyOps(6, [{ op: 'repeat', from: 1.5, to: 3.5, id: 'E' }]);
  assert.equal(r.duration, 8);
  assert.deepEqual(r.windows.E, [[3.5, 5.5]]);
});

test('插入：把开头复制到后面，窗口落在插入位置', () => {
  const r = applyOps(8, [{ op: 'insert', from: 0, to: 1, at: 7, id: 'E' }]);
  assert.equal(r.duration, 9);
  assert.deepEqual(r.windows.E, [[7, 8]]);
});

test('交换两段：两段都算错误窗口（相邻时合并）', () => {
  const r = applyOps(7, [{ op: 'swap', a_from: 1.5, a_to: 3.5, b_from: 3.5, b_to: 7, id: 'E' }]);
  assert.equal(r.duration, 7);
  assert.deepEqual(r.windows.E, [[1.5, 7]]);
  assert.deepEqual(r.pieces.map((p) => p.src), [[0, 1.5], [3.5, 7], [1.5, 3.5]]);
});

test('冻帧与黑场插入后，后面的叠加层窗口跟着平移', () => {
  const r = applyOps(6, [
    { op: 'freeze', at: 2, dur: 1.5, id: 'F' },
    { op: 'caption', from: 3, to: 5, text: 'x', id: 'C' },
  ]);
  assert.equal(r.duration, 7.5);
  assert.deepEqual(r.windows.F, [[2, 3.5]]);
  assert.deepEqual(r.windows.C, [[4.5, 6.5]]);
});

test('两个错误作用于同一段画面时报冲突', () => {
  assert.throws(() => applyOps(8, [
    { op: 'reverse', from: 0, to: 8, id: 'A' },
    { op: 'drop', from: 2, to: 3, id: 'B' },
  ]), ConflictError);
  assert.throws(() => applyOps(8, [
    { op: 'drop', from: 2, to: 4, id: 'A' },
    { op: 'tint', from: 3, to: 3.5, id: 'B' },
  ]), ConflictError);
});

test('对照组只切不改：内容与时长不变，切点相同', () => {
  const err = applyOps(8, [{ op: 'reverse', from: 2, to: 5, id: 'E' }]);
  const pts = cutPoints(err.pieces).filter((t) => t > 0 && t < 8);
  let ps = initial(8);
  for (const t of pts) ps = PIECE_OPS.cut(ps, { at: t });
  assert.equal(totalDur(ps), 8);
  assert.deepEqual(ps.map((p) => p.src), [[0, 2], [2, 5], [5, 8]]);
  assert.ok(ps.every((p) => !p.rev));
});

test('源时间映射：被剪掉的时间返回 null', () => {
  const r = applyOps(8, [{ op: 'drop', from: 2, to: 4, id: 'E' }]);
  assert.equal(srcToOut(r.pieces, 5), 3);
  assert.equal(srcToOut(r.pieces, 3), null);
});

test('多个操作组合：时间窗口逐个正确', () => {
  const r = applyOps(9, [
    { op: 'drop', from: 1, to: 2, id: 'A' },
    { op: 'repeat', from: 5, to: 6, id: 'B' },
    { op: 'tint', from: 7, to: 8, id: 'C', region: [0, 0, 1, 1] },
  ]);
  assert.equal(r.duration, 9);
  assert.deepEqual(r.windows.A, [[0.7, 1.3]]);
  assert.deepEqual(r.windows.B, [[5, 6]]);
  assert.deepEqual(r.windows.C, [[7, 8]]);
});
