// Thin client for the Twin Studio backend (server.py).
async function handle(r) {
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      if (j && j.error) msg = j.error;
    } catch (_) { /* body was not JSON */ }
    throw new Error(msg);
  }
  try { return await r.json(); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('服务响应格式异常，请刷新后重试');
  }
}

export async function getJSON(url, { timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await handle(await fetch(url, { cache: 'no-store', signal: controller.signal }));
  } catch (e) {
    if (controller.signal.aborted) throw new Error('请求超时，请稍后重试');
    if (e instanceof TypeError) throw new Error('无法连接工作台服务，请检查连接后重试');
    throw e;
  } finally { clearTimeout(timer); }
}

export async function postJSON(url, body) {
  return handle(await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }));
}

export async function postBinary(url, data, contentType = 'application/octet-stream') {
  return handle(await fetch(url, { method: 'POST', headers: { 'Content-Type': contentType }, body: data }));
}

// XHR upload: real upload progress + abort (fetch exposes neither).
export function uploadXHR(url, file, { onProgress, handle } = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
    x.onload = () => {
      let j = null;
      try { j = JSON.parse(x.responseText); } catch (_) { /* not JSON */ }
      if (x.status >= 200 && x.status < 300 && j) resolve(j);
      else reject(new Error((j && j.error) || `${x.status} ${x.statusText || '上传失败'}`));
    };
    x.onerror = () => reject(new Error('连接被中断：服务未运行、文件被服务器拒绝或网络断开'));
    x.onabort = () => { const e = new Error('已取消上传'); e.aborted = true; reject(e); };
    if (handle) handle.abort = () => x.abort();
    x.send(file);
  });
}

export const api = {
  health: () => getJSON('/api/health'),
  system: () => getJSON('/api/system'),
  models: () => getJSON('/api/models'),
  buildings: (stem) => getJSON(`/api/buildings/${encodeURIComponent(stem)}`),
  runs: () => getJSON('/api/runs'),
  run: (id) => getJSON(`/api/runs/${encodeURIComponent(id)}`),
  memory: () => getJSON('/api/memory'),
  exports: () => getJSON('/api/exports'),
  saveExport: (name, blob) => postBinary(`/api/exports?name=${encodeURIComponent(name)}`, blob, 'model/gltf-binary'),
  reconUpload: (file, kind, params) => {
    const q = new URLSearchParams({ kind, name: file.name, ...params });
    return postBinary(`/api/recon/upload?${q}`, file, file.type || 'application/octet-stream');
  },
  reconUploadXHR: (file, kind, params, opts) => {
    const q = new URLSearchParams({ kind, name: file.name, ...params });
    return uploadXHR(`/api/recon/upload?${q}`, file, opts);
  },
  reconStart: (params) => postJSON('/api/recon/start', params),
  reconJobs: () => getJSON('/api/recon/jobs'),
  reconCancel: (id) => postJSON('/api/recon/cancel', { id }),
  reconJob: (id) => getJSON(`/api/recon/job/${encodeURIComponent(id)}`),
  agentRun: (params) => postJSON('/api/agent/run', params),
  agentJob: (id) => getJSON(`/api/agent/jobs/${encodeURIComponent(id)}`),
};
