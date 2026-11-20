#!/usr/bin/env node
// 按任务编号续等并下载（不重新提交）：node src/resume-jobs.mjs --route h3 --out .work/pairs name=job_id ...
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROUTES, download, waitFor } from './aicentre.mjs';
const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { route: { type: 'string', default: 'h3' }, out: { type: 'string', default: '.work/pairs' } } });
await Promise.all(positionals.map(async (x) => {
  const [name, id] = x.split('=');
  try {
    const done = await waitFor(a.route, id, { timeoutMs: 3 * 3600000, intervalMs: 20000 });
    await download(ROUTES[a.route].url(done), path.join(path.resolve(a.out), `${name}.mp4`));
    console.log(`✓ ${name}`);
  } catch (e) { console.log(`✗ ${name}: ${e.message}`); }
}));
