#!/usr/bin/env node
// 生成正确底片 / 提示词诱导的错误样本。
//   node src/generate.mjs --scene S03 [--inj S03.I6] [--seed 20261119] [--route h3] [--dur 6] [--dry-run]
// 同一场景的正确版和错误版用同一个 seed，提示词只差错误那一段。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { download, submit, waitFor } from './aicentre.mjs';
import { loadScenes } from './cases.mjs';
import { buildPrompt } from './prompt.mjs';

const { values: a } = parseArgs({ options: {
  scene: { type: 'string' }, inj: { type: 'string' }, seed: { type: 'string', default: '20261119' },
  route: { type: 'string', default: 'h3' }, model: { type: 'string', default: 'minimax-h3-hs' },
  dur: { type: 'string', default: '6' }, out: { type: 'string', default: '.work/gen' }, 'dry-run': { type: 'boolean', default: false },
} });

const scene = (await loadScenes()).find((s) => s.id === a.scene);
if (!scene) throw new Error(`没有场景 ${a.scene}`);
let inj = null;
if (a.inj) {
  inj = scene.injections.find((i) => i.id === a.inj);
  if (!inj) throw new Error(`没有错误 ${a.inj}`);
  const m = inj.ops.find((o) => o.op === 'manual' && o.method === 'prompt');
  if (m) inj = { ...inj, generation_hint: m.instruction.replace(/^照脚本生成[^，,]*[，,]\s*(但)?/, '') };
}
const prompt = buildPrompt(scene, inj);
const name = `${scene.id}__${inj ? inj.id : 'base'}__seed${a.seed}`;
const req = a.route === 'h3'
  ? { prompt, duration_seconds: +a.dur, quality: 'medium', resolution: '720p', aspect_ratio: '9:16', seed: +a.seed }
  : { model: a.model, channel: 'libtv', prompt, duration_seconds: +a.dur, resolution: '768p', aspect_ratio: '9:16', sound: false };

console.log(`== ${name}\n${prompt}\n`);
if (a['dry-run']) process.exit(0);
const dir = path.resolve(a.out); await mkdir(dir, { recursive: true });
const t0 = Date.now();
const job = await submit(a.route, req, `vr-${name}-${a.route}`);
console.log(`已提交 ${job.job_id}${job.deduplicated ? '（命中已有任务）' : ''}`);
let last = '';
const done = await waitFor(a.route, job.job_id, { onTick: (j) => { const s = `${j.status}/${j.stage ?? ''} ${j.progress ?? ''}`; if (s !== last) { console.log(`  ${s}`); last = s; } } });
const { ROUTES } = await import('./aicentre.mjs');
const url = ROUTES[a.route].url(done);
await download(url, path.join(dir, `${name}.mp4`));
await writeFile(path.join(dir, `${name}.json`), JSON.stringify({ name, route: a.route, request: req, job_id: job.job_id,
  channel: done.channel, seconds: Math.round((Date.now() - t0) / 1000), result_url: url }, null, 2) + '\n');
console.log(`✓ ${name}.mp4（${Math.round((Date.now() - t0) / 1000)}s）`);
