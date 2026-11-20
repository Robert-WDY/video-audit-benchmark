#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const isVerdict = (value) => value === 'pass' || value === 'fail';
const isBlindId = (id) => typeof id === 'string' && /^v_[0-9a-f]{32}$/.test(id);
const newId = () => `v_${randomUUID().replaceAll('-', '')}`;

async function writeJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, json(value), { flag: 'wx' });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

function validateIds(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.some((row) => !isBlindId(row?.id))
      || new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error('匿名用例清单为空或包含无效、重复的 ID');
  }
}

function groupPairs(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.pair) continue;
    if (!groups.has(row.pair)) groups.set(row.pair, []);
    groups.get(row.pair).push(row);
  }
  return groups;
}

async function prepare(dataset, out) {
  if (existsSync(out)) throw new Error(`输出目录已存在，请为新的盲评包选择另一目录：${out}`);
  const casesDir = path.join(dataset, 'cases');
  const inputs = [];
  const key = [];
  const videos = new Map();
  for (const entry of await readdir(casesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(casesDir, entry.name);
    const [brief, truth] = await Promise.all(['brief.json', 'truth.json'].map((name) => readJson(path.join(dir, name))));
    if (truth.id !== entry.name || !isVerdict(truth.verdict) || typeof truth.video !== 'string'
        || !truth.video.endsWith('.mp4') || truth.video !== path.basename(truth.video) || !Array.isArray(brief.requirements)) {
      throw new Error(`无效的 v2 用例：${entry.name}`);
    }
    const pair = truth.source === 'pair' ? /^[^_]+__(.+)__brief([AB])-video([AB])$/.exec(truth.id) : null;
    if (truth.source === 'pair' && (!pair || (pair[2] === pair[3]) !== (truth.verdict === 'pass'))) {
      throw new Error(`对照用例与配对规则不一致：${truth.id}`);
    }
    const id = newId();
    inputs.push({ id, brief });
    key.push({
      id, case_id: truth.id, verdict: truth.verdict, verified_by: truth.verified_by || 'none',
      pair: pair?.[1] ?? null, sides: pair ? pair[2] + pair[3] : null,
    });
    videos.set(id, path.join(dataset, 'videos', truth.video));
  }
  validateIds(inputs);
  for (const [pair, rows] of groupPairs(key)) {
    if (new Set(rows.map((row) => row.sides)).size !== 4 || rows.length !== 4) {
      throw new Error(`对照组缺少或重复组合：${pair}`);
    }
  }

  // 按随机 ID 排序，避免目录的答案顺序进入审核包。
  inputs.sort((a, b) => a.id.localeCompare(b.id));
  const parent = path.dirname(out);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, '.v2-blind-'));
  try {
    const videoDir = path.join(staging, 'inputs', 'videos');
    await mkdir(videoDir, { recursive: true });
    for (const { id } of inputs) await copyFile(videos.get(id), path.join(videoDir, `${id}.mp4`));
    await writeFile(path.join(staging, 'inputs', 'manifest.json'), json(inputs));
    await writeFile(path.join(staging, 'key.json'), json(key));
    await rename(staging, out);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log(`已导出 ${inputs.length} 条审核输入。分发 ${path.join(out, 'inputs')}，评分映射见 key.json。`);
}

async function readResult(dir, id) {
  try {
    const result = await readJson(path.join(dir, `${id}.json`));
    if (result?.status === 'reviewed' && isVerdict(result.verdict)) return result;
    if (result?.status === 'uncertain' && result.verdict === 'uncertain') return result;
    if (result?.status === 'unavailable') return { status: 'unavailable' };
    return { status: 'invalid' };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    if (error instanceof SyntaxError) return { status: 'invalid' };
    throw error;
  }
}

function normalizeReview(result) {
  if (result?.reason === 'review_unavailable' || result?.verdict === 'unavailable') return { status: 'unavailable' };
  const evidence = Object.fromEntries(['issues', 'reviewer', 'media_sha256', 'brief_sha256', 'receipts']
    .filter(field => result?.[field] !== undefined).map(field => [field, result[field]]));
  if (result?.verdict === 'uncertain') return { status: 'uncertain', verdict: 'uncertain', ...evidence };
  if (isVerdict(result?.verdict)) return { status: 'reviewed', verdict: result.verdict, ...evidence };
  if (result?.verdict === undefined && typeof result?.ok === 'boolean') {
    return { status: 'reviewed', verdict: result.ok ? 'pass' : 'fail' };
  }
  return { status: 'invalid' };
}

