// Twin Studio application shell: routing, status chips, lazy view initialisation.
import { SceneView } from './scene.js';
import { MaterialView } from './material.js';
import { ModelingView } from './modeling.js';
import { SystemView } from './system.js';
import { api } from './api.js';
import { $, $$ } from './ui.js';

const views = {};
// Promise of the scene view's first init(); later routes wait on it so an
// early hashchange never calls open() before the model list has arrived.
let sceneReady = null;
let current = null;
// Full hash of the last route handled. Comparing only the view name made
// in-view navigation (#/scene/a.splat -> #/scene/b.splat, or a different
// material run) a no-op, so the first loaded model stuck forever.
let currentKey = null;
let routeToken = 0;
let statusPending = false;
const pageNames = { scene: '场景渲染', material: '材质工坊', modeling: '程序化建模', system: '系统总览' };

function setChip(id, state, text, title) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('ok', 'bad', 'warn');
  if (state) el.classList.add(state);
  el.querySelector('span').textContent = text;
  if (title) el.title = title;
}

async function refreshStatus() {
  if (statusPending || document.hidden) return;
  statusPending = true;
  try {
    await api.health();
    setChip('#chip-service', 'ok', '工作台已连接', '工作台服务正常 · 点击查看系统总览');
    const s = await api.system();
    const g = s.gpu?.[0];
    setChip('#chip-gpu', g ? 'ok' : 'warn', g ? 'GPU 已就绪' : '未检测到 GPU', g ? `${g.name} · ${g.memory_total}` : '计算设备信息见系统总览');
  } catch (e) {
    setChip('#chip-service', 'warn', '连接待检查', e.message);
    setChip('#chip-gpu', '', '状态待更新', '设备状态暂未更新');
  } finally { statusPending = false; }
}

function tickClock() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString('zh-CN', { hour12: false });
}

function hashArg(parts) {
  if (!parts[1]) return '';
  try {
    return decodeURIComponent(parts[1]).trim();
  } catch {
    return parts[1].trim();
  }
}

function syncActiveViews() {
  for (const [name, view] of Object.entries(views)) view.setActive?.(name === current && !document.hidden);
}

async function route() {
  const key = location.hash;
  const parts = key.replace(/^#\/?/, '').split('/');
  const name = ['scene', 'material', 'modeling', 'system'].includes(parts[0]) ? parts[0] : 'scene';
  if (currentKey === key && name !== 'system') return;
  const token = ++routeToken;
  currentKey = key;
  current = name;
  document.title = `${pageNames[name]} · Twin Studio`;
  $('#route-feedback').classList.add('hidden');
  $$('#main-tabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === name);
    if (t.dataset.view === name) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  $$('#views .view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  syncActiveViews();
  const arg = hashArg(parts);
  try {
    if (name === 'scene') {
      if (!views.scene) {
        views.scene = new SceneView();
        // init() reads the model from location.hash itself.
        sceneReady = views.scene.init();
        await sceneReady;
      } else {
        await sceneReady;
        if (token !== routeToken) return;
        if (arg && arg !== views.scene.current) await views.scene.open(arg);
      }
    } else if (name === 'material') {
      if (!views.material) views.material = new MaterialView($('#view-material'));
      await views.material.init();
      if (token !== routeToken) return;
      if (arg && arg !== views.material.current && views.material.runs.length) await views.material.open(arg);
    } else if (name === 'modeling') {
      if (!views.modeling) views.modeling = new ModelingView($('#view-modeling'));
      await views.modeling.init();
      if (token !== routeToken) return;
      if (['proc', 'recon', 'agent'].includes(arg)) views.modeling._showTab(arg);
    } else if (name === 'system') {
      if (!views.system) views.system = new SystemView($('#view-system'));
      await views.system.init();
    }
    syncActiveViews();
  } catch (e) {
    if (token !== routeToken) return;
    console.error(e);
    currentKey = null;
    $('#route-feedback span').textContent = `页面暂时无法加载：${e.message}`;
    $('#route-feedback').classList.remove('hidden');
    syncActiveViews();
  }
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { syncActiveViews(); if (!document.hidden) refreshStatus(); });
$('#route-retry').addEventListener('click', () => location.reload());
document.querySelectorAll('.toolbar button[title]').forEach((b) => b.setAttribute('aria-label', b.title));
window.addEventListener('error', (e) => console.error('[twin]', e.message));
tickClock();
setInterval(tickClock, 1000);
refreshStatus();
setInterval(refreshStatus, 30000);
// The scene view is the landing page and owns the main WebGL context, so start it eagerly.
if (!location.hash) history.replaceState(null, '', '#/scene');
route();
