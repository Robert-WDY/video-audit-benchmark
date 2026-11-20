import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createReview(config) { return makeReviewer(config, 'frozen'); }

export function makeReviewer({ stateDir, model } = {}, mode) {
  const script = fileURLToPath(new URL('../' + mode + '/review.py', import.meta.url));
  for (const key of ['AICENTRE_BASE_URL', 'AICENTRE_API_KEY', 'FROZEN_BOARD_BASE', 'FROZEN_BOARD_KEY', 'FROZEN_BOARD_MODEL']) {
    if (!process.env[key]) throw new Error('缺少审核配置 ' + key);
  }
  const python = process.env.REVIEW_PYTHON || 'python';
  const backend = process.env.AUDIT_OCR || (process.platform === 'win32' ? 'windows' : 'tesseract');
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', REVIEW_MODEL: model || process.env.REVIEW_MODEL || 'qwen3.8-omni-flash' };
  const preflight = spawnSync(python, ['-c', 'import sys,shutil,numpy,PIL,filelock,requests; from identity import fingerprint; assert sys.version_info >= (3,11) and all(shutil.which(x) for x in (sys.argv[2],"ffmpeg","ffprobe")); print(fingerprint(sys.argv[1]))', mode, backend === 'windows' ? 'powershell' : 'tesseract'], { cwd:path.dirname(fileURLToPath(import.meta.url)), env, encoding:'utf8', windowsHide:true });
  if (preflight.status !== 0) throw new Error('请检查 Python 3.11+、审核依赖、OCR 和 FFmpeg。');
  const state = path.resolve(stateDir || '.work/frozen-review-state');
  return {
    fingerprint: preflight.stdout.trim(),
    video({ video, brief }) {
      return new Promise((resolve, reject) => {
        const proc = spawn(python, ['-X', 'utf8', script], {
          windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
        });
        let output = '';
        let diagnostic = '';
        proc.stderr.setEncoding('utf8').on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
        proc.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
        proc.on('error', reject);
        proc.stdin.on('error', reject);
        proc.on('close', code => {
          if (code !== 0) {
            const error = new Error('审核执行失败');
            const stage = [...diagnostic.matchAll(/in (\w+)\s*$/gm)].at(-1)?.[1];
            const type = [...diagnostic.matchAll(/^(\w+(?:Error|Exception)):/gm)].at(-1)?.[1];
            const status = diagnostic.match(/\b([45]\d\d) (?:Client|Server) Error|HTTP ([45]\d\d)/);
            error.auditDiagnostic = { stage:stage || mode, type:type || 'ProcessError', exit_code:code, http_status:status?.[1] || status?.[2] || null };
            return reject(error);
          }
          try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
        });
        proc.stdin.end(JSON.stringify({ video: path.resolve(video), brief, state }));
      });
    },
  };
}
