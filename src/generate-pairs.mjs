#!/usr/bin/env node
// 生成创意一致性对比对：每对两条视频，只在一个维度上不同（同一 seed）。
//   node src/generate-pairs.mjs --file briefs/pilot.json [--only P-MOOD] [--dry-run]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROUTES, download, submit, waitFor } from './aicentre.mjs';

const { values: a } = parseArgs({ options: {
  file: { type: 'string' }, only: { type: 'string' }, out: { type: 'string', default: '.work/pairs' }, 'dry-run': { type: 'boolean', default: false }, side: { type: 'string' },
  // generic = 通用接口（支持幂等去重和按 external_ref 反查）；h3 = 自建池（不支持去重，提交即建新任务）
  route: { type: 'string', default: 'generic' }, model: { type: 'string', default: 'minimax-h3-hs' },
} });

export function pairPrompt(p, side) {
  const v = p[side];
  return [
    `${p.base}`,
    `产品：${p.product.name}，${p.product.appearance}。产品外观在整个视频中保持不变。`,
    `${p.dim_name}要求：${v.prompt}`,
    '画面中只出现上面写到的物体，不要额外添加相同或相似的物体；人手结构正常；物体运动符合真实物理；除产品字样外不出现其他文字。',
  ].join('\n');
}

const spec = JSON.parse(await readFile(a.file, 'utf8'));
const dir = path.resolve(a.out); await mkdir(dir, { recursive: true });
const jobs = [];
for (const p of spec.pairs) {
  if (a.only && !a.only.split(',').includes(p.id)) continue;
  for (const side of (a.side ? [a.side] : ['A', 'B'])) {
    const seed = p[`seed_${side}`] || p.seed;
    const prompt = pairPrompt(p, side); const name = `${p.id}-${side}__seed${seed}`;
    if (a['dry-run']) { console.log(`== ${name}\n${prompt}\n`); continue; }
    jobs.push((async () => {
      const req = a.route === 'h3'
        ? { prompt, duration_seconds: 6, quality: 'medium', resolution: '720p', aspect_ratio: '9:16', seed }
        : { model: a.model, channel: 'libtv', prompt, duration_seconds: 6, resolution: '768p', aspect_ratio: '9:16', sound: true };
      const job = await submit(a.route, req, `vr-pair-${a.route}-${name}`);
      // 提交后立即记录任务编号，便于需要时取消
      console.log(`… ${name} 已提交 ${job.job_id}${job.deduplicated ? '（命中已有任务）' : ''}`);
      const done = await waitFor(a.route, job.job_id);
      await download(ROUTES[a.route].url(done), path.join(dir, `${name}.mp4`));
      await writeFile(path.join(dir, `${name}.json`), JSON.stringify({ name, pair: p.id, side, dim: p.dim, label: p[side].label, request: req, job_id: job.job_id }, null, 2) + '\n');
      console.log(`✓ ${name}`);
    })().catch((e) => console.log(`✗ ${name}: ${e.message}`)));
  }
}
await Promise.all(jobs);
