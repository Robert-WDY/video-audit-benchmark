#!/usr/bin/env node
// 视频审核评测集命令行。用法见 ../README.md。
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { agreement, blindSheet, finalize, parseCsv, readBlind, reconcileSheet, toCsv } from './annotate.mjs';
import { DEFAULT_SCENES, DEFAULT_TAXONOMY, expand, loadScenes, loadTaxonomy, summarizeCases, validateScene, validateTake } from './cases.mjs';
import { ffmpegArgs, probe, render } from './render.mjs';
import { aggregate, reportMarkdown, scoreCase } from './score.mjs';

const { positionals, values: a } = parseArgs({
  allowPositionals: true,
  options: {
    takes: { type: 'string' }, out: { type: 'string', default: 'video-review-out' },
    scenes: { type: 'string', default: DEFAULT_SCENES }, taxonomy: { type: 'string', default: DEFAULT_TAXONOMY },
    salt: { type: 'string', default: 'vr1' }, 'max-multi': { type: 'string', default: '3' }, 'max-combo': { type: 'string', default: '6' },
    ffmpeg: { type: 'string', default: process.env.FFMPEG_PATH || 'ffmpeg' }, font: { type: 'string', default: process.env.CAPTION_FONT },
    only: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, force: { type: 'boolean', default: false },
    config: { type: 'string', default: 'facts' }, concurrency: { type: 'string', default: '2' },
    blind: { type: 'string' }, sheet: { type: 'string' }, 'use-injected': { type: 'boolean', default: false }, seed: { type: 'string', default: '1' },
  },
});
const cmd = positionals[0];
const out = path.resolve(a.out);
const J = (x) => JSON.stringify(x, null, 2) + '\n';
const readJson = async (f) => JSON.parse(await readFile(f, 'utf8'));
const die = (m) => { console.error(m); process.exit(1); };

async function loadAll() {
  const tax = await loadTaxonomy(a.taxonomy); const scenes = await loadScenes(a.scenes);
  const errs = scenes.flatMap((s) => validateScene(s, tax));
  let takes = [];
  if (a.takes) {
    const file = path.resolve(a.takes); const m = await readJson(file);
    takes = (m.takes || []).map((t) => ({ ...t, path: path.resolve(path.dirname(file), t.path) }));
    for (const t of takes) errs.push(...validateTake(t, scenes.find((s) => s.id === t.scene), tax));
  }
  return { tax, scenes, takes, errs };
}

async function caseDirs() {
  const dir = path.join(out, 'cases');
  if (!existsSync(dir)) die(`找不到 ${dir}，请先运行 build`);
  return (await readdir(dir)).sort().map((d) => path.join(dir, d));
}
const loadTruths = async () => Promise.all((await caseDirs()).map((d) => readJson(path.join(d, 'truth.json'))));
// 视频文件：可读名（truth.video）；旧数据没有该字段时退回 blind_id
const videoOf = (t) => path.join(out, 'videos', t.video || `${t.blind_id}.mp4`);
const blindFiles = () => (a.blind || die('需要 --blind a.csv,b.csv')).split(',').map((f) => path.resolve(f.trim()));
const annotatorOf = (f) => path.basename(f).replace(/\.csv$/i, '');

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

