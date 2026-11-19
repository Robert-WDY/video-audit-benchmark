import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../src/timeline.mjs';
import { buildFilter, escapeText, ffmpegArgs, parseProbe } from '../src/render.mjs';

const P = { width: 1080, height: 1920, fps: 30, audio: true, duration: 8 };

test('解析 ffmpeg -i 的输出', () => {
  const s = 'Duration: 00:00:08.03, start: 0\n  Stream #0:0(und): Video: h264 (High), yuv420p, 1080x1920 [SAR 1:1 DAR 9:16], 30 fps\n  Stream #0:1(und): Audio: aac';
  assert.deepEqual(parseProbe(s), { duration: 8.03, width: 1080, height: 1920, fps: 30, audio: true });
});

test('倒放片段带 reverse/areverse，跳变标记不产生输入', () => {
  const tl = applyOps(8, [{ op: 'reverse', from: 2, to: 5, id: 'A' }, { op: 'drop', from: 6, to: 7, id: 'B' }]);
  const { filter } = buildFilter(tl, P);
  assert.match(filter, /trim=start=2\.0000:end=5\.0000,setpts=PTS-STARTPTS,reverse/);
  assert.match(filter, /areverse/);
  assert.match(filter, /concat=n=4:v=1:a=1\[vc\]\[ac\]/);
});

test('冻帧和黑场生成定长片段与静音', () => {
  const tl = applyOps(6, [{ op: 'freeze', at: 2, dur: 1.5, id: 'F' }, { op: 'black', at: 4, dur: 0.6, id: 'B' }]);
  const { filter } = buildFilter(tl, P);
  assert.match(filter, /tpad=stop_mode=clone:stop_duration=1\.5000/);
  assert.match(filter, /color=c=black:s=1080x1920:r=30:d=0\.6000/);
  assert.equal((filter.match(/anullsrc/g) || []).length, 2);
});

test('叠加层：区域换色、白闪、字幕、静音', () => {
  const tl = applyOps(8, [
    { op: 'tint', from: 4, to: 8, region: [0.3, 0.25, 0.4, 0.5], hue: 200, id: 'T' },
    { op: 'flash', at: 4, frames: 1, id: 'L' },
    { op: 'caption', from: 0.5, to: 3, text: "500ml: 超'大", id: 'C' },
    { op: 'mute', from: 2, to: 5, id: 'M' },
  ]);
  const { filter, vout, aout } = buildFilter(tl, P, { font: '/f/NotoSansCJK.ttc' });
  assert.match(filter, /crop=432:960:324:480,hue=h=200/);
  assert.match(filter, /overlay=324:480:enable='between\(t,4\.0000,8\.0000\)'/);
  assert.match(filter, /drawbox=.*between\(t,4\.0000,4\.0323\)/);
  assert.match(filter, /text='500ml\\: 超’大':expansion=none/);
  assert.match(filter, /volume=volume=0:enable='between\(t,2\.0000,5\.0000\)'/);
  assert.equal(vout, 'vo2'); assert.ok(aout.startsWith('ao'));
});

test('白色物体用半透明色块换色', () => {
  const tl = applyOps(8, [{ op: 'tint', from: 1, to: 3, region: [0, 0, 0.5, 0.5], color: '#ff8fb0', opacity: 0.4, id: 'T' }]);
  const { filter } = buildFilter(tl, P);
  assert.match(filter, /color=c=#ff8fb0@0\.4:s=540x960/);
});

test('字幕缺字体时报错；无音轨时不建音频链', () => {
  const tl = applyOps(8, [{ op: 'caption', from: 0, to: 1, text: 'x', id: 'C' }]);
  assert.throws(() => buildFilter(tl, P), /--font/);
  const { filter, aout } = buildFilter(applyOps(8, []), { ...P, audio: false });
  assert.doesNotMatch(filter, /atrim/); assert.equal(aout, null);
  const args = ffmpegArgs('in.mp4', 'out.mp4', applyOps(8, []), { ...P, audio: false });
  assert.equal(args.filter((x) => x === '-map').length, 1);
});

test('转义冒号和反斜杠', () => {
  assert.equal(escapeText('a:b'), 'a\\:b');
});
