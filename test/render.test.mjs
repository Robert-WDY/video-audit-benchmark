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

test('按颜色选区换色：只改 key 颜色附近的像素', () => {
  const tl = applyOps(8, [{ op: 'tint', from: 4, to: 8, region: [0, 0, 1, 1], hue: 90, key: '#2aa8ff', similarity: 0.35, id: 'K' }]);
  const { filter } = buildFilter(tl, P);
  assert.match(filter, /split=3/);
  assert.match(filter, /colorkey=color=0x2aa8ff:similarity=0\.35:blend=0\.15,alphaextract,negate/);
  assert.match(filter, /alphamerge/);
  assert.match(filter, /overlay=0:0:enable='between\(t,4\.0000,8\.0000\)'/);
});

test('局部操作：复制区域、镜像、区域定格、区域时移都带羽化并按窗口生效', () => {
  const tl = applyOps(6, [
    { op: 'clone', from: 1, to: 3, region: [0.4, 0.5, 0.1, 0.1], dx: -0.12, dy: 0, id: 'C' },
    { op: 'flip_region', from: 0, to: 2, region: [0.4, 0.4, 0.2, 0.1], id: 'F' },
    { op: 'freeze_region', at: 0.5, from: 2, to: 6, region: [0, 0.6, 0.5, 0.3], id: 'Z' },
    { op: 'retime_region', src_from: 4, from: 1, to: 2.5, region: [0.1, 0.3, 0.8, 0.2], id: 'R' },
  ]);
  const { filter } = buildFilter(tl, P);
  assert.equal((filter.match(/geq=r='r\(X,Y\)'/g) || []).length, 4);
  assert.match(filter, /crop=108:192:432:960,format=rgba/);
  assert.match(filter, /overlay=302:960:eof_action=pass:enable='between\(t,1\.0000,3\.0000\)'/);
  assert.match(filter, /hflip/);
  assert.match(filter, /\[0:v\]trim=start=0\.5000:duration=0\.0333,setpts=PTS-STARTPTS,.*tpad=stop_mode=clone:stop_duration=7\.0000/);
  assert.match(filter, /\[0:v\]trim=start=4\.0000:duration=1\.6000,setpts=PTS-STARTPTS\+1\.0000\/TB/);
  assert.deepEqual(tl.windows, { C: [[1, 3]], F: [[0, 2]], Z: [[2, 6]], R: [[1, 2.5]] });
});

test('按色度选区：只对蓝色度高的像素去色压暗', () => {
  const tl = applyOps(6, [{ op: 'tint', from: 3, to: 6, region: [0, 0, 1, 1], chroma: 'blue', threshold: 3, gain: 24, darken: -0.42, id: 'D' }]);
  const { filter } = buildFilter(tl, P);
  assert.match(filter, /hue=h=0:s=0,eq=brightness=-0\.42/);
  assert.match(filter, /geq=lum='clip\(\(cb\(X,Y\)-128-3\)\*24,0,255\)':cb=128:cr=128,format=gray/);
});
