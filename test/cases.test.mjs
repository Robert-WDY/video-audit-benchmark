import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blindId, expand, loadScenes, loadTaxonomy, patternOf, validateScene, validateTake, visualSignature } from '../src/cases.mjs';

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

test('不生成只切不改的对照组；内容对照（字幕）保留', () => {
  assert.ok(!cases.some((c) => c.id === 'S03-real-01__control__S03.I1'));
  assert.ok(cases.every((c) => c.tier !== 'control' || c.gen.ops.every((o) => o.op !== 'cut')));
  const ctl = cases.find((c) => c.id === 'S05-real-01__control__S05.I2');
  assert.ok(ctl);
  assert.equal(ctl.truth.video, 'S05-real-01__control__S05.I2__ok.mp4');
  const names = cases.map((c) => c.truth.video);
  assert.equal(new Set(names).size, names.length, '视频文件名有重复');
});

test('没有画面、声音、字幕都相同的重复用例', () => {
  const keys = cases.map((c) => `${c.truth.take}|${visualSignature(c)}|${JSON.stringify(c.gen.overlays.filter((o) => ['mute', 'av_offset'].includes(o.op)).map((o) => [o.op, o.out, o.ms]))}|${JSON.stringify(c.input.plan.captions)}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('纯声音错误：每条底片最多一个组合，且标出与哪条画面相同', () => {
  for (const t of takes) {
    const n = cases.filter((c) => c.truth.take === t.id && !c.truth.bundle && ['multi', 'combo'].includes(c.tier)
      && c.truth.injected.some((e) => e.method === 'mute')).length;
    assert.ok(n <= 1, `${t.id} 有 ${n} 个含静音的组合`);
  }
  const mute = cases.find((c) => c.id === 'S03-real-01__single__S03.I4');
  assert.equal(mute.truth.same_picture_as, 'S03-real-01__clean__base');
});

test('脚本配置把镜头卡追加进事实列表', () => {
  const c = cases.find((x) => x.tier === 'clean' && x.truth.scene === 'S02');
  const extra = c.input_script.request.product.facts.filter((f) => f.id.startsWith('S'));
  assert.ok(extra.some((f) => f.claim.startsWith('镜头脚本-起始状态')));
  assert.ok(extra.some((f) => f.claim.startsWith('镜头脚本-终态')));
  assert.equal(c.input.request.product.facts.filter((f) => f.id.startsWith('S')).length, 0);
});

test('可接受的瑕疵不让视频变成应拦截', () => {
  const sc = structuredClone(scenes.find((x) => x.id === 'S08'));
  sc.injections.push({ id: 'S08.IX', category: 'VT', sub: 'VT4', evidence: 'E2', visibility: 'V3', disposition: 'accept',
    description: '轻微亮度闪动', ops: [{ op: 'flash', at: 'dip', frames: 1, color: 'gray' }] });
  const cs = expand([sc], takes.filter((t) => t.scene === 'S08'), tax, {});
  const c = cs.find((x) => x.id.endsWith('__single__S08.IX'));
  assert.equal(c.truth.should_block, false);
});

test('提示词诱导、已停用的错误和实拍干扰项不在底片上派生', () => {
  assert.ok(!cases.some((c) => c.truth.injected.some((e) => e.method === 'prompt')));
  assert.ok(!cases.some((c) => c.tier === 'decoy' && c.gen.manual_tasks.some((m) => m.method === 'shoot')));
  const sc = structuredClone(scenes.find((x) => x.id === 'S03'));
  sc.injections.find((i) => i.id === 'S03.I1').retired = '测试';
  const cs = expand([sc], takes.filter((t) => t.scene === 'S03'), tax, {});
  assert.ok(!cs.some((c) => c.truth.injected.some((e) => e.id === 'S03.I1')));
  assert.ok(validateScene({ ...sc, injections: [{ ...sc.injections[0], retired: '' }] }, tax).some((e) => e.includes('停用原因')));
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

test('同一镜头多错误（bundle）：时间轴未剪辑、三个错误都在、文件名可读', () => {
  const b = cases.find((c) => c.id === 'S05-real-01__multi__S05.I9+S05.I2+S05.I4');
  assert.ok(b, '缺少 S05 的 bundle');
  assert.equal(b.truth.continuous, true);
  assert.equal(b.truth.injected.length, 3);
  assert.ok(b.truth.bundle);
  assert.equal(b.truth.video, 'S05-real-01__multi__S05.I9+S05.I2+S05.I4__PF4+PF8+PF5.mp4');
  const reverse = cases.find((c) => c.id === 'S03-real-01__single__S03.I1');
  assert.equal(reverse.truth.continuous, false);
});

test('底片上人工确认的错误进入每条派生用例的真值，窗口随剪辑换算', () => {
  const tk = structuredClone(takes.find((t) => t.id === 'S06-real-01'));
  tk.known_errors = [{ id: 'K1', category: 'SA', sub: 'SA5', description: '没站起来', window: [8.0, 'end'], disposition: 'block' }];
  assert.deepEqual(validateTake(tk, scenes.find((s) => s.id === 'S06'), tax), []);
  const cs = expand(scenes, [tk], tax, {});
  const clean = cs.find((c) => c.tier === 'clean');
  assert.equal(clean.truth.should_block, true);
  assert.deepEqual(clean.truth.base_errors[0].windows, [[8, 9]]);
  assert.match(clean.truth.video, /__base-SA5\.mp4$/);
  const rev = cs.find((c) => c.id.endsWith('__single__S06.I1'));
  assert.deepEqual(rev.truth.base_errors[0].windows, [[0, 1]]);
  const bad = { ...tk, known_errors: [{ id: 'K2', category: 'SA', sub: 'PF1', description: 'x', window: [0, 1] }] };
  assert.ok(validateTake(bad, scenes.find((s) => s.id === 'S06'), tax).some((e) => e.includes('PF1')));
});

test('静音和音画偏移不会被当成同一条视频去重', () => {
  const tk = takes.filter((t) => t.scene === 'S07');
  const cs = expand(scenes, tk, tax, {});
  assert.ok(cs.some((c) => c.id.endsWith('__single__S07.I4')));
  assert.ok(cs.some((c) => c.id.endsWith('__single__S07.I12')));
});

test('同一组错误换个顺序不会生成第二条用例', () => {
  const tk = takes.filter((t) => t.scene === 'S04');
  const cs = expand(scenes, tk, tax, {});
  const sets = cs.filter((c) => c.truth.injected.length > 1).map((c) => `${c.truth.take}|${c.truth.injected.map((e) => e.id).sort().join('+')}`);
  assert.equal(new Set(sets).size, sets.length);
});

test('「光环不亮」从按键时刻开始，不会漏出亮起的帧', () => {
  const s07 = scenes.find((s) => s.id === 'S07');
  assert.equal(s07.injections.find((i) => i.id === 'S07.I7').ops[0].from, 'press');
});
