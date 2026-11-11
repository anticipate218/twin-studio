// Browser-only transport. No request is sent to a private backend.
export function createDemoClient(seed, options = {}) {
  const base = options.assetBase || new URL('./', import.meta.url).href;
  const asset = path => new URL(path, base).href;
  const createURL = options.createObjectURL || (blob => URL.createObjectURL(blob));
  const revokeURL = options.revokeObjectURL || (url => URL.revokeObjectURL(url));
  const exports = [];
  const limits = { image_ext: ['.jpg','.jpeg','.png','.webp'], dsm_ext: ['.tif','.tiff'], max_mb: 500, width_m: [5,5000] };
  const unavailable = '在线体验站不运行服务器任务。请下载并部署完整版，启用影像/DSM处理和GPU材质生成。';
  const materials = () => seed.materials.map(m => ({
    id: m.id, kind: 'demo', score: null, material: m.title,
    address: '程序绘制的演示纹理 · 非AI生成、非实景证据',
    texture: asset(m.file), thumb: asset(m.file), images: 1,
  }));
  async function getJSON(url) {
    const path = new URL(url, 'https://demo.invalid').pathname;
    if (path === '/api/health') return { ok: true, mode: 'browser-demo' };
    if (path === '/api/models') return { models: [{
      ...seed.model, file: 'demo_city.splat', stem: 'demo_city', group: 'Demo', origin: 'demo',
      registered: true, valid: true, url: asset('models/demo_city.splat'),
      preview: asset('previews/demo_city.png'), buildings: '/api/buildings/demo_city',
    }] };
    if (path === '/api/buildings/demo_city') return {
      ...structuredClone(seed.buildings), evidence_api: asset('evidence'),
    };
    if (path === '/api/runs') return { runs: materials() };
    if (path.startsWith('/api/runs/')) {
      const item = materials().find(m => m.id === decodeURIComponent(path.slice('/api/runs/'.length)));
      if (!item) throw new Error('没有找到这份演示材质');
      return { ...item, images: { texture: item.texture }, critique: {}, clean: {},
        vision: { material: item.material }, prompt: '此示例纹理由程序绘制，用于预览和建模，不包含模型生成或质量评分。',
        candidates: materials().map(m => ({ name: m.material, url: m.texture })), pois: [],
      };
    }
    if (path === '/api/exports') return { exports: exports.map(e => ({ ...e })) };
    if (path === '/api/memory') return { index: { buildings: [] }, buildings: {}, failure_counts: {} };
    if (path === '/api/recon/jobs') return { ok: true, jobs: [], limits };
    if (path === '/api/system') return {
      mode: 'browser-demo', python: '不需要后端', gpu: [], paths: {},
      studio: { version: '在线体验', root: '浏览器当前会话' },
      legacy: { up: false }, remote: { up: false },
      recon: { mode: 'local', setting: 'demo', local: { available: false, reason: unavailable, limits } },
      agent: { can_generate: false, reason: unavailable, keys: {} },
    };
    throw new Error('该功能需要部署完整版后使用');
  }
  async function saveExport(name, blob) {
    if (!/^[A-Za-z0-9_.-]+[.]glb$/.test(name) || !(blob instanceof Blob)) throw new Error('无效的GLB导出');
    const magic = new Uint8Array(await blob.slice(0,4).arrayBuffer());
    if (String.fromCharCode(...magic) !== 'glTF') throw new Error('导出内容不是GLB模型');
    if (exports.length >= 10) revokeURL(exports.pop().url);
    exports.unshift({ name, size: blob.size, url: createURL(blob), scope: 'browser-session' });
    return { name, scope: 'browser-session' };
  }
  const deny = async () => { throw new Error(unavailable); };
  const api = {
    health: () => getJSON('/api/health'), system: () => getJSON('/api/system'), models: () => getJSON('/api/models'),
    buildings: stem => getJSON('/api/buildings/'+encodeURIComponent(stem)),
    runs: () => getJSON('/api/runs'), run: id => getJSON('/api/runs/'+encodeURIComponent(id)),
    memory: () => getJSON('/api/memory'), exports: () => getJSON('/api/exports'), saveExport,
    reconJobs: () => getJSON('/api/recon/jobs'), reconUpload: deny, reconUploadXHR: deny,
    reconStart: deny, reconCancel: deny, reconJob: deny, agentRun: deny, agentJob: deny,
  };
  return { api, getJSON, postJSON: deny, postBinary: deny, uploadXHR: deny };
}

let clientPromise;
function client() {
  if (!clientPromise) clientPromise = fetch(new URL('./demo.json', import.meta.url))
    .then(r => { if (!r.ok) throw new Error('演示资源加载失败，请刷新重试'); return r.json(); })
    .then(seed => createDemoClient(seed)).catch(error => { clientPromise = null; throw error; });
  return clientPromise;
}
export const getJSON = async (...args) => (await client()).getJSON(...args);
export const postJSON = async (...args) => (await client()).postJSON(...args);
export const postBinary = async (...args) => (await client()).postBinary(...args);
export const uploadXHR = async (...args) => (await client()).uploadXHR(...args);
const methods = ['health','system','models','buildings','runs','run','memory','exports','saveExport','reconJobs','reconUpload','reconUploadXHR','reconStart','reconCancel','reconJob','agentRun','agentJob'];
export const api = Object.fromEntries(methods.map(name => [name, async (...args) => (await client()).api[name](...args)]));
