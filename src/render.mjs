// 把 timeline 的片段和叠加层翻译成一条 ffmpeg 命令。
// 错误样本与对照组走完全相同的管线（trim → concat → 叠加 → 同参数编码），
// 避免审核靠「被剪辑/重编码过」这种痕迹而不是内容来判错。
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export const ENCODE = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart'];

const n = (x) => Number(x).toFixed(4);

export function parseProbe(stderr) {
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  const v = /Stream #\d+:\d+.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  const f = /(\d+(?:\.\d+)?)\s*fps/.exec(stderr);
  if (!d || !v) throw new Error('无法读取视频信息');
  return {
    duration: +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]),
    width: +v[1], height: +v[2], fps: f ? Math.round(parseFloat(f[1])) : 30,
    audio: /Stream #\d+:\d+.*Audio:/.test(stderr),
  };
}

// drawtext 的转义：反斜杠、冒号；单引号换成全角，百分号靠 expansion=none 关闭展开
export function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019');
}

const between = ([s, e]) => `enable='between(t,${n(s)},${n(e)})'`;

export function buildFilter({ pieces, overlays = [] }, probe, { font } = {}) {
  const { width: W, height: H, fps, audio } = probe;
  const norm = `fps=${fps},scale=${W}:${H},setsar=1,format=yuv420p`;
  const chains = []; const vl = []; const al = [];
  let k = 0;
  for (const p of pieces) {
    if (p.marker) continue;
    const i = k++;
    if (p.src) {
      const [a, b] = p.src; const sp = p.speed || 1;
      chains.push(`[0:v]trim=start=${n(a)}:end=${n(b)},setpts=PTS-STARTPTS${p.rev ? ',reverse' : ''}` +
        `${sp !== 1 ? `,setpts=PTS/${sp}` : ''},${norm}[v${i}]`);
      if (audio) {
        chains.push(`[0:a]atrim=start=${n(a)}:end=${n(b)},asetpts=PTS-STARTPTS,aresample=48000${p.rev ? ',areverse' : ''}` +
          `${sp !== 1 ? `,atempo=${sp}` : ''}[a${i}]`);
      }
    } else if (p.hold !== undefined) {
      chains.push(`[0:v]trim=start=${n(p.hold)}:duration=${n(1 / fps)},setpts=PTS-STARTPTS,` +
        `tpad=stop_mode=clone:stop_duration=${n(p.dur)},trim=duration=${n(p.dur)},${norm}[v${i}]`);
      if (audio) chains.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n(p.dur)}[a${i}]`);
    } else if (p.black !== undefined) {
      chains.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${n(p.black)},${norm}[v${i}]`);
      if (audio) chains.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n(p.black)}[a${i}]`);
    } else continue;
    vl.push(`[v${i}]`); if (audio) al.push(`[a${i}]`);
  }
  if (!vl.length) throw new Error('输出为空');
  chains.push(audio
    ? `${vl.map((v, i) => v + al[i]).join('')}concat=n=${vl.length}:v=1:a=1[vc][ac]`
    : `${vl.join('')}concat=n=${vl.length}:v=1:a=0[vc]`);

  let v = 'vc'; let a = audio ? 'ac' : null; let j = 0;
  for (const o of overlays) {
    const nv = `vo${j++}`;
    if (o.op === 'tint') {
      const [rx, ry, rw, rh] = o.region || [0, 0, 1, 1];
      const cw = Math.max(2, Math.round(rw * W / 2) * 2); const ch = Math.max(2, Math.round(rh * H / 2) * 2);
      const cx = Math.round(rx * W); const cy = Math.round(ry * H);
      if (o.color) {
        // 白色/无彩色物体换色调无效，改为在区域内叠一层半透明色
        chains.push(`color=c=${o.color}@${o.opacity ?? 0.4}:s=${cw}x${ch}:r=${fps},format=rgba[${nv}c]`,
          `[${v}][${nv}c]overlay=${cx}:${cy}:shortest=1:${between(o.out)}[${nv}]`);
        v = nv; continue;
      }
      chains.push(`[${v}]split[${nv}b][${nv}t]`,
        `[${nv}t]crop=${cw}:${ch}:${cx}:${cy},hue=h=${o.hue ?? 180}:s=${o.saturation ?? 1}[${nv}c]`,
        `[${nv}b][${nv}c]overlay=${cx}:${cy}:${between(o.out)}[${nv}]`);
    } else if (o.op === 'flash') {
      const e = o.out[0] + (o.frames || 1) / fps - 1e-3;
      chains.push(`[${v}]drawbox=x=0:y=0:w=iw:h=ih:color=${o.color || 'white'}@1:t=fill:${between([o.out[0], e])}[${nv}]`);
    } else if (o.op === 'caption') {
      if (!font) throw new Error('caption 需要 --font 指定含中文字形的字体文件');
      chains.push(`[${v}]drawtext=fontfile='${font}':text='${escapeText(o.text)}':expansion=none:fontsize=h/20:fontcolor=white:` +
        `borderw=4:bordercolor=black@0.8:x=(w-tw)/2:y=h*0.78:${between(o.out)}[${nv}]`);
    } else if (o.op === 'mute') {
      if (!audio) throw new Error('mute 需要底片带音轨');
      const na = `ao${j}`;
      chains.push(`[${a}]volume=volume=0:${between(o.out)}[${na}]`);
      a = na; j++; continue;
    } else throw new Error(`未知叠加层 ${o.op}`);
    v = nv;
  }
  return { filter: chains.join(';'), vout: v, aout: a };
}

export function ffmpegArgs(input, output, timeline, probe, opts = {}) {
  const { filter, vout, aout } = buildFilter(timeline, probe, opts);
  return ['-hide_banner', '-y', '-i', input, '-filter_complex', filter,
    '-map', `[${vout}]`, ...(aout ? ['-map', `[${aout}]`] : []), '-r', String(probe.fps), ...ENCODE, output];
}

export function exec(bin, args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const err = [];
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg 超时')); }, timeoutMs);
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: Buffer.concat(err).toString('utf8') }); });
  });
}

export async function probe(ffmpeg, input) {
  const r = await exec(ffmpeg, ['-hide_banner', '-i', input], 30000);
  return parseProbe(r.stderr);
}

export async function render(ffmpeg, input, output, timeline, probeInfo, opts) {
  await mkdir(path.dirname(output), { recursive: true });
  const r = await exec(ffmpeg, ffmpegArgs(input, output, timeline, probeInfo, opts));
  if (r.code !== 0) throw new Error(`ffmpeg 失败: ${r.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
}
