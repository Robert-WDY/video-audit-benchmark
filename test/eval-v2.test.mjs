import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/eval-v2.mjs', import.meta.url));
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('三轮重复审核按完整用例计数，拒绝复用回执', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'v2-stability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = ['1', '2'].map(c => 'v_' + c.repeat(32));
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(ids.map(id => ({ id }))));
  const args = [cli, 'stability', '--input', root];
  const report = path.join(root, 'score.json');
  for (const [i, verdict] of ['pass', 'uncertain', 'fail'].entries()) {
    const dir = path.join(root, String(i));
    await mkdir(dir);
    args.push('--round', dir);
    const record = { status: verdict === 'uncertain' ? 'uncertain' : 'reviewed', verdict, receipts: [String(i)] };
    await writeFile(path.join(dir, ids[0] + '.json'), JSON.stringify(record));
  }
  args.push('--out', report);
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(run().status, 1);
  const s = await readJson(report);
  assert.deepEqual([s.complete, s.incomplete, s.any_flip, s.pair_changes, s.adjacent_changes, s.pass_fail], [1, 1, 1, 3, 2, 1]);
  await writeFile(path.join(root, '2', ids[0] + '.json'), JSON.stringify({status:'reviewed', verdict:'pass', receipts:['0']}));
  assert.match(run().stderr, /重复首审回执/);
});

test('v2 盲评端只读匿名材料，评分覆盖整组并显式处理失败', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-audit-eval-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = path.join(root, 'dataset');
  const pack = path.join(root, 'blind');
  const inputs = path.join(pack, 'inputs');
  const reviews = path.join(root, 'reviews');
  const keyFile = path.join(pack, 'key.json');
  const reportFile = path.join(root, 'report.json');
  const moduleFile = path.join(root, 'mock.mjs');
  await mkdir(path.join(dataset, 'videos'), { recursive: true });
  for (const briefSide of ['A', 'B']) {
    for (const videoSide of ['A', 'B']) {
      const pass = briefSide === videoSide;
      const id = (pass ? 'OK' : 'A1') + '__P-TEST__brief' + briefSide + '-video' + videoSide;
      const dir = path.join(dataset, 'cases', id);
      const video = id + '.mp4';
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'brief.json'), JSON.stringify({ requirements: [briefSide] }));
      await writeFile(path.join(dir, 'truth.json'), JSON.stringify({
        id, video, verdict: pass ? 'pass' : 'fail', source: 'pair', verified_by: 'human',
      }));
      await writeFile(path.join(dataset, 'videos', video), videoSide);
    }
  }
  await writeFile(moduleFile, `
import { readFile } from 'node:fs/promises';
import path from 'node:path';
export function createReview() {
  return {
    async video(input) {
      if (Object.keys(input).sort().join(',') !== 'brief,video') throw new Error('unexpected input');
      if (!/^v_[0-9a-f]{32}\\.mp4$/.test(path.basename(input.video))) throw new Error('not blind');
      return { ok: await readFile(input.video, 'utf8') === input.brief.requirements[0] };
    },
  };
}
`);
  const run = (expected, ...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', env: { ...process.env, REVIEW_MODULE: moduleFile },
    });
    assert.equal(result.status, expected, result.stderr || result.stdout);
  };
  run(0, 'prepare', '--dataset', dataset, '--out', pack);
  assert.deepEqual((await readdir(inputs)).sort(), ['manifest.json', 'videos']);
  const manifest = await readJson(path.join(inputs, 'manifest.json'));
  assert.equal(manifest.length, 4);
  assert.ok(manifest.every((row) => Object.keys(row).sort().join(',') === 'brief,id'));
  const filenames = await readdir(path.join(inputs, 'videos'));
  assert.deepEqual(filenames.sort(), manifest.map((row) => row.id + '.mp4').sort());

  const reviewArgs = ['review', '--input', inputs, '--out', reviews];
  const scoreArgs = ['score', '--key', keyFile, '--reviews', reviews, '--out', reportFile];
  run(0, ...reviewArgs);
  run(0, ...scoreArgs);
  const perfect = await readJson(reportFile);
  assert.equal(perfect.overall.accuracy_on_reviewed, 1);
  assert.equal(perfect.contrast_pairs.all_correct, 1);

  const key = await readJson(keyFile);
  const outputFor = (row) => path.join(reviews, row.id + '.json');
  await rm(outputFor(key[0]));
  await writeFile(outputFor(key[1]), '{"status":"unavailable"}');
  await writeFile(outputFor(key[2]), '{');
  await writeFile(outputFor(key[3]), JSON.stringify({
    status: 'reviewed', verdict: key[3].verdict === 'pass' ? 'fail' : 'pass',
  }));
  run(1, ...scoreArgs);
  const partial = await readJson(reportFile);
  assert.deepEqual(partial.overall.statuses, { reviewed: 1, uncertain: 0, missing: 1, unavailable: 1, invalid: 1 });
  assert.equal(partial.overall.coverage, 0.25);
  assert.equal(partial.contrast_pairs.complete, 0);

  run(0, ...reviewArgs);
  run(0, ...scoreArgs);
  const resumed = await readJson(reportFile);
  assert.equal(resumed.overall.accuracy_on_reviewed, 0.75);
  assert.equal(resumed.contrast_pairs.complete, 1);
  assert.equal(resumed.contrast_pairs.all_correct, 0);

  run(0, ...reviewArgs, '--force');
  run(0, ...scoreArgs);
  assert.equal((await readJson(reportFile)).contrast_pairs.all_correct, 1);

  const issues = [{ category: 'SA', t: 2.5, note: '动作受到遮挡' }];
  await writeFile(moduleFile, `export function createReview() { return { video: async () => ({
    verdict: 'uncertain', issues: ${JSON.stringify(issues)}
  }) }; }`);
  run(0, ...reviewArgs, '--force');
  run(0, ...scoreArgs);
  const deferred = await readJson(reportFile);
  assert.equal(deferred.complete, true);
  assert.equal(deferred.overall.statuses.uncertain, 4);
  assert.equal(deferred.overall.coverage, 0);
  assert.equal(deferred.overall.accuracy_on_reviewed, null);
  assert.equal(deferred.overall.accuracy_on_all, 0);
  assert.equal(deferred.overall.false_pass + deferred.overall.false_block, 0);
  assert.deepEqual((await readJson(outputFor(key[0]))).issues, issues);
  await writeFile(moduleFile, 'export const createReview = () => ({video() { throw Error("must not be called") }});');
  run(0, ...reviewArgs);
  assert.equal((await readJson(outputFor(key[0]))).status, 'uncertain');
});
