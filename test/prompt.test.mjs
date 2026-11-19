import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenes } from '../src/cases.mjs';
import { buildPrompt } from '../src/prompt.mjs';

const scenes = await loadScenes();
const s03 = scenes.find((s) => s.id === 'S03');

test('正确版包含镜头卡全部要素', () => {
  const p = buildPrompt(s03);
  for (const x of [s03.product.appearance, s03.script.start_state, s03.script.end_state, ...s03.script.actions.map((a) => a.desc)]) assert.ok(p.includes(x), x);
  assert.doesNotMatch(p, /不合理/);
});

test('错误版只多出错误段，并去掉与之矛盾的约束', () => {
  const inj = s03.injections.find((i) => i.id === 'S03.I6');
  const base = buildPrompt(s03); const bad = buildPrompt(s03, inj);
  assert.match(bad, /不合理之处.*水流穿过玻璃杯壁/);
  assert.ok(base.includes('物体运动符合真实物理'));
  assert.ok(!bad.includes('物体运动符合真实物理'));
  const shared = base.split('\n').slice(0, 5).join('\n');
  assert.ok(bad.startsWith(shared));
});
