import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blindId, expand, loadScenes, loadTaxonomy, patternOf, validateScene, validateTake } from '../src/cases.mjs';

const tax = await loadTaxonomy();
const scenes = await loadScenes();
const takes = JSON.parse(readFileSync(new URL('../takes.example.json', import.meta.url), 'utf8')).takes;

test('分类体系：判定顺序覆盖全部一级类别，易混组不重叠', () => {
  assert.deepEqual([...tax.decision_order].sort(), Object.keys(tax.categories).sort());
  const all = Object.values(tax.confusion_groups).flat();
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual([...all].sort(), Object.keys(tax.categories).sort());
});

test('全部场景与示例底片通过校验', () => {
  assert.deepEqual(scenes.flatMap((s) => validateScene(s, tax)), []);
  assert.deepEqual(takes.flatMap((t) => validateTake(t, scenes.find((s) => s.id === t.scene))), []);
});

test('校验能发现错误的类别、子类和标记点', () => {
  const s = structuredClone(scenes[0]);
  s.injections[0].sub = 'PH1';
  s.injections[1].ops[0].from = 'no_such_marker';
  const errs = validateScene(s, tax);
  assert.ok(errs.some((e) => e.includes('子类 PH1')));
  assert.ok(errs.some((e) => e.includes('no_such_marker')));
});

const skipped = [];
const cases = expand(scenes, takes, tax, { skipped });

test('每条底片都有正确视频、干扰项和单错误', () => {
  for (const t of takes) {
    const mine = cases.filter((c) => c.truth.take === t.id);
    for (const tier of ['clean', 'decoy', 'single']) assert.ok(mine.some((c) => c.tier === tier), `${t.id} 缺 ${tier}`);
  }
});

test('展开结果是确定的（同输入同输出）', () => {
  const again = expand(scenes, takes, tax, {});
  assert.deepEqual(again.map((c) => c.id), cases.map((c) => c.id));
});

test('审核输入不泄露任何注入信息', () => {
  const secrets = scenes.flatMap((s) => [...s.injections.flatMap((i) => [i.id, i.description]), ...(s.decoys || []).flatMap((d) => [d.id, d.description])]);
  for (const c of cases) {
    const blob = JSON.stringify([c.input, c.input_script]);
    for (const s of secrets) assert.ok(!blob.includes(s), `${c.id} 的审核输入包含 ${s}`);
    assert.ok(!blob.includes(c.id));
  }
});

test('blind_id 不含场景或错误编号', () => {
  for (const c of cases) assert.match(c.blind_id, /^v_[0-9a-f]{10}$/);
  assert.equal(new Set(cases.map((c) => c.blind_id)).size, cases.length);
  assert.notEqual(blindId('x', 'a'), blindId('x', 'b'));
});

test('字幕事实错误：审核输入里的字幕就是烧进画面的错误字幕，对照组是正确字幕', () => {
  const s = cases.find((c) => c.id === 'S01-real-01__single__S01.I3');
  const k = cases.find((c) => c.id === 'S01-real-01__control__S01.I3');
  assert.deepEqual(s.input.plan.captions.map((x) => x.text), ['500ml 超大容量']);
  assert.deepEqual(k.input.plan.captions.map((x) => x.text), ['350ml 随身容量']);
  assert.equal(k.truth.should_block, false);
  assert.deepEqual(k.truth.injected, []);
});

test('对照组复现错误样本的剪辑点', () => {
  const s = cases.find((c) => c.id === 'S03-real-01__single__S03.I1');
  const k = cases.find((c) => c.id === 'S03-real-01__control__S03.I1');
  assert.deepEqual(k.gen.pieces.map((p) => p.src), [[0, 2.6], [2.6, 5.6], [5.6, 8]]);
  assert.equal(k.gen.duration, s.gen.duration);
  assert.ok(k.gen.pieces.every((p) => !p.rev));
});

test('脚本配置把镜头卡追加进事实列表', () => {
  const c = cases.find((x) => x.tier === 'clean' && x.truth.scene === 'S02');
  const extra = c.input_script.request.product.facts.filter((f) => f.id.startsWith('S'));
  assert.ok(extra.some((f) => f.claim.startsWith('镜头脚本-起始状态')));
  assert.ok(extra.some((f) => f.claim.startsWith('镜头脚本-终态')));
  assert.equal(c.input.request.product.facts.filter((f) => f.id.startsWith('S')).length, 0);
});

test('可接受的瑕疵不让视频变成应拦截', () => {
  const c = cases.find((x) => x.id === 'S08-real-01__single__S08.I7');
  assert.equal(c.truth.should_block, false);
});

test('组合关系判定', () => {
  const sc = { chains: [{ ids: ['a', 'b'] }] };
  assert.equal(patternOf([{ id: 'a', windows: [[0, 1]], visibility: 'V1' }, { id: 'b', windows: [[5, 6]], visibility: 'V1' }], sc), 'chain');
  assert.equal(patternOf([{ id: 'x', windows: [[0, 1]], visibility: 'V1' }, { id: 'y', windows: [[2, 3]], visibility: 'V3' }], sc), 'mask');
  assert.equal(patternOf([{ id: 'x', windows: [[0, 2]], visibility: 'V1' }, { id: 'y', windows: [[1, 3]], visibility: 'V2' }], sc), 'overlap');
  assert.equal(patternOf([{ id: 'x', windows: [[0, 1]], visibility: 'V1' }, { id: 'y', windows: [[4, 5]], visibility: 'V3' }], sc), 'separate');
});

test('组合用例最多一个手工步骤；冲突组合被跳过而不是生成错误真值', () => {
  for (const c of cases) assert.ok(c.gen.manual_tasks.length <= 1, c.id);
  assert.ok(skipped.length > 0);
  assert.ok(!cases.some((c) => c.id.includes('S02.I1+S02.I2')));
});