async function review(input, out, concurrency, force) {
  const inputs = await readJson(path.join(input, 'manifest.json'));
  validateIds(inputs);
  if (inputs.some(({ brief }) => !Array.isArray(brief?.requirements))) throw new Error('审核清单中的创意要求无效');
  const { REVIEW_MODULE, REVIEW_RELAY_BASE: relayBase, REVIEW_RELAY_KEY: relayKey, REVIEW_MODEL: model } = process.env;
  const moduleUrl = REVIEW_MODULE ? pathToFileURL(path.resolve(REVIEW_MODULE)) : new URL('../reviewers/frozen/index.mjs', import.meta.url);
  const { createReview } = await import(moduleUrl.href);
  const stateDir = path.join(out, '.frozen-state', force ? randomUUID() : 'resume');
  const config = { relayBase, relayKey, model };
  const reviewer = await createReview(REVIEW_MODULE ? config : { ...config, stateDir });
  if (typeof reviewer?.video !== 'function') throw new Error('审核模块必须由 createReview 提供 video({video, brief}) 方法');
  await mkdir(out, { recursive: true });
  let next = 0;
  let incomplete = 0;
  async function worker() {
    while (next < inputs.length) {
      const { id, brief } = inputs[next++];
      if (!force && ['reviewed', 'uncertain'].includes((await readResult(out, id)).status)) continue;
      const file = path.join(input, 'videos', `${id}.mp4`);
      let result;
      try {
        if (!existsSync(file)) throw new Error('缺少审核视频');
        result = normalizeReview(await reviewer.video({ video: file, brief }));
      } catch {
        result = { status: 'unavailable' };
      }
      await writeJson(path.join(out, `${id}.json`), result);
      if (!['reviewed', 'uncertain'].includes(result.status)) {
        incomplete++;
        console.error(`${id}: ${result.status}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
  console.log(`有效审核 ${inputs.length - incomplete}/${inputs.length}`);
  if (incomplete) process.exitCode = 1;
}

const fraction = (n, d) => d ? n / d : null;

async function stability(input, rounds, out) {
  if (rounds?.length !== 3 || new Set(await Promise.all(rounds.map(dir => realpath(dir)))).size !== 3) {
    throw new Error('请用 --round 指定三个独立审核输出目录');
  }
  const inputs = await readJson(path.join(input, 'manifest.json'));
  validateIds(inputs);
  const cases = [];
  for (const { id } of inputs) {
    const records = await Promise.all(rounds.map(dir => readResult(dir, id)));
    const verdicts = records.map(r => r.verdict ?? null);
    const statuses = records.map(r => r.status);
    const jobs = records.map(r => r.receipts?.[0]).filter(Boolean);
    const sameInput = ['media_sha256', 'brief_sha256'].every(field =>
      new Set(records.map(r => r[field]).filter(Boolean)).size <= 1);
    const complete = statuses.every(s => s === 'reviewed' || s === 'uncertain');
    if (new Set(jobs).size !== jobs.length || !sameInput) throw new Error(`${id} 有重复首审回执或审核输入不一致`);
    const [a, b, c] = verdicts;
    cases.push({ id, verdicts, statuses, first_jobs_verified: jobs.length === 3,
      flip: complete ? new Set(verdicts).size > 1 : null,
      pair_changes: complete ? Number(a !== b) + Number(a !== c) + Number(b !== c) : null,
      adjacent_changes: complete ? Number(a !== b) + Number(b !== c) : null });
  }
  const valid = cases.filter(r => r.flip !== null);
  const flips = valid.filter(r => r.flip).length;
  const pairs = valid.reduce((n, r) => n + r.pair_changes, 0);
  const adjacent = valid.reduce((n, r) => n + r.adjacent_changes, 0);
  const report = { total: cases.length, complete: valid.length, incomplete: cases.length - valid.length,
    any_flip: flips, any_flip_rate: fraction(flips, valid.length),
    pair_changes: pairs, pair_disagreement: fraction(pairs, 3 * valid.length),
    adjacent_changes: adjacent, adjacent_disagreement: fraction(adjacent, 2 * valid.length),
    pass_fail: valid.filter(r => r.verdicts.includes('pass') && r.verdicts.includes('fail')).length,
    cases };
  await mkdir(path.dirname(out), { recursive: true });
  await writeJson(out, report);
  console.log(`三轮齐备 ${valid.length}/${cases.length}，至少翻转一次 ${flips} 条。`);
  if (report.incomplete) process.exitCode = 1;
}

function summarize(cases) {
  const statuses = { reviewed: 0, uncertain: 0, missing: 0, unavailable: 0, invalid: 0 };
  let correct = 0;
  let passed = 0;
  let blocked = 0;
  let falsePass = 0;
  let falseBlock = 0;
  for (const row of cases) {
    statuses[row.status]++;
    if (row.status !== 'reviewed') continue;
    correct += Number(row.correct);
    if (row.expected === 'pass') {
      passed++;
      falseBlock += Number(!row.correct);
    } else {
      blocked++;
      falsePass += Number(!row.correct);
    }
  }
  return {
    total: cases.length, statuses, correct,
    coverage: fraction(statuses.reviewed, cases.length),
    accuracy_on_reviewed: fraction(correct, statuses.reviewed),
    accuracy_on_all: fraction(correct, cases.length),
    pass_reviewed: passed, fail_reviewed: blocked,
    false_block: falseBlock, false_pass: falsePass,
    false_block_rate: fraction(falseBlock, passed), false_pass_rate: fraction(falsePass, blocked),
  };
}

async function score(keyFile, reviews, out) {
  const key = await readJson(keyFile);
  validateIds(key);
  if (key.some((row) => !isVerdict(row.verdict))) throw new Error('评分映射含无效真值');
  const cases = await Promise.all(key.map(async (row) => {
    const result = await readResult(reviews, row.id);
    return {
      id: row.id, case_id: row.case_id, pair: row.pair, verified_by: row.verified_by,
      expected: row.verdict, actual: result.verdict ?? null, status: result.status,
      correct: result.status === 'reviewed' ? row.verdict === result.verdict : null,
    };
  }));
  const groups = Array.from(groupPairs(cases), ([pair, rows]) => ({
    pair, reviewed: rows.filter((row) => row.status === 'reviewed').length,
    correct: rows.filter((row) => row.correct).length,
  }));
  const full = groups.filter((row) => row.reviewed === 4).length;
  const allCorrect = groups.filter((row) => row.correct === 4).length;
  const overall = summarize(cases);
  const report = {
    complete: overall.statuses.reviewed + overall.statuses.uncertain === overall.total,
    overall,
    by_verification: Object.fromEntries([...new Set(cases.map((row) => row.verified_by))]
      .map((level) => [level, summarize(cases.filter((row) => row.verified_by === level))])),
    contrast_pairs: { total: groups.length, complete: full, all_correct: allCorrect, groups },
    cases,
  };
  await mkdir(path.dirname(out), { recursive: true });
  await writeJson(out, report);
  console.log(`确定判词 ${overall.statuses.reviewed}/${overall.total}，待复核 ${overall.statuses.uncertain}，判对 ${overall.correct}，四项全对 ${allCorrect}/${groups.length} 组。报告：${out}`);
  if (!report.complete) process.exitCode = 1;
}

const usage = `用法：
  node src/eval-v2.mjs prepare --dataset <已组装的 v2> --out <新目录>
  node src/eval-v2.mjs review --input <盲评包/inputs> --out <审核输出目录> [--concurrency 2] [--force]
  node src/eval-v2.mjs score --key <盲评包/key.json> --reviews <审核输出目录> --out <报告.json>
  node src/eval-v2.mjs stability --input <盲评包/inputs> --round <R1> --round <R2> --round <R3> --out <报告.json>`;
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    dataset: { type: 'string' }, out: { type: 'string' }, input: { type: 'string' }, key: { type: 'string' },
    reviews: { type: 'string' }, concurrency: { type: 'string', default: '2' },
    round: { type: 'string', multiple: true }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [cmd] = positionals;
  if (values.help || !cmd) {
    console.log(usage);
  } else {
    const requiredPath = (name) => {
      if (!values[name]) throw new Error(`需要 --${name}`);
      return path.resolve(values[name]);
    };
    if (cmd === 'prepare') {
      await prepare(requiredPath('dataset'), requiredPath('out'));
    } else if (cmd === 'review') {
      const concurrency = Number(values.concurrency);
      if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('--concurrency 必须是正整数');
      await review(requiredPath('input'), requiredPath('out'), concurrency, values.force);
    } else if (cmd === 'score') {
      await score(requiredPath('key'), requiredPath('reviews'), requiredPath('out'));
    } else if (cmd === 'stability') {
      await stability(requiredPath('input'), values.round, requiredPath('out'));
    } else {
      throw new Error(`未知命令：${cmd}\n${usage}`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