const commands = {
  async validate() {
    const { errs, scenes, takes } = await loadAll();
    if (errs.length) die(`校验未通过：\n- ${errs.join('\n- ')}`);
    console.log(`校验通过：${scenes.length} 个场景，${takes.length} 条底片`);
  },

  async build() {
    if (!a.takes) die('需要 --takes 底片清单');
    const { tax, scenes, takes, errs } = await loadAll();
    if (errs.length) die(`校验未通过：\n- ${errs.join('\n- ')}`);
    const unverified = takes.filter((t) => !t.verified_clean).map((t) => t.id);
    const skipped = [];
    const cases = expand(scenes, takes, tax, { maxMultiPerTake: +a['max-multi'], maxComboPerTake: +a['max-combo'], salt: a.salt, skipped });
    for (const c of cases) {
      const d = path.join(out, 'cases', c.id.replace(/[^\w.+-]/g, '_'));
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, 'gen.json'), J(c.gen));
      await writeFile(path.join(d, 'input.json'), J(c.input));
      await writeFile(path.join(d, 'input.script.json'), J(c.input_script));
      await writeFile(path.join(d, 'truth.json'), J(c.truth));
    }
    const tasks = cases.filter((c) => c.gen.needs_manual).flatMap((c) => c.gen.manual_tasks.map((m) => ({
      case_id: c.id, base_take: c.gen.source, method: m.method, instruction: m.instruction,
      then_auto_ops: c.gen.ops.filter((o) => o.op !== 'cut').map((o) => o.op).join('+') || '-',
      deliver_to: path.join('manual', `${c.id}.mp4`),
    })));
    await mkdir(path.join(out, 'manual'), { recursive: true });
    await writeFile(path.join(out, 'manual-tasks.csv'), toCsv(['case_id', 'base_take', 'method', 'instruction', 'then_auto_ops', 'deliver_to'], tasks));
    await writeFile(path.join(out, 'skipped.json'), J(skipped));
    const summary = summarizeCases(cases);
    await writeFile(path.join(out, 'index.json'), J({ built_at: new Date().toISOString(), salt: a.salt, summary, unverified_takes: unverified }));
    console.log(J(summary));
    console.log(`已写入 ${out}；手工任务 ${tasks.length} 条见 manual-tasks.csv；跳过的冲突组合 ${skipped.length} 个见 skipped.json`);
    if (unverified.length) console.warn(`注意：${unverified.length} 条底片还没有盲审确认干净（verified_clean=false）：${unverified.join(', ')}`);
  },

  async render() {
    const dirs = (await caseDirs()).filter((d) => !a.only || path.basename(d).includes(a.only));
    const probes = new Map(); let ok = 0; let wait = 0; let fail = 0;
    for (const d of dirs) {
      const gen = await readJson(path.join(d, 'gen.json')); const truth = await readJson(path.join(d, 'truth.json'));
      const dst = videoOf(truth);
      if (existsSync(dst) && !a.force) { ok++; continue; }
      const src = gen.needs_manual ? path.join(out, 'manual', `${gen.case_id}.mp4`) : path.resolve(out, gen.source);
      if (a['dry-run'] && !gen.needs_manual) {
        const fake = { duration: gen.duration, width: 1080, height: 1920, fps: 30, audio: true };
        const args = ffmpegArgs(src, dst, gen, existsSync(src) && existsSync(a.ffmpeg) ? await probe(a.ffmpeg, src) : fake, { font: a.font || '/path/to/cjk-font.ttc' });
        console.log(`[dry-run] ${gen.case_id} → ${path.relative(out, dst)}（filter ${args[args.indexOf('-filter_complex') + 1].split(';').length} 段）`);
        ok++; continue;
      }
      if (!existsSync(src)) { wait++; if (gen.needs_manual) console.log(`等待手工素材 ${path.relative(out, src)}`); else console.warn(`缺少底片 ${src}`); continue; }
      try {
        if (!probes.has(src)) probes.set(src, a['dry-run'] && !existsSync(a.ffmpeg) ? { duration: gen.duration, width: 1080, height: 1920, fps: 30, audio: true } : await probe(a.ffmpeg, src));
        const p = probes.get(src);
        const srcDur = gen.pieces.reduce((m, x) => Math.max(m, x.src ? x.src[1] : 0), 0);
        if (gen.needs_manual && p.duration + 0.3 < srcDur) throw new Error(`手工素材时长 ${p.duration}s 短于底片 ${srcDur}s，标记点对不上`);
        if (a['dry-run']) { console.log(`[dry-run] ${gen.case_id} → ${path.relative(out, dst)}`); ok++; continue; }
        await render(a.ffmpeg, src, dst, gen, p, { font: a.font });
        ok++; console.log(`✓ ${gen.case_id}`);
      } catch (e) { fail++; console.error(`✗ ${gen.case_id}: ${e.message}`); }
    }
    console.log(`完成 ${ok}，等待素材 ${wait}，失败 ${fail}`);
    if (fail) process.exitCode = 1;
  },

  async review() {
    const { REVIEW_MODULE: mod, REVIEW_RELAY_BASE: base, REVIEW_RELAY_KEY: key, REVIEW_MODEL: model } = process.env;
    if (!mod) die('需要环境变量 REVIEW_MODULE：被评测审核模块的路径，模块需导出 createReview({relayBase, relayKey, model}).video({video, plan, request})');
    if (!base || !key) die('需要环境变量 REVIEW_RELAY_BASE 与 REVIEW_RELAY_KEY（传给被评测审核模块）');
    if (!['facts', 'script'].includes(a.config)) die('--config 只能是 facts 或 script');
    const { pathToFileURL } = await import('node:url');
    const { createReview } = await import(pathToFileURL(path.resolve(mod)).href);
    const rv = createReview({ relayBase: base, relayKey: key, ...(model ? { model } : {}) });
    const dirs = (await caseDirs()).filter((d) => !a.only || path.basename(d).includes(a.only));
    const rdir = path.join(out, 'reviews', a.config); await mkdir(rdir, { recursive: true });
    let done = 0;
    await pool(dirs, +a.concurrency, async (d) => {
      const truth = await readJson(path.join(d, 'truth.json'));
      const video = videoOf(truth);
      const dst = path.join(rdir, `${truth.case_id}.json`);
      if (!existsSync(video) || (existsSync(dst) && !a.force)) return;
      const input = await readJson(path.join(d, a.config === 'script' ? 'input.script.json' : 'input.json'));
      const t0 = Date.now();
      const res = await rv.video({ video, plan: input.plan, request: input.request });
      await writeFile(dst, J({ ...res, _ms: Date.now() - t0 }));
      done++; console.log(`${res.reason === 'review_unavailable' ? '!' : res.ok ? '·' : '×'} ${truth.case_id}`);
    });
    console.log(`本次审核 ${done} 条，结果在 ${path.relative(process.cwd(), rdir)}`);
  },

  async sheets() {
    const truths = await loadTruths();
    const have = truths.filter((t) => existsSync(videoOf(t)));
    const bdir = path.join(out, 'annotation', 'blind');
    await mkdir(bdir, { recursive: true });
    // 盲审用的副本：文件名只有不透明的 blind_id，看不出场景和错误
    for (const t of have) await copyFile(videoOf(t), path.join(bdir, `${t.blind_id}.mp4`));
    const f = path.join(out, 'annotation', 'blind-template.csv');
    await writeFile(f, blindSheet(have, { seed: +a.seed }));
    console.log(`盲审表 ${f}（${have.length} 条视频）。只把 annotation/blind/ 目录给标注员，不要给 videos/（文件名里有答案）。每位标注员复制一份表，命名为 <标注员>.csv。`);
  },

  async index() {
    const truths = (await loadTruths()).filter((t) => existsSync(videoOf(t)));
    const tierName = { clean: '正确', control: '对照', decoy: '干扰项', single: '单错误', multi: '同类多错误', combo: '异类多错误' };
    const order = ['clean', 'decoy', 'control', 'single', 'multi', 'combo'];
    truths.sort((x, y) => x.take.localeCompare(y.take) || order.indexOf(x.tier) - order.indexOf(y.tier) || (x.video || '').localeCompare(y.video || ''));
    const fmtW = (ws) => ws.map(([s, e]) => (e - s < 0.05 ? `${s.toFixed(1)}s` : `${s.toFixed(1)}–${e.toFixed(1)}s`)).join(', ');
    const rows = truths.map((t) => {
      const inj = t.injected.map((e) => `**${e.sub}** ${fmtW(e.windows)} ${e.description}`);
      const base = (t.base_errors || []).map((e) => `底片自带 **${e.sub}** ${fmtW(e.windows)} ${e.description}`);
      const errs = [...inj, ...base].join('<br>') || (t.decoy ? `无错误。看起来像 ${t.decoy.looks_like}：${t.decoy.description}` : '无错误');
      const notes = [...(t.base_notes || []).map((x) => `复核备注：${x}`), t.bundle && `同镜头组合：${t.bundle}`, t.same_picture_as && `画面与 ${t.same_picture_as} 相同（只有声音不同）`, t.ref && `对照 ${t.ref}`].filter(Boolean).join('；');
      const shot = t.injected.length > 1 ? (t.continuous ? '同一连续镜头' : '含剪辑') : '';
      return `| [${t.video}](${encodeURIComponent(t.video)}) | ${tierName[t.tier] || t.tier} | ${shot} | ${errs} | ${notes} |`;
    });
    const md = ['# 视频清单', '', `共 ${truths.length} 条。时间为输出视频中的秒数；「同一连续镜头」表示时间轴没有被剪辑，多个错误叠加在同一段画面里。`, '',
      '| 文件 | 类型 | 镜头 | 错误（子类 时间 描述） | 备注 |', '|---|---|---|---|---|', ...rows, ''].join('\n');
    const f = path.join(out, 'videos', 'INDEX.md');
    await writeFile(f, md);
    console.log(`已写入 ${f}（${truths.length} 条）`);
  },

  async reconcile() {
    const tax = await loadTaxonomy(a.taxonomy); const truths = await loadTruths();
    const blinds = await Promise.all(blindFiles().map(async (f) => readBlind(parseCsv(await readFile(f, 'utf8')), annotatorOf(f))));
    const judged = new Set(blinds.flatMap((b) => [...b.entries()].filter(([, v]) => v.judged).map(([k]) => k)));
    const f = path.join(out, 'annotation', 'reconcile.csv');
    await writeFile(f, reconcileSheet(truths.filter((t) => judged.has(t.blind_id)), blinds, tax));
    console.log(`复核表 ${f}。逐行在 verdict 填 present/partial/absent/accidental/reject/clean/ignore；估计窗口可直接改 t_start/t_end。`);
  },

  async agreement() {
    const tax = await loadTaxonomy(a.taxonomy); const fs = blindFiles();
    if (fs.length !== 2) die('agreement 需要恰好两份盲审表');
    const [x, y] = await Promise.all(fs.map(async (f) => readBlind(parseCsv(await readFile(f, 'utf8')), annotatorOf(f))));
    console.log(J(agreement(x, y, tax)));
  },

  async finalize() {
    const tax = await loadTaxonomy(a.taxonomy);
    const rows = parseCsv(await readFile(path.resolve(a.sheet || path.join(out, 'annotation', 'reconcile.csv')), 'utf8'));
    const dirs = await caseDirs(); const truths = await Promise.all(dirs.map((d) => readJson(path.join(d, 'truth.json'))));
    const { truths: next, pending } = finalize(truths, rows, tax);
    for (let i = 0; i < dirs.length; i++) await writeFile(path.join(dirs[i], 'truth.json'), J(next[i]));
    const by = next.reduce((m, t) => { m[t.annotation_status] = (m[t.annotation_status] || 0) + 1; return m; }, {});
    console.log(`真值已更新：${Object.entries(by).map(([k, v]) => `${k} ${v}`).join('，')}`);
    if (pending.length) console.warn(`以下行未裁定，对应用例未定稿：\n- ${pending.slice(0, 30).join('\n- ')}${pending.length > 30 ? `\n…共 ${pending.length} 行` : ''}`);
  },

  async score() {
    const tax = await loadTaxonomy(a.taxonomy); const truths = await loadTruths();
    const rdir = path.join(out, 'reviews', a.config);
    const results = [];
    for (const t of truths) {
      const f = path.join(rdir, `${t.case_id}.json`);
      if (!existsSync(f)) continue;
      results.push(scoreCase(t, await readJson(f), tax, { useInjected: a['use-injected'] }));
    }
    if (!results.length) die(`${rdir} 下没有审核结果`);
    const agg = aggregate(results);
    await writeFile(path.join(out, `results-${a.config}.json`), J({ aggregate: agg, cases: results }));
    const md = reportMarkdown(agg, { config: a.config, tax });
    await writeFile(path.join(out, `report-${a.config}.md`), md);
    console.log(md);
    if (a['use-injected']) console.warn('注意：--use-injected 用的是注入记录而不是人工定稿真值，只能用于调试流程，不能当正式结论。');
  },
};

if (!commands[cmd]) {
  console.log('用法: node src/cli.mjs <validate|build|render|index|review|sheets|reconcile|agreement|finalize|score> [选项]\n详见 README.md');
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
