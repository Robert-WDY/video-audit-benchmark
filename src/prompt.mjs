// 从场景卡拼视频生成提示词。正确版和错误版共用同一段「世界描述」，
// 错误版只在末尾追加一段「本镜头必须出现的不合理之处」，配合同一个 seed 得到最小差异对照。

export function worldPrompt(scene, { style = '真实商业摄影，自然光影，画面干净', camera } = {}) {
  const s = scene.script; const p = scene.product;
  const actions = s.actions.map((a, i) => `${i + 1}. ${a.actor}${a.desc}`).join('；');
  return [
    `一个连续不剪辑的单镜头，${camera || scene.shooting?.camera || '固定机位'}，${style}。`,
    `产品：${p.name}，${p.appearance}。`,
    `开始画面：${s.start_state}。`,
    `动作按顺序发生：${actions}。`,
    `结束画面：${s.end_state}。`,
    '画面中只出现上面写到的物体，每种物体只有一个（除非本描述中另有写明），不要额外添加相同或相似的物体。',
    '整个过程中产品的颜色、材质、形状、部件数量和标识始终保持不变；物体运动符合真实物理；人手结构正常；除产品 Logo 外画面中不出现其他文字。',
  ].join('\n');
}

// 错误版：每个错误明确、可见，其余保持正确。可同时要求多个错误（同一镜头内）
export function errorClause(injs) {
  const list = [].concat(injs);
  const items = list.map((inj) => inj.generation_hint || inj.description);
  const head = items.length === 1
    ? `本镜头必须出现以下不合理之处，要清晰可见、不能被模糊或遮挡：${items[0]}。`
    : `本镜头必须同时出现以下 ${items.length} 处不合理之处，每一处都要清晰可见、不能被模糊或遮挡：\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
  return [head, `除这${items.length === 1 ? '一处' : '几处'}之外，其余所有内容都保持正确、正常。`].join('\n');
}

const RELAX = {
  PF: '整个过程中产品的颜色、材质、形状、部件数量和标识始终保持不变；',
  PH: '物体运动符合真实物理；人手结构正常；',
  VT: '除产品 Logo 外画面中不出现其他文字。',
};

export function buildPrompt(scene, inj = null, opts = {}) {
  const world = worldPrompt(scene, opts);
  const list = inj ? [].concat(inj) : [];
  if (!list.length) return world;
  // 去掉与错误直接矛盾的约束，否则模型会在两条指令之间取折中
  let w = world;
  for (const x of list) { const r = RELAX[x.category]; if (r) w = w.replace(r, ''); }
  // 数量类错误（部件数量、物体数量）与「每种物体只有一个」矛盾，一并去掉
  if (list.some((x) => ['PF3', 'SA6'].includes(x.sub))) w = w.split('\n').filter((l) => !l.startsWith('画面中只出现上面写到的物体')).join('\n');
  return `${w}\n${errorClause(list)}`;
}
