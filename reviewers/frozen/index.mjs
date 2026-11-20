import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./review.py', import.meta.url));

export function createReview({ stateDir, model } = {}) {
  if (process.platform !== 'win32') throw new Error('冻结审核需要 Windows 简体中文 OCR。');
  for (const key of ['AICENTRE_BASE_URL', 'AICENTRE_API_KEY', 'FROZEN_BOARD_BASE', 'FROZEN_BOARD_KEY', 'FROZEN_BOARD_MODEL']) {
    if (!process.env[key]) throw new Error('缺少审核配置 ' + key);
  }
  const python = process.env.REVIEW_PYTHON || 'python';
  const preflight = spawnSync(python, ['-c', 'import sys,shutil,numpy,PIL,filelock,requests; sys.exit(0 if sys.version_info >= (3,11) and all(shutil.which(x) for x in ("powershell","ffmpeg","ffprobe")) else 1)'], { windowsHide: true });
  if (preflight.status !== 0) throw new Error('请检查 Python 3.11+、审核依赖、PowerShell 与 FFmpeg。');
  const state = path.resolve(stateDir || '.work/frozen-review-state');
  return {
    video({ video, brief }) {
      return new Promise((resolve, reject) => {
        const proc = spawn(python, ['-X', 'utf8', script], {
          windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', REVIEW_MODEL: model || process.env.REVIEW_MODEL || 'qwen3.8-omni-flash' },
        });
        let output = '';
        proc.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
        proc.on('error', reject);
        proc.stdin.on('error', reject);
        proc.on('close', code => {
          if (code !== 0) return reject(new Error('冻结审核执行失败'));
          try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
        });
        proc.stdin.end(JSON.stringify({ video: path.resolve(video), brief, state }));
      });
    },
  };
}
