import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise production view methods with controllable I/O, without a server or GPU.
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));
function element(value = '') {
  const classes = new Set(['active']);
  const listeners = new Map();
  return { value, innerHTML: '', textContent: '', disabled: false, dataset: {}, style: {},
    classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle(c, on) { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); } },
    listeners, addEventListener: (event, fn) => listeners.set(event, fn), setAttribute() {}, dispatchEvent() {}, focus() {}, scrollIntoView() {}, querySelectorAll: () => [],
  };
}
async function harness(module, deps = {}) {
  const elements = new Map();
  const root = element();
  root.querySelector = (s) => { if (!elements.has(s)) elements.set(s, element()); return elements.get(s); };
  const timers = new Map(); let timerId = 0;
  const loads = [];
  const context = vm.createContext({ console, Blob, URL, Number, Set, Map, Promise, Event, CustomEvent,
    $: (s) => root.querySelector(s), $$: () => [], esc: (s) => String(s ?? '').replace(/"/g, '&quot;'),
    fmtScore: (s) => Number.isFinite(s) ? s.toFixed(1) : '—', scoreClass: () => 'good',
    toast() {}, fmtBytes: String, fmtNum: String, stamp: () => 'test',
    localStorage: { getItem: () => null },
    window: { addEventListener() {}, dispatchEvent() {} }, document: { hidden: false, addEventListener() {} },
    location: { hash: '#/material' }, history: { replaceState() {} },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
    THREE: { TextureLoader: class { load(url, ok, progress, fail) { loads.push({ url, ok, fail }); } } },
    facadeMaterial: (map, opts) => ({ map, ...opts }), api: {}, ...deps,
  });
  const source = (await readFile(new URL('../static/js/' + module + '.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace('export class ', 'globalThis.View = class ')
    .replace("await import('three/addons/exporters/GLTFExporter.js')", 'await globalThis.loadExporter()');
  vm.runInContext(source, context, { filename: module + '.js' });
  return { view: new context.View(root), context, root, elements, timers, loads };
}

test('material detail: a slower previous request cannot replace the current selection', async () => {
  const a = deferred(), b = deferred();
  const { view } = await harness('material', { api: { run: (id) => id === 'a' ? a.promise : b.promise } });
  view._renderList = () => {}; view._renderDetail = (d) => { view.rendered = d.id; }; view._setTexture = () => {};
  const first = view.open('a'), second = view.open('b');
  b.resolve({ id: 'b' }); await second; a.resolve({ id: 'a' }); await first;
  assert.equal(view.rendered, 'b'); assert.equal(view.detail.id, 'b');
});

function vector() { return { set(...values) { this.values = values; } }; }
class Group {
  constructor() { this.children = []; this.rotation = {}; this.userData = {}; }
  add(...children) { this.children.push(...children); }
  remove(child) { this.children = this.children.filter((c) => c !== child); }
  traverse(fn) { fn(this); this.children.forEach((c) => c.traverse(fn)); }
  clone() { return new Group(); }
  updateMatrixWorld() {}
}
class Mesh extends Group {
  constructor(geometry, material) { super(); Object.assign(this, { geometry, material, isMesh: true }); }
}
class Material {
  constructor(opts) { Object.assign(this, opts); }
  dispose() { this.disposed = true; }
}
const building = (id) => ({ id, ring: [[0, 0], [12, 0], [12, 9], [0, 9]], base: 0, top: 30, floors: 10, height_m: 30, area_m2: 108 });
async function modelingHarness(deps = {}) {
  const result = await harness('modeling', {
    THREE: { Group, Mesh, MeshStandardMaterial: Material }, mulberry32: () => () => 0.5,
    facadeMaterial: (map, props) => new Material({ map, ...props }),
    buildingGeometry: (ring, base, top, tile) => ({ walls: { tile, dispose() {} }, roof: { dispose() {} } }), ...deps,
  });
  const { view, root } = result;
  const params = { 'p-rows': 4, 'p-cols': 5, 'p-minh': 9, 'p-maxh': 72, 'p-block': 34, 'p-street': 14, 'p-seed': 0, 'p-floorh': 3.2, 'p-tile': 4, 'g-lat': 23, 'g-lon': 113, 'g-rounds': 3, 'g-seeds': 8, 'r-width': 220 };
  Object.entries(params).forEach(([id, value]) => { root.querySelector('#' + id).value = String(value); });
  view.g = { scene: new Group(), ground: { scale: vector(), position: vector() }, grid: { scale: vector(), position: vector() }, sun: { position: vector(), target: { position: vector() }, shadow: { camera: { updateProjectionMatrix() {} } } }, cam: { position: vector(), updateProjectionMatrix() {} }, ctl: { target: vector() } };
  view._applyNightWindows = () => {};
  return result;
}

test('builds snapshot all settings before I/O, and only the newest build can replace the city', async () => {
  const a = deferred(), b = deferred();
  const { view, root } = await modelingHarness();
  const inputs = [];
  view._footprints = (params) => { inputs.push(params); return inputs.length === 1 ? a.promise : b.promise; };
  view.selectedTex.add('/first');
  view.textures = [{ url: '/first', roughness: 0.31, metalness: 0.73 }];
  view._texture = async () => ({ image: {} });
  const first = view.build();
  root.querySelector('#p-tile').value = '6';
  const second = view.build();
  root.querySelector('#p-tile').value = '9';
  b.resolve({ label: 'new', list: [building(2)] }); await second;
  const currentCity = view.city;
  a.resolve({ label: 'old', list: [building(1)] }); await first;
  assert.equal(inputs[0].tile, 4); assert.equal(inputs[1].tile, 6); assert.equal(inputs[0].seed, 0);
  assert.equal(view.city, currentCity); assert.equal(view.cityMeta.label, 'new'); assert.equal(view.cityMeta.tile, 6);
  const wall = currentCity.children[0].children[0];
  assert.equal(wall.geometry.tile, 6); assert.equal(wall.material.roughness, 0.31); assert.equal(wall.material.metalness, 0.73);
  assert.equal(root.querySelector('#p-build').disabled, false);
});

test('invalid seed and inverted heights fail before loading and preserve the last successful city', async () => {
  const { view, root } = await modelingHarness();
  const previous = view.city = new Group(); let called = false;
  view._footprints = async () => { called = true; return { list: [] }; };
  root.querySelector('#p-seed').value = '';
  await view.build(); assert.equal(called, false); assert.equal(view.city, previous); assert.match(root.querySelector('#p-summary').textContent, /布局种子/);
  root.querySelector('#p-seed').value = '1'; root.querySelector('#p-minh').value = '60'; root.querySelector('#p-maxh').value = '10';
  await view.build(); assert.equal(called, false); assert.match(root.querySelector('#p-summary').textContent, /最低高度不能大于最高高度/);
});

test('empty building sources never replace the city or produce infinite camera bounds', async () => {
  const { view, root } = await modelingHarness(); const previous = view.city = new Group();
  view._footprints = async () => ({ label: 'empty', list: [] });
  await view.build(); assert.equal(view.city, previous); assert.equal(view.g.cam.position.values, undefined);
  assert.match(root.querySelector('#p-summary').textContent, /没有可用的建筑轮廓/);
});

test('agent double-click during the dependency check submits exactly one real job', async () => {
  const check = deferred(); let submissions = 0;
  const { view } = await modelingHarness({ api: { system: () => check.promise, agentRun: async () => { submissions++; return { job_id: 'agent1' }; }, agentJob: async () => ({ status: 'running' }) } });
  const first = view.runAgent(), second = view.runAgent();
  check.resolve({ agent: { can_generate: true } }); await Promise.all([first, second]); await flush();
  assert.equal(submissions, 1); assert.equal(view.agent.phase, 'running');
});

test('agent polling recovers from connection failure and reports completion', async () => {
  let queries = 0;
  const { view, root, timers } = await modelingHarness({ api: { agentJob: async () => { if (++queries === 1) throw new Error('offline'); return { status: 'done', run_id: 'run1', log_tail: ['complete'] }; } } });
  view._loadTextures = async () => {};
  Object.assign(view.agent, { phase: 'running', id: 'agent1' });
  view._pollAgent(); await flush(); assert.equal(timers.size, 1); assert.equal(view.agent.phase, 'running');
  const [id, tick] = timers.entries().next().value; timers.delete(id); await tick();
  assert.equal(view.agent.phase, 'done'); assert.equal(root.querySelector('#g-run').disabled, false);
  assert.match(root.querySelector('#g-progress').innerHTML, /#\/material\/run1/);
});

test('reconstruction local progress 1 means one percent, not completion', async () => {
  const { view } = await harness('modeling', { api: { reconJob: async () => ({ status: 'running', mode: 'local', progress: 1 }) } });
  view.recon = { phase: 'idle', mode: 'local' }; let progress;
  view._syncReconButtons = view._say = view._renderSteps = () => {};
  view._setProgress = (p) => { progress = p; };
  view._pollRecon('one'); await flush(); assert.equal(progress, 10.9);
});

test('a polling rejection arriving after navigation cannot restart polling', async () => {
  const response = deferred(); const { view, timers } = await harness('modeling', { api: { reconJob: () => response.promise } });
  view.recon = { phase: 'idle' }; view._syncReconButtons = view._say = () => {};
  view._pollRecon('old'); view.setActive(false); response.reject(new Error('offline')); await flush();
  assert.equal(timers.size, 0); assert.equal(view.recon.fails, 0);
});

test('GLB double-click downloads once; failed project save can retry the same binary', async () => {
  const conversion = deferred(); let downloads = 0, saves = 0; const blobs = [];
  const { view, root } = await modelingHarness({
    loadExporter: async () => ({ GLTFExporter: class { parseAsync() { return conversion.promise; } } }),
    downloadBlob: () => { downloads++; },
    api: { saveExport: async (_, blob) => { blobs.push(blob); if (++saves === 1) throw new Error('disk full'); return { name: 'saved.glb' }; } },
  });
  view.city = new Group(); view._loadExports = async () => {};
  const first = view.exportGLB(), second = view.exportGLB();
  conversion.resolve(new Uint8Array([1, 2, 3, 4]).buffer); await Promise.all([first, second]);
  assert.equal(downloads, 1); assert.equal(saves, 1); assert.match(root.querySelector('#p-export-status').innerHTML, /项目保存失败/);
  await view._saveLastExport();
  assert.equal(saves, 2); assert.equal(blobs[0], blobs[1]); assert.equal(downloads, 1);
  assert.match(root.querySelector('#p-export-status').innerHTML, /并保存到项目/);
});

test('encoded image URLs and measured seam_error are preserved in material details', async () => {
  const { view, root } = await harness('material');
  view._renderDetail({ id: 'one', score: 4, texture: '/agentfile/a%20b.png', critique: { seam_error: 48.3 }, candidates: [] });
  const html = root.querySelector('#run-detail').innerHTML;
  assert.match(html, /a%20b.png/); assert.doesNotMatch(html, /a%2520b/); assert.match(html, /48.3/);
});

async function reconHarness(api, dsm = false) {
  const result = await modelingHarness({ api });
  const { view } = result;
  view.system = { recon: { mode: 'local', local: { available: true } } };
  view.recon = { image: { file: { name: 'project.png', size: 100 }, error: '' }, dsm: dsm ? { file: { name: 'height.tif', size: 200 }, error: '' } : null, phase: 'idle' };
  view._renderSteps = view._say = view._clearLog = view._loadReconJobs = () => {};
  view.progress = [];
  view._setProgress = (pct, msg) => view.progress.push({ pct, msg });
  view._pollRecon = (id) => { view.tracked = id; view.recon.phase = 'running'; };
  return result;
}

test('real upload sequence sends image then DSM with its task id and never calls start twice', async () => {
  const calls = [];
  const { view } = await reconHarness({
    reconUploadXHR: async (file, kind, params, options) => {
      calls.push({ kind, params }); options.onProgress(file.size);
      return { id: 'uploaded', started: kind === 'dsm' };
    },
    reconStart: async () => { assert.fail('DSM upload already starts reconstruction'); },
  }, true);
  await view.submitRecon();
  assert.equal(calls.length, 2); assert.equal(calls[0].kind, 'image'); assert.equal(calls[1].kind, 'dsm');
  assert.equal(calls[1].params.id, 'uploaded'); assert.equal(view.tracked, 'uploaded');
  assert.match(view.progress.at(-1).msg, /等待服务器确认文件/);
});

test('image-only upload starts once and double-submit is ignored while uploading', async () => {
  const upload = deferred(); let uploads = 0, starts = 0;
  const { view } = await reconHarness({ reconUploadXHR: () => { uploads++; return upload.promise; }, reconStart: async ({ id }) => { starts++; return { id }; } });
  const first = view.submitRecon(); await view.submitRecon();
  upload.resolve({ id: 'image-only' }); await first;
  assert.equal(uploads, 1); assert.equal(starts, 1); assert.equal(view.tracked, 'image-only');
});

test('cancel during image upload prevents start even if the successful upload response arrives late', async () => {
  const upload = deferred(); let starts = 0, aborts = 0;
  const { view } = await reconHarness({
    reconUploadXHR: (_, __, ___, { handle }) => { handle.abort = () => { aborts++; }; return upload.promise; },
    reconStart: async () => { starts++; return {}; },
  });
  const request = view.submitRecon(); await view.cancelRecon(); upload.resolve({ id: 'received' }); await request;
  assert.equal(starts, 0); assert.equal(aborts, 1); assert.equal(view.recon.phase, 'cancelled');
});

test('DSM abort reconciles a task already started on the server before claiming cancellation', async () => {
  const dsm = deferred(); let cancellations = 0;
  const { view } = await reconHarness({
    reconUploadXHR: (_, kind, __, { handle }) => {
      if (kind === 'image') return Promise.resolve({ id: 'received' });
      handle.abort = () => { const error = new Error('upload aborted'); error.aborted = true; dsm.reject(error); };
      return dsm.promise;
    },
    reconJob: async () => ({ id: 'received', status: 'running' }),
    reconCancel: async () => { cancellations++; return { ok: true }; },
  }, true);
  const request = view.submitRecon(); await flush(); await view.cancelRecon(); await request;
  assert.equal(cancellations, 1); assert.equal(view.tracked, 'received');
});

test('file signature validation rejects a renamed image and accepts an actual PNG header', async () => {
  const { view } = await reconHarness({});
  const file = (bytes, name) => Object.assign(new Blob([new Uint8Array(bytes)]), { name });
  const wrong = await view._checkReconFile('image', file([0xff, 0xd8, 0xff, 0], 'renamed.png'));
  assert.match(wrong.error, /文件内容与扩展名不符/);
  const valid = await view._checkReconFile('image', file([0x89, 80, 78, 71, 13, 10, 26, 10], 'actual.png'));
  assert.equal(valid.error, ''); assert.equal(valid.family, 'png'); URL.revokeObjectURL(valid.url);
});

test('flat or explicitly empty reconstruction results do not offer unusable building contours', async () => {
  const { view, root } = await harness('modeling');
  const result = { id: 'flat', mode: 'local', flat: true, buildings_url: '/api/buildings/flat', counts: { surface: 222200, buildings: 0 } };
  view._renderResult(result);
  assert.doesNotMatch(root.querySelector('#r-result').innerHTML, /data-act="proc"/);
  assert.match(root.querySelector('#r-result').innerHTML, /地表/);
  assert.match(root.querySelector('#r-result').innerHTML, /DSM/);
  view._renderResult({ ...result, flat: false });
  assert.doesNotMatch(root.querySelector('#r-result').innerHTML, /data-act="proc"/);
  view._renderResult({ ...result, flat: false, counts: { buildings: 3 } });
  assert.match(root.querySelector('#r-result').innerHTML, /data-act="proc"/);
});

test('history also omits contour modeling for flat and zero-building jobs', async () => {
  const { view, root } = await harness('modeling', { api: { reconJobs: async () => ({ jobs: [
    { id: 'flat', status: 'done', flat: true, buildings_url: '/api/buildings/flat' },
    { id: 'zero', status: 'done', flat: false, counts: { buildings: 0 }, buildings_url: '/api/buildings/zero' },
  ] }) } });
  view.recon = { phase: 'idle' };
  await view._loadReconJobs();
  assert.doesNotMatch(root.querySelector('#r-jobs').innerHTML, /data-act="proc"/);
  assert.match(root.querySelector('#r-jobs').innerHTML, /DSM/);
});

test('navigation during first load awaits the same initialization without starting another renderer', async () => {
  for (const name of ['material', 'modeling']) {
    const pending = deferred(); const { view } = await harness(name); let renderers = 0;
    view._setup3D = () => { renderers++; };
    if (name === 'material') view._loadRuns = () => pending.promise;
    else {
      view._bindForm = () => {};
      view._loadTextures = () => pending.promise;
      view._loadBuildingSources = view._loadSystem = view._loadExports = view._loadReconJobs = view.build = async () => {};
    }
    const first = view.init(), second = view.init();
    let resolved = false; second.then(() => { resolved = true; }); await flush();
    assert.equal(resolved, false); assert.equal(renderers, 1);
    pending.resolve(); await Promise.all([first, second]); assert.equal(resolved, true);
  }
});

test('material texture: out-of-order loads dispose stale textures and keep the latest one', async () => {
  const { view, loads } = await harness('material');
  view.m3 = { r: { capabilities: { getMaxAnisotropy: () => 8 } }, mat: {} };
  view._setTexture('/a'); view._setTexture('/b');
  const texture = () => ({ image: { width: 512, height: 512 }, dispose() { this.disposed = true; } });
  const a = texture(), b = texture(); loads[1].ok(b); loads[0].ok(a);
  assert.equal(view.m3.texUrl, '/b'); assert.equal(a.disposed, true); assert.notEqual(b.disposed, true);
});

test('material without texture clears the previous run and disables apply', async () => {
  const { view, root } = await harness('material', { api: { run: async () => ({ id: 'empty' }) } });
  view.m3 = { texUrl: '/old', tex: { dispose() {} }, mat: {} };
  view._renderList = () => {}; view._renderDetail = () => {};
  await view.open('empty');
  assert.equal(view.m3.texUrl, null); assert.equal(root.querySelector('#m-use').disabled, true);
});

test('failed modeling textures can be retried instead of caching null forever', async () => {
  const { view, loads } = await harness('modeling');
  const first = view._texture('/broken'); loads[0].fail(); await first;
  const second = view._texture('/broken');
  assert.equal(loads.length, 2); loads[1].fail(); await second;
});

test('saved candidate material remains usable even when absent from the final-texture list', async () => {
  const saved = { url: '/candidate', run: 'run1', tile: 6, roughness: 0.3, metalness: 0.7 };
  const { view, root } = await harness('modeling', { api: { runs: async () => ({ runs: [] }) }, localStorage: { getItem: () => JSON.stringify(saved) } });
  await view._loadTextures();
  assert.equal(view.selectedTex.has('/candidate'), true);
  assert.equal(Number(root.querySelector('#p-tile').value), 6);
  assert.equal(view.textures.find((t) => t.url === '/candidate').roughness, 0.3);
});

test('file validation: selecting a second file wins even if the first completes later', async () => {
  const a = deferred(), b = deferred(); const { view } = await harness('modeling');
  view.recon = { image: null, phase: 'idle' };
  view._checkReconFile = (_, f) => f.name === 'a' ? a.promise : b.promise;
  view._renderReconFile = view._renderReconMode = () => {};
  const first = view._setReconFile('image', { name: 'a' }), second = view._setReconFile('image', { name: 'b' });
  b.resolve({ url: '', error: '' }); await second; a.resolve({ url: '', error: '' }); await first;
  assert.equal(view.recon.image.file.name, 'b');
});

test('agent initial entry stays enabled, and missing weights are reported only on click', async () => {
  const { view, root } = await harness('modeling', { api: { system: async () => ({ agent: { can_generate: false, reason: 'missing weights' } }) } });
  view._renderReconStatus = () => {};
  await view._loadSystem();
  assert.equal(root.querySelector('#g-run').disabled, false);
  assert.doesNotMatch(root.querySelector('#agent-status').innerHTML, /missing weights/);
  assert.equal(await view._checkAgent(), false);
  assert.match(root.querySelector('#agent-status').innerHTML, /missing weights/);
});

test('hidden modeling view ignores pending polling responses and resumes once on return', async () => {
  const pending = deferred(); let calls = 0;
  const { view, timers } = await harness('modeling', { api: { reconJob: () => { calls++; return pending.promise; } } });
  view.recon = { phase: 'idle', timer: 0 };
  view._syncReconButtons = view._say = view._renderSteps = view._setProgress = () => {};
  view._pollRecon('one');
  view.setActive(false); pending.resolve({ status: 'running', progress: 30 }); await flush();
  assert.equal(timers.size, 0);
  view.setActive(true); view.setActive(true); await flush();
  assert.equal(calls, 2); assert.equal(timers.size, 1);
});
