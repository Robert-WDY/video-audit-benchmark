// AI Centre 视频生成客户端（只用到提交、轮询、下载）。
// 密钥只从环境变量 AICENTRE_API_KEY 读取，不写入任何文件或日志。
import { writeFile } from 'node:fs/promises';

function base() {
  const b = process.env.AICENTRE_BASE_URL;
  if (!b) throw new Error('需要环境变量 AICENTRE_BASE_URL（AI Centre 服务地址）');
  return b.replace(/\/+$/, '');
}

function key() {
  const k = process.env.AICENTRE_API_KEY;
  if (!k) throw new Error('需要环境变量 AICENTRE_API_KEY');
  return k;
}

async function call(method, path, body) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data).slice(0, 400)}`);
  return data;
}

// 两条路由：自建 H3 池（支持 seed，适合做最小差异对照）与通用路由（libtv 等型号）
export const ROUTES = {
  h3: {
    submit: (req) => call('POST', '/v1/video-generations/minimax-h3/jobs', req),
    get: (id) => call('GET', `/v1/video-generations/minimax-h3/jobs/${id}`),
    url: (job) => job.result_url || job.result_urls?.[0],
  },
  generic: {
    submit: (req) => call('POST', '/v1/video-generations/jobs', req),
    get: (id) => call('GET', `/v1/video-generations/jobs/${id}`),
    url: (job) => job.result_urls?.[0] || job.result_url,
  },
};

export async function submit(route, req, idempotencyKey) {
  return ROUTES[route].submit({ ...req, ...(idempotencyKey ? { external_ref: idempotencyKey } : {}) });
}

export async function waitFor(route, id, { intervalMs = 15000, timeoutMs = 30 * 60000, onTick } = {}) {
  const t0 = Date.now();
  for (;;) {
    const job = await ROUTES[route].get(id);
    onTick?.(job);
    if (job.status === 'succeeded') return job;
    if (['failed', 'cancelled', 'error'].includes(job.status)) throw new Error(`任务 ${id} ${job.status}: ${JSON.stringify(job.error || job.stage || '').slice(0, 300)}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`任务 ${id} 超时`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

export const usage = () => call('GET', '/v1/usage?window=5h');
