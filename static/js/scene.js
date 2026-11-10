// Scene view: 3DGS model library + three.js viewport + inspector.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh } from './splat/SplatMesh.js';
import { GroundGrid, DustField, StarDome } from './fx.js';
import { BuildingLayer, layoutBuildingLabels } from './buildings.js';
import { api } from './api.js';
import { $, $$, esc, fmtBytes, fmtNum, toast, easeInOutCubic, downloadBlob, stamp } from './ui.js';

const AXES = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };

/** hover-v2: compass sector of an azimuth in degrees (0 = north, clockwise). */
function dir8(az) {
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const a = ((Number(az) % 360) + 360) % 360;
  return names[Math.round(a / 45) % 8];
}

export class SceneView {
  constructor() {
    this.models = [];
    this.filter = 'all';
    this.query = '';
    this.current = null;
    this.splat = null;
    this.loadToken = 0;
    this.openRequest = 0;
    this.pendingSplat = null;
    this.loadState = 'idle';
    this.abort = null;
    this.upMode = 'auto';
    this.up = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.forward = new THREE.Vector3(0, 1, 0);
    this.center = new THREE.Vector3();
    this.ground = new THREE.Vector3();
    this.radius = 50;
    this.height = 0;
    this.measureMode = false;
    this.measurePts = [];
    this.flight = null;
    this.frames = 0;
    this.fpsT = performance.now();
    this.clock = new THREE.Clock();
    this.buildingsData = null;
    this.active = true;
    this.raf = null;
    this.renderDirty = true;
    this.tagsDirty = true;
    this.hoverDirty = true;
    this.tagSizes = [];
    this.measureToken = 0;
    this.focusToken = 0;
    this.evidenceAbort = null;
    // hover-v2 state: picking runs at most once per animation frame from the latest pointer sample
    this.hover = {
      idx: -1, pending: null, last: null, ptr: null, down: null, lastPickAt: 0, camDirty: false, pinned: false, enterAt: 0,
      cardIdx: -1, cardSel: false, cardPinned: false, cardW: 264, cardH: 180, cardXY: '', hullKey: '',
      shownSvg: false, shownCard: false, hintText: '',
    };
    this.hoverEls = null;
    this.buildingsLoading = false;
  }

  async init() {
    this._setupRenderer();
    this._bindUI();
    this._animate();
    try {
      const res = await api.models();
      this.models = res.models || [];
    window.addEventListener('twin:models-changed', async () => {
      try { this.models = (await api.models()).models || this.models; this._renderList(); } catch (_) { /* ignore */ }
    });
      this._renderList();
      const fromHash = decodeURIComponent((location.hash.split('/')[2] || '').trim());
      const pick = this.models.find((m) => m.file === fromHash)
        || this.models.find((m) => m.file === 'dsm15.splat' && m.valid)
        || this.models.find((m) => m.valid);
      if (pick) this.open(pick.file);
    } catch (e) {
      $('#model-list').innerHTML = `<div class="notice bad">模型列表读取失败：${esc(e.message)}</div>`;
    }
  }

  /* ------------------------------------------------------------------ renderer */
  _setupRenderer() {
    const host = $('#viewport');
    this.host = host;
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x03050a, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'main';
    renderer.domElement.tabIndex = 0;
    host.prepend(renderer.domElement);
    for (const pos of [['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right']]) {
      const c = document.createElement('i');
      c.className = 'corner';
      c.style[pos[0]] = '8px';
      c.style[pos[1]] = '8px';
      c.style[`border-${pos[0] === 'top' ? 'bottom' : 'top'}`] = '0';
      c.style[`border-${pos[1] === 'left' ? 'right' : 'left'}`] = '0';
      host.appendChild(c);
    }
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -80, 60);
    this.stars = new StarDome();
    this.stars.visible = $('#c-stars').checked;
    this.grid = new GroundGrid();
    this.dust = new DustField();
    this.buildings = new BuildingLayer();
    this.measureGroup = new THREE.Group();
    this.scene.add(this.stars, this.grid, this.dust, this.buildings, this.measureGroup);
    this.grid.visible = false;
    this.dust.visible = false;
    this.raycaster = new THREE.Raycaster();
    this._setupHoverOverlay(host);
    this._makeControls();
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(host);
    this._resize();
  }

  _makeControls() {
    const target = this.controls ? this.controls.target.clone() : new THREE.Vector3();
    const autoRotate = this.controls ? this.controls.autoRotate : false;
    const speed = this.controls ? this.controls.autoRotateSpeed : 0.6;
    if (this.controls) this.controls.dispose();
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.screenSpacePanning = true;
    c.zoomSpeed = 1.1;
    c.rotateSpeed = 0.7;
    c.autoRotate = autoRotate;
    c.autoRotateSpeed = speed;
    c.target.copy(target);
    c.addEventListener('start', () => { this.flight = null; this.focusToken++; });
    c.addEventListener('change', () => {
      this.hover.camDirty = true;
      this.tagsDirty = this.hoverDirty = this.renderDirty = true;
    });
    this.controls = c;
  }

  _resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.tagsDirty = this.hoverDirty = this.renderDirty = true;
    this.tagSizes = [];
  }

  _animate() {
    if (this.raf !== null || !this.active || document.hidden) return;
    this.raf = requestAnimationFrame((now) => {
      this.raf = null;
      if (!this.active || document.hidden) return;
      const flying = !!this.flight;
      if (this.flight) this._stepFlight();
      const changed = this.controls.update();
      if (changed || flying) this.tagsDirty = this.hoverDirty = this.renderDirty = true;
      const animated = this.stars.visible || this.grid.visible || this.dust.visible || (this.buildings.visible && this.buildings.items.length > 0);
      // Keep effects animated at 30 fps when the camera is still. A static scene
      // with its effects disabled only redraws after an edit or a worker sort.
      const interval = changed || flying || this.controls.autoRotate ? 0 : 1000 / 30;
      if ((this.renderDirty || animated) && (this.lastRenderAt === undefined || now - this.lastRenderAt >= interval)) {
        const t = this.clock.getElapsedTime();
        if (this.stars.visible) this.stars.update(t, this.camera);
        if (this.grid.visible) this.grid.update(t);
        if (this.dust.visible) this.dust.update(t);
        if (this.buildings.visible) this.buildings.update(t);
        this.renderer.render(this.scene, this.camera);
        this.renderDirty = false;
        this.lastRenderAt = now;
        this.frames++;
      }
      this._updateHover();
      this._updateTags();
      if (now - this.fpsT > 800) {
        $('#stat-fps').textContent = this.frames ? `${Math.round((this.frames * 1000) / (now - this.fpsT))} fps` : '静止 · 按需渲染';
        if (this.splat) $('#stat-sort').textContent = `排序 ${this.splat.lastSortMs.toFixed(0)} ms`;
        this.frames = 0;
        this.fpsT = now;
      }
      this._animate();
    });
  }

  /* ------------------------------------------------------------------ model list */
  _groupOf(m) { return m.registered ? m.group : 'unregistered'; }

  _renderList() {
    const q = this.query.toLowerCase();
    const items = this.models.filter((m) => {
      if (this.filter !== 'all') {
        if (this.filter === 'unregistered' ? m.registered : (m.group !== this.filter || !m.registered)) return false;
      }
      if (!q) return true;
      return [m.title, m.file, m.desc, m.metrics_text].some((s) => String(s || '').toLowerCase().includes(q));
    });
    $('#model-count').textContent = `${items.length} / ${this.models.length}`;
    const list = $('#model-list');
    const focused = list.contains(document.activeElement) ? document.activeElement.closest('.mcard')?.dataset.file : null;
    if (!items.length) { list.innerHTML = `<p class="muted" role="status" style="padding:10px">${this.models.length ? '没有匹配的模型，请调整搜索词或分组。' : '模型库暂无模型。'}</p>`; return; }
    list.innerHTML = items.map((m) => {
      const b = [];
      b.push(`<span class="badge c">${esc(fmtNum(m.gaussians))} 高斯</span>`);
      if (Number.isFinite(m.metrics?.psnr)) b.push(`<span class="badge g">PSNR ${m.metrics.psnr.toFixed(2)}</span>`);
      if (m.buildings) b.push('<span class="badge a">建筑属性</span>');
      if (!m.registered) b.push('<span class="badge v">未登记</span>');
      if (!m.valid) b.push('<span class="badge r">长度异常</span>');
      const current = this.current === m.file;
      const loading = current && this.loadState === 'loading';
      const failed = current && this.loadState === 'error';
      if (loading) b.push('<span class="badge c">加载中…</span>');
      if (failed) b.push('<span class="badge r">加载失败 · 点击重试</span>');
      const thumb = m.preview ? `style="background-image:url('${esc(encodeURI(m.preview).replace(/'/g, '%27'))}')"` : '';
      return `<div class="mcard${current ? ' active' : ''}${failed ? ' error' : ''}" data-file="${esc(m.file)}" title="${esc(m.file)}" role="button" tabindex="0" aria-pressed="${current}" aria-busy="${loading}" aria-label="${esc(m.title || m.stem || m.file)}${loading ? '，加载中' : failed ? '，加载失败，可重试' : '，打开模型'}">
        <div class="thumb${m.preview ? '' : ' thumb-placeholder'}" ${thumb}>${m.preview ? '' : '<svg class="scene-model-placeholder" viewBox="0 0 64 64" width="40" height="40" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 50h48M13 50V27l16-8 16 8v23M29 19v31M45 50V34l9-5v21M8 27l21-11 21 11"/><path d="m18 30 6-3m-6 11 6-3m-6 11 6-3m11-16 5 3m-5 5 5 3m-5 5 5 3"/></g></svg>'}</div>
        <div class="meta"><div class="t">${esc(m.title || m.stem)}</div><div class="f">${esc(m.file)} · ${esc(fmtBytes(m.size))}</div><div class="badges">${b.join('')}</div></div>
      </div>`;
    }).join('');
    if (focused) Array.from(list.querySelectorAll('.mcard')).find((card) => card.dataset.file === focused)?.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ UI binding */
  _bindUI() {
    document.addEventListener('visibilitychange', () => this.setActive(this.active));
    $('#model-count').setAttribute('role', 'status');
    $('#loader').setAttribute('role', 'status');
    $('#measure-readout').setAttribute('role', 'status');
    $$('#toolbar .toggle').forEach((button) => button.setAttribute('aria-pressed', String(button.classList.contains('on'))));
    $$('#model-filters .fchip').forEach((button) => button.setAttribute('aria-pressed', String(button.classList.contains('active'))));
    $('#model-search').addEventListener('input', (e) => { this.query = e.target.value.trim(); this._renderList(); });
    $('#model-filters').addEventListener('click', (e) => {
      const btn = e.target.closest('.fchip');
      if (!btn) return;
      $$('#model-filters .fchip').forEach((b) => { b.classList.toggle('active', b === btn); b.setAttribute('aria-pressed', String(b === btn)); });
      this.filter = btn.dataset.group;
      this._renderList();
    });
    $('#model-list').addEventListener('click', (e) => {
      const card = e.target.closest('.mcard');
      if (card) this.open(card.dataset.file);
    });
    $('#model-list').addEventListener('keydown', (e) => {
      const card = e.target.closest('.mcard');
      if (!card || e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      e.stopPropagation();
      this.open(card.dataset.file);
    });
    $('#insp-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('#insp-tabs button').forEach((x) => x.classList.toggle('active', x === b));
      for (const id of ['model', 'render', 'bld']) $(`#insp-${id}`).classList.toggle('hidden', b.dataset.tab !== id);
    });
    $('#toolbar').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) this._action(b.dataset.act, b);
    });
    const bindRange = (id, label, fn, digits = 2) => {
      const el = $(id);
      el.addEventListener('input', () => { $(label).textContent = Number(el.value).toFixed(digits); fn(Number(el.value)); });
    };
    bindRange('#r-scale', '#v-scale', (v) => this._uniform('u_scaleMod', v));
    bindRange('#r-alpha', '#v-alpha', (v) => this._uniform('u_alphaMod', v));
    bindRange('#r-bright', '#v-bright', (v) => this._uniform('u_brightness', v));
    bindRange('#r-psize', '#v-psize', (v) => this._uniform('u_pointSize', v), 1);
    bindRange('#r-orbit', '#v-orbit', (v) => { this.controls.autoRotateSpeed = v; });
    $('#up-axis').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('#up-axis button').forEach((x) => x.classList.toggle('active', x === b));
      this.upMode = b.dataset.up;
      if (this.splat?.stats) {
        this._computeFrame(this.splat.stats); this._makeControls(); this._placeEffects(); this.resetView(false);
        const model = this.models.find((m) => m.file === this.current);
        if (model) this._renderModelInfo(model, this.modelResult);
      }
    });
    $('#c-grid').addEventListener('change', (e) => { this.grid.visible = e.target.checked && !!this.splat; this.renderDirty = true; });
    $('#c-dust').addEventListener('change', (e) => { this.dust.visible = e.target.checked && !!this.splat; this.renderDirty = true; });
    $('#c-stars').addEventListener('change', (e) => { this.stars.visible = e.target.checked; this.renderDirty = true; });

    const cv = this.renderer.domElement;
    let down = null;
    cv.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    cv.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved > 5 || e.button !== 0) return;
      this._click(e);
    });
    cv.addEventListener('pointermove', (e) => this._hover(e));
    cv.addEventListener('pointerleave', () => {
      const h = this.hover;
      h.pending = null;
      h.last = null;
      this.hoverDirty = true;
      if (!h.pinned) this._setHover(-1);
    });
    cv.addEventListener('pointerdown', (e) => { this.hover.down = [e.clientX, e.clientY]; });
    window.addEventListener('pointerup', () => {
      const h = this.hover;
      h.down = null;
      if (h.last) { h.last = { ...h.last, buttons: 0 }; h.pending = h.last; }
    });
    cv.addEventListener('pointercancel', () => { down = null; this.hover.down = this.hover.pending = this.hover.last = null; this._setHover(-1); });
    cv.addEventListener('dblclick', (e) => this._focusAt(e));
    window.addEventListener('keydown', (e) => {
      if (!this.active || document.hidden || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select, button, summary, a, [role="button"], [contenteditable="true"]')) return;
      const k = e.key.toLowerCase();
      const map = { r: 'reset', '1': 'top', '2': 'front', '3': 'oblique', p: 'points', c: 'crop', b: 'buildings', m: 'measure', f: 'full', ' ': 'orbit' };
      if (map[k]) {
        e.preventDefault();
        this._action(map[k], $(`#toolbar [data-act="${map[k]}"]`));
      } else if (k === '=' || k === '+') {
        const el = $('#r-psize'); el.value = Math.min(8, Number(el.value) + 0.5); el.dispatchEvent(new Event('input'));
      } else if (k === '-') {
        const el = $('#r-psize'); el.value = Math.max(0.5, Number(el.value) - 0.5); el.dispatchEvent(new Event('input'));
      } else if (k === 'escape' && this.measureMode) {
        this._action('measure', $('#toolbar [data-act="measure"]'));
      }
    });
  }

  _uniform(name, v) { if (this.splat) this.splat.material.uniforms[name].value = v; this.renderDirty = true; }

  _action(act, btn) {
    if (['reset', 'top', 'front', 'oblique', 'measure'].includes(act) && !this.splat && !(act === 'measure' && this.measureMode)) { toast('请先加载模型', 'info'); return; }
    const toggle = () => {
      if (!btn) return false;
      const on = btn.classList.toggle('on');
      btn.setAttribute('aria-pressed', String(on));
      return on;
    };
    switch (act) {
      case 'reset': this.resetView(); break;
      case 'top': this.viewPreset('top'); break;
      case 'front': this.viewPreset('front'); break;
      case 'oblique': this.viewPreset('oblique'); break;
      case 'orbit': this.controls.autoRotate = toggle(); break;
      case 'points': this._uniform('u_pointMode', toggle() ? 1 : 0); break;
      case 'crop': this.cropOn = toggle(); this._applyCrop(); break;
      case 'buildings':
        this.buildings.visible = toggle();
        $('#building-tags').classList.toggle('hidden', !this.buildings.visible);
        this.tagsDirty = this.hoverDirty = true;
        if (!this.buildings.visible) {
          this._setHover(-1);
          this._hideHoverOverlay();
          const status = $('#bld-label-status');
          if (status) status.textContent = '建筑叠加已关闭；仍可在下方列表选择建筑。';
        } else if (!this.buildings.items.length) toast(this.buildingsLoading ? '建筑属性正在加载' : '当前没有可显示的建筑属性', 'info');
        break;
      case 'measure':
        this.measureMode = toggle();
        this.renderer.domElement.style.cursor = this.measureMode ? 'crosshair' : '';
        if (!this.measureMode) this._clearMeasure();
        else { this._clearMeasure(); this._showMeasure('测距：在模型上依次点击两个点'); }
        break;
      case 'shot': this.screenshot(); break;
      case 'full':
        if (document.fullscreenElement) document.exitFullscreen();
        else this.host.requestFullscreen?.();
        break;
      default: break;
    }
    this.renderDirty = true;
    this.hoverDirty = true;
  }

  /* ------------------------------------------------------------------ loading */
  async open(file) {
    const request = ++this.openRequest;
    let m = this.models.find((x) => x.file === file);
    if (!m) {
      try {
        const data = await api.models();
        if (request !== this.openRequest) return;
        this.models = data.models || this.models;
        this._renderList();
      } catch (_) { /* keep cached list */ }
      if (request !== this.openRequest) return;
      m = this.models.find((x) => x.file === file);
    }
    if (!m) { toast(`找不到模型 ${file}`, 'err'); return; }
    if (this.abort) this.abort.abort();
    const token = ++this.loadToken;
    if (this.pendingSplat) { this.pendingSplat.dispose(); this.pendingSplat = null; }
    this.evidenceAbort?.abort();
    this.abort = new AbortController();
    this.current = file;
    this.loadState = 'loading';
    this.flight = null;
    this.upLabel = null;
    this._renderList();
    if (this.active && location.hash.startsWith('#/scene') && location.hash !== `#/scene/${encodeURIComponent(file)}`) history.replaceState(null, '', `#/scene/${encodeURIComponent(file)}`);
    $('#hud-title').textContent = m.title || m.stem;
    $('#hud-metrics').innerHTML = this._metricChips(m);
    this._renderModelInfo(m, null);
    $('#empty-state').classList.add('hidden');
    this._loader(true, 0, '连接中…');

    if (this.splat) { this.scene.remove(this.splat); this.splat.dispose(); this.splat = null; }
    this.buildings.dispose();
    this.buildingsData = null;
    this._setHover(-1);
    Object.assign(this.hover, { pinned: false, pending: null, cardIdx: -1, hullKey: '' });
    this._hideHoverOverlay();
    this.buildingsLoading = false;
    this._clearMeasure();
    this.grid.visible = false;
    this.dust.visible = false;
    this.renderDirty = true;
    this.tagSizes = [];
    $('#stat-splats').textContent = '加载中…';
    $('#stat-sort').textContent = '排序 —';
    $('#building-tags').innerHTML = '';
    $('#insp-bld').innerHTML = '<p class="muted">当前模型没有建筑属性数据。</p>';

    let splat;
    const t0 = performance.now();
    try {
      splat = new SplatMesh();
      this.pendingSplat = splat;
      splat.worker.addEventListener('message', (e) => {
        if (e.data.type === 'sorted' && this.splat === splat) this.renderDirty = true;
      });
      const res = await splat.load(m.url, (p) => {
        if (token !== this.loadToken) return;
        if (p.phase === 'download') {
          const pct = p.total ? p.loaded / p.total : 0;
          this._loader(true, pct * 0.9, `下载 ${fmtBytes(p.loaded)} / ${fmtBytes(p.total || m.size)}`);
        } else {
          this._loader(true, 0.93, `解析 ${fmtNum(p.loaded / 32)} 个高斯并上传 GPU…`);
        }
      }, this.abort.signal);
      if (token !== this.loadToken || !res) { splat.dispose(); return; }
      this.splat = splat;
      this.pendingSplat = null;
      this.scene.add(splat);
      const st = res.stats;
      this._applyUniformsFromUI();
      this._computeFrame(st);
      this._makeControls();
      this._placeEffects();
      this.cropOn = $('#toolbar [data-act="crop"]').classList.contains('on');
      this._applyCrop();
      this.resetView(false);
      $('#stat-splats').textContent = `${fmtNum(res.count)} 高斯`;
      this.modelResult = { ...res, ms: performance.now() - t0 };
      this._renderModelInfo(m, this.modelResult);
      this.loadState = 'ready';
      this._renderList();
      this._loader(false);
      this.renderDirty = true;
      if (this.measureMode) this._showMeasure('测距：在模型上依次点击两个点（模型坐标估算）');
      toast(`已加载 ${m.title || m.file}（${fmtNum(res.count)} 高斯，${((performance.now() - t0) / 1000).toFixed(1)} s）`, 'ok');
      if (m.buildings) this._loadBuildings(m);
    } catch (e) {
      splat?.dispose();
      if (e.name === 'AbortError' || token !== this.loadToken) return;
      if (this.splat === splat) { this.scene.remove(splat); this.splat = null; }
      this.loadState = 'error';
      this._renderList();
      this._loader(false);
      $('#empty-state').classList.remove('hidden');
      const message = $('#empty-state p');
      if (message) message.textContent = '模型加载失败，请重新选择该模型重试。';
      $('#stat-splats').textContent = '加载失败';
      toast(`加载失败：${e.message}`, 'err', 6000);
    } finally {
      if (this.pendingSplat === splat) this.pendingSplat = null;
    }
  }

  _applyUniformsFromUI() {
    this._uniform('u_scaleMod', Number($('#r-scale').value));
    this._uniform('u_alphaMod', Number($('#r-alpha').value));
    this._uniform('u_brightness', Number($('#r-bright').value));
    this._uniform('u_pointSize', Number($('#r-psize').value));
    this._uniform('u_pointMode', $('#toolbar [data-act="points"]').classList.contains('on') ? 1 : 0);
  }

  _loader(show, pct = 0, msg = '') {
    $('#loader').classList.toggle('hidden', !show);
    if (!show) return;
    $('#loader-pct').textContent = `${Math.round(pct * 100)}%`;
    $('#loader-msg').textContent = msg;
    $('#loader-ring').style.strokeDashoffset = String(327 * (1 - pct));
  }

  _metricChips(m) {
    const c = [];
    const mt = m.metrics || {};
    if (Number.isFinite(mt.psnr)) c.push(`<span class="badge g">PSNR ${mt.psnr.toFixed(2)}</span>`);
    if (Number.isFinite(mt.ssim)) c.push(`<span class="badge c">SSIM ${mt.ssim.toFixed(3)}</span>`);
    if (Number.isFinite(mt.lpips)) c.push(`<span class="badge v">LPIPS ${mt.lpips.toFixed(3)}</span>`);
    if (mt.extent) c.push(`<span class="badge">${esc(mt.extent)}</span>`);
    if (Number.isFinite(mt.buildings)) c.push(`<span class="badge a">${mt.buildings} 栋</span>`);
    return c.join('');
  }

  _renderModelInfo(m, res) {
    const mt = m.metrics || {};
    const metric = (v, label, cls, d) => Number.isFinite(v) ? `<div class="metric ${cls}"><b>${v.toFixed(d)}</b><span>${label}</span></div>` : '';
    const metrics = metric(mt.psnr, 'PSNR', 'g', 2) + metric(mt.ssim, 'SSIM', 'c', 3) + metric(mt.lpips, 'LPIPS', 'v', 3);
    const st = res?.stats;
    const ext = st ? st.p98.map((v, i) => (v - st.p2[i]).toFixed(1)).join(' × ') + ' m' : '—';
    $('#insp-model').innerHTML = `
      ${metrics ? `<div class="metric-grid">${metrics}</div>` : '<p class="muted small scene-metrics-empty">该成果未附渲染评测指标</p>'}
      ${m.desc ? `<div class="desc">${esc(m.desc)}</div>` : ''}
      <dl class="kv">
        <dt>文件</dt><dd class="mono">${esc(m.file)}</dd>
        <dt>大小</dt><dd>${esc(fmtBytes(m.size))}</dd>
        <dt>高斯数量</dt><dd>${esc(fmtNum(m.gaussians))}（${m.valid ? '长度可被 32 整除 ✓' : '长度异常 ✗'}）</dd>
        <dt>登记状态</dt><dd>${m.registered ? '已登记 models.json' : '磁盘存在，未登记'}</dd>
        <dt>指标原文</dt><dd>${esc(m.metrics_text || '—')}</dd>
        <dt>主体范围</dt><dd>${esc(ext)}（2%–98% 分位）</dd>
        <dt>朝上轴</dt><dd>${esc(this.upLabel || '—')}</dd>
        ${res ? `<dt>加载耗时</dt><dd>${(res.ms / 1000).toFixed(2)} s</dd>` : ''}
        ${st && st.invalid ? `<dt>无效记录</dt><dd>${st.invalid}</dd>` : ''}
      </dl>
      ${m.preview ? `<img src="${encodeURI(m.preview)}" alt="" style="width:100%;border-radius:10px;border:1px solid var(--line)">` : ''}`;
  }

  /* ------------------------------------------------------------------ framing */
  _computeFrame(st) {
    const ext = [0, 1, 2].map((i) => Math.max(1e-3, st.p98[i] - st.p2[i]));
    let axisKey = this.upMode;
    if (axisKey === 'auto') {
      const a = ext.indexOf(Math.min(...ext));
      const name = ['x', 'y', 'z'][a];
      const below = st.p50[a] - st.p2[a];
      const above = st.p98[a] - st.p50[a];
      axisKey = `${above >= below ? '+' : '-'}${name}`;
    }
    this.upLabel = axisKey.toUpperCase();
    this.up.fromArray(AXES[axisKey]);
    const ref = Math.abs(this.up.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    this.right.crossVectors(ref, this.up).normalize();
    this.forward.crossVectors(this.up, this.right).normalize();
    this.camera.up.copy(this.up);
    const c = new THREE.Vector3().fromArray(st.p50);
    const ai = Math.abs(this.up.x) > 0.5 ? 0 : Math.abs(this.up.y) > 0.5 ? 1 : 2;
    const sign = this.up.getComponent(ai) >= 0 ? 1 : -1;
    const groundVal = sign > 0 ? st.p5[ai] : st.p95[ai];
    this.center.copy(c);
    this.ground.copy(c).setComponent(ai, groundVal);
    const horiz = [0, 1, 2].filter((i) => i !== ai).map((i) => ext[i]);
    this.radius = Math.max(5, 0.5 * Math.max(...horiz));
    this.height = ext[ai];
    this.camera.near = Math.max(0.02, this.radius * 0.0015);
    this.camera.far = this.radius * 60;
    this.camera.updateProjectionMatrix();
  }

  _placeEffects() {
    this.grid.place(this.ground.clone().addScaledVector(this.up, -0.05 * Math.max(1, this.height * 0.02)), this.up, this.radius * 2.6);
    this.dust.place(this.ground, this.right, this.forward, this.up, this.radius * 1.3, Math.max(this.height * 1.6, this.radius * 0.35));
    this.grid.visible = $('#c-grid').checked;
    this.dust.visible = $('#c-dust').checked;
  }

  _applyCrop() {
    if (!this.splat?.stats) return;
    const st = this.splat.stats;
    const lo = [], hi = [];
    for (let i = 0; i < 3; i++) {
      const span = st.p99[i] - st.p1[i];
      lo.push(st.p1[i] - span * 0.12);
      hi.push(st.p99[i] + span * 0.12);
    }
    this.splat.setClipBox(lo, hi, !!this.cropOn);
  }

  _presetPose(kind) {
    const R = this.radius;
    const t = this.ground.clone().addScaledVector(this.up, Math.min(this.height * 0.25, R * 0.15));
    const p = t.clone();
    if (kind === 'top') p.addScaledVector(this.up, R * 2.3).addScaledVector(this.forward, -R * 0.02);
    else if (kind === 'front') p.addScaledVector(this.forward, -R * 2.0).addScaledVector(this.up, R * 0.28);
    else if (kind === 'street') p.addScaledVector(this.forward, -R * 0.9).addScaledVector(this.up, Math.max(1.7, this.height * 0.05));
    else p.addScaledVector(this.forward, -R * 1.25).addScaledVector(this.right, -R * 0.55).addScaledVector(this.up, R * 1.0);
    return { p, t };
  }

  resetView(animated = true) { this.viewPreset('oblique', animated); }

  viewPreset(kind, animated = true) {
    const { p, t } = this._presetPose(kind);
    this.flyTo(p, t, animated ? 900 : 0);
  }

  flyTo(pos, target, ms = 900) {
    this.focusToken++;
    this.controls.autoRotate = false;
    const orbit = $('#toolbar [data-act="orbit"]');
    orbit?.classList.remove('on');
    orbit?.setAttribute('aria-pressed', 'false');
    this.tagsDirty = this.hoverDirty = this.renderDirty = true;
    if (!ms) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.flight = null;
      return;
    }
    this.flight = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos.clone(), t1: target.clone(), start: performance.now(), ms };
  }

  _stepFlight() {
    const f = this.flight;
    const k = Math.min(1, (performance.now() - f.start) / f.ms);
    const e = easeInOutCubic(k);
    this.camera.position.lerpVectors(f.p0, f.p1, e);
    this.controls.target.lerpVectors(f.t0, f.t1, e);
    if (k >= 1) this.flight = null;
  }

  /* ------------------------------------------------------------------ picking */
  _ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  _pickBuilding(e) {
    if (!this.buildings.visible || !this.buildings.items.length) return -1;
    this.raycaster.setFromCamera(this._ndc(e), this.camera);
    const hit = this.raycaster.intersectObjects(this.buildings.pickables(), false)[0];
    return hit ? hit.object.userData.bIndex : -1;
  }

  /** hover-v2: pointermove only records the latest sample; _updateHover picks once per frame. */
  _hover(e) {
    if (e.pointerType === 'touch') return;
    const h = this.hover;
    if (!h.last) h.enterAt = performance.now();
    const ptr = this._localPtr(e);
    h.pending = ptr;
    h.last = ptr;
  }

  /* ------------------------------------------------------------------ hover-v2: frame + attribute card */
  _setupHoverOverlay(host) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'bld-hover-svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<defs><filter id="bld-hover-glow" x="-30%" y="-30%" width="160%" height="160%">'
      + '<feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>'
      + '<polygon class="hull-fill"/><polygon class="hull-line" filter="url(#bld-hover-glow)"/><polygon class="hull-dash"/><path class="hull-corners"/>';
    const card = document.createElement('div');
    card.className = 'bld-hover-card';
    card.setAttribute('role', 'tooltip');
    const hint = document.createElement('div');
    hint.className = 'bld-hover-hint';
    host.append(svg, card, hint);
    this.hoverEls = {
      svg, card, hint,
      fill: svg.querySelector('.hull-fill'),
      line: svg.querySelector('.hull-line'),
      dash: svg.querySelector('.hull-dash'),
      corners: svg.querySelector('.hull-corners'),
    };
  }

  _localPtr(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { clientX: e.clientX, clientY: e.clientY, x: e.clientX - r.left, y: e.clientY - r.top, buttons: e.buttons || 0, type: e.pointerType || 'mouse' };
  }

  _setHover(i, ptr = null) {
    const h = this.hover;
    if (ptr) h.ptr = ptr;
    const idx = Number.isInteger(i) && i >= 0 && i < this.buildings.items.length ? i : -1;
    if (idx === h.idx) return;
    h.idx = idx;
    if (idx < 0) h.pinned = false;
    this.buildings.setHovered(idx);
    this.tagsDirty = this.hoverDirty = this.renderDirty = true;
    this.renderer.domElement.style.cursor = idx >= 0 ? 'pointer' : (this.measureMode ? 'crosshair' : '');
  }

  _hideHoverOverlay() {
    const h = this.hover, els = this.hoverEls;
    if (!els) return;
    if (h.shownSvg) { els.svg.classList.remove('show'); h.shownSvg = false; h.hullKey = ''; }
    if (h.shownCard) { els.card.classList.remove('show'); h.shownCard = false; }
  }

  /** Called every animation frame after rendering: throttled picking, hint, frame and card placement. */
  _updateHover() {
    const h = this.hover, els = this.hoverEls;
    if (!els) return;
    if (!this.hoverDirty && !h.pending && !(h.camDirty && h.last) && !h.hintText) return;
    this.hoverDirty = false;
    if (h.pinned || !h.last) h.camDirty = false;
    const items = this.buildings.items;
    const usable = items.length > 0 && this.buildings.visible && !this.measureMode;

    if (!usable) {
      h.pinned = false;
      h.pending = null;
      if (h.idx >= 0) this._setHover(-1);
    } else if (!h.pinned) {
      const now = performance.now();
      let ptr = null;
      if (h.pending) { ptr = h.pending; h.pending = null; }
      else if (h.camDirty && h.last && now - h.lastPickAt > 90) ptr = h.last;
      if (ptr) {
        h.camDirty = false;
        h.lastPickAt = now;
        const dragging = ptr.buttons !== 0 && h.down && Math.hypot(ptr.clientX - h.down[0], ptr.clientY - h.down[1]) > 4;
        this._setHover(dragging ? -1 : this._pickBuilding(ptr), ptr);
      }
    }

    let hint = '';
    if (h.last && this.splat && !this.measureMode) {
      const fresh = performance.now() - h.enterAt < 4500;
      if (!items.length) {
        const meta = this.models.find((m) => m.file === this.current);
        if (this.buildingsLoading) hint = '建筑属性加载中…';
        else if (fresh) hint = meta && meta.buildings ? '建筑属性数据为空或读取失败，无法悬停拾取建筑' : '当前模型没有建筑属性数据（buildings.json），无法悬停拾取建筑';
      } else if (!this.buildings.visible && fresh) {
        hint = '建筑叠加已关闭，按 B 打开后可悬停查看建筑属性';
      }
    }
    if (hint !== h.hintText) {
      h.hintText = hint;
      if (hint) els.hint.textContent = hint;
      els.hint.classList.toggle('show', !!hint);
    }

    const i = h.idx;
    const it = i >= 0 ? items[i] : null;
    if (!it) { this._hideHoverOverlay(); return; }
    const w = this.host.clientWidth, hh = this.host.clientHeight;
    const s = this.buildings.screenHull(i, this.camera, w, hh);
    if (!s) { this._hideHoverOverlay(); return; }
    const sel = i === this.buildings.selected;
    if (h.cardIdx !== i || h.cardSel !== sel || h.cardPinned !== h.pinned) this._renderHoverCard(i);

    const f = (v) => v.toFixed(1);
    const pts = s.hull.map((p) => `${f(p[0])},${f(p[1])}`).join(' ');
    const key = `${pts}|${sel ? 1 : 0}`;
    if (key !== h.hullKey) {
      h.hullKey = key;
      for (const el of [els.fill, els.line, els.dash]) el.setAttribute('points', pts);
      const pad = 7;
      const x0 = s.minX - pad, y0 = s.minY - pad, x1 = s.maxX + pad, y1 = s.maxY + pad;
      const L = Math.max(6, Math.min(18, Math.min(x1 - x0, y1 - y0) * 0.22));
      els.corners.setAttribute('d',
        `M${f(x0)},${f(y0 + L)}V${f(y0)}H${f(x0 + L)}`
        + `M${f(x1 - L)},${f(y0)}H${f(x1)}V${f(y0 + L)}`
        + `M${f(x1)},${f(y1 - L)}V${f(y1)}H${f(x1 - L)}`
        + `M${f(x0 + L)},${f(y1)}H${f(x0)}V${f(y1 - L)}`);
      els.svg.classList.toggle('sel', sel);
    }
    if (!h.shownSvg) { els.svg.classList.add('show'); h.shownSvg = true; }

    // card: beside the frame (right, else left, else above/below); near the cursor when the frame fills the view
    const cw = h.cardW, ch = h.cardH, M = 10, GAP = 16, TOP = 8, BOTTOM = 76;
    const big = (s.maxX - s.minX) > w * 0.55 || (s.maxY - s.minY) > hh * 0.55;
    let x, y;
    if (big && h.ptr) {
      x = h.ptr.x + 18;
      y = h.ptr.y + 18;
      if (x + cw > w - M) x = h.ptr.x - 18 - cw;
      if (y + ch > hh - BOTTOM) y = h.ptr.y - 18 - ch;
    } else {
      x = s.maxX + GAP;
      y = s.minY;
      if (x + cw > w - M) x = s.minX - GAP - cw;
      if (x < M) {
        x = (s.minX + s.maxX) / 2 - cw / 2;
        y = s.minY - GAP - ch;
        if (y < TOP) y = s.maxY + GAP;
      }
    }
    x = Math.min(Math.max(x, M), Math.max(M, w - cw - M));
    y = Math.min(Math.max(y, TOP), Math.max(TOP, hh - ch - BOTTOM));
    const xy = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    if (xy !== h.cardXY) { h.cardXY = xy; els.card.style.transform = xy; }
    if (!h.shownCard) { els.card.classList.add('show'); h.shownCard = true; }
  }

  _renderHoverCard(i) {
    const h = this.hover, els = this.hoverEls;
    const items = this.buildings.items;
    const it = items[i];
    if (!els || !it) return;
    const b = it.data || {};
    const sel = i === this.buildings.selected;
    const fmt = (v, d = 1) => {
      if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
      const n = Number(v);
      return Number.isFinite(n) ? String(Number(n.toFixed(d))) : null;
    };
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const rows = [];
    const add = (k, v) => { if (v !== null && v !== undefined && String(v).trim() !== '') rows.push([k, String(v)]); };

    const name = [b.name, b.title, b.label].map(str).find(Boolean);
    const height = fmt(b.height_m, 2) ?? (fmt(b.top) !== null && fmt(b.base) !== null ? fmt(Number(b.top) - Number(b.base), 2) : null);
    add('用途 / 类型', [b.usage, b.use, b.function, b.type, b.category, b.landuse].map(str).find(Boolean));
    const per = fmt(b.perim_m, 1);
    add('周长', per !== null ? `${per} m` : null);
    const baseZ = fmt(b.base, 1), topZ = fmt(b.top, 1);
    add('地面 / 屋顶高程', baseZ !== null && topZ !== null ? `${baseZ} / ${topZ} m` : null);
    const fl = fmt(b.facade_len_m, 1), az = fmt(b.facade_azimuth, 1);
    add('主立面', [fl !== null ? `${fl} m` : null, az !== null ? `朝向 ${az}°（${dir8(Number(az))}）` : null].filter(Boolean).join(' · '));
    const nb = fmt(b.neighbors_50m, 0), nr = fmt(b.nearest_m, 1);
    add('相邻建筑', [nb !== null ? `${nb} 栋（50 m 内）` : null, nr !== null ? `最近 ${nr} m` : null].filter(Boolean).join('，'));
    add('窗行数', fmt(b.window_rows, 0));
    const mat = str(b.material);
    add('立面材质', mat ? `${mat}${str(b.color) ? ` · ${str(b.color)}` : ''}` : null);
    const poiRaw = b.pois ?? b.poi;
    const poiList = Array.isArray(poiRaw) ? poiRaw : (poiRaw ? [poiRaw] : []);
    const poiNames = poiList.map((p) => (typeof p === 'string' ? str(p) : p && (str(p.name) || str(p.title) || str(p.type)))).filter(Boolean);
    if (poiNames.length) add('POI', poiNames.length > 3 ? `${poiNames.slice(0, 3).join('、')} 等 ${poiNames.length} 个` : poiNames.join('、'));
    const lat = fmt(b.lat, 6), lon = fmt(b.lon, 6);
    add('经纬度', lat !== null && lon !== null ? `${lon}, ${lat}` : null);
    if (items.length > 1) {
      const mine = it.top - it.base;
      const rank = 1 + items.filter((x) => x.top - x.base > mine + 1e-6).length;
      add('高度排序', `第 ${rank} / ${items.length}`);
    }

    const kpi = (v, label) => `<div><b>${esc(v ?? '—')}</b><span>${esc(label)}</span></div>`;
    const src = str(b.source);
    const tip = h.pinned ? '轻触空白处关闭' : (sel ? '已选中 · 完整属性见右侧「建筑」面板' : '单击选中并飞到该建筑');
    els.card.innerHTML = `<div class="bhc-head"><i class="bhc-dot"></i><b>建筑 #${esc(b.id ?? i)}</b>`
      + `${name ? `<span class="bhc-name">${esc(name)}</span>` : ''}${sel ? '<span class="bhc-badge">已选中</span>' : ''}</div>`
      + `<div class="bhc-kpis">${kpi(height, '高度 m')}${kpi(fmt(b.floors, 0), b.floors_est ? '估算层数' : '层数')}${kpi(fmt(b.area_m2, 1), '占地 m²')}</div>`
      + (rows.length ? `<table class="bhc-tbl">${rows.map((r) => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join('')}</table>` : '')
      + `<div class="bhc-foot">${src ? `<div class="bhc-src">来源：${esc(src)}</div>` : ''}${esc(tip)}</div>`;
    els.card.classList.toggle('sel', sel);
    h.cardIdx = i;
    h.cardSel = sel;
    h.cardPinned = h.pinned;
    h.cardW = els.card.offsetWidth || 264;
    h.cardH = els.card.offsetHeight || 180;
    h.cardXY = '';
  }

  async _click(e) {
    if (this.measureMode) {
      const splat = this.splat, token = this.loadToken, measure = this.measureToken;
      if (!splat || this.measurePicking) return;
      this.measurePicking = true;
      this._showMeasure('正在拾取测量点…');
      this.raycaster.setFromCamera(this._ndc(e), this.camera);
      try {
        const pt = await splat.pick(this.raycaster.ray.origin, this.raycaster.ray.direction);
        if (splat !== this.splat || token !== this.loadToken || measure !== this.measureToken || !this.measureMode || !this.active) return;
        if (!pt) {
          this._showMeasure(this.measurePts.length === 1 ? '已选第 1 点，请点击第 2 点' : '测距：在模型上依次点击两个点');
          toast('这里没有拾取到高斯，请点在模型实体上', 'info', 2200);
          return;
        }
        this._addMeasurePoint(pt);
      } catch (err) {
        if (splat === this.splat && token === this.loadToken && measure === this.measureToken && this.measureMode && this.active) this._showMeasure(`拾取失败：${err.message}，请重试`);
      } finally {
        if (measure === this.measureToken) this.measurePicking = false;
      }
      return;
    }
    const i = this._pickBuilding(e);
    if (e.pointerType && e.pointerType !== 'mouse') {
      // touch / pen: no hover, so a tap pins the attribute card until the next tap on empty space
      this.hover.pinned = i >= 0;
      this.hover.pending = null;
      this.hover.last = null;
      this._setHover(i, this._localPtr(e));
    }
    if (i >= 0) this.selectBuilding(i, true);
  }

  async _focusAt(e) {
    const splat = this.splat, token = this.loadToken, focus = ++this.focusToken;
    if (!splat || this.measureMode) return;
    this.raycaster.setFromCamera(this._ndc(e), this.camera);
    let pt;
    try { pt = await splat.pick(this.raycaster.ray.origin, this.raycaster.ray.direction); } catch (err) {
      if (splat === this.splat && token === this.loadToken && focus === this.focusToken && this.active) toast(`定位失败：${err.message}`, 'err');
      return;
    }
    if (splat !== this.splat || token !== this.loadToken || focus !== this.focusToken || !this.active || this.measureMode) return;
    if (!pt) return;
    const dir = this.camera.position.clone().sub(this.controls.target);
    const dist = Math.max(this.radius * 0.12, dir.length() * 0.55);
    this.flyTo(pt.clone().add(dir.normalize().multiplyScalar(dist)), pt, 700);
  }

  /* ------------------------------------------------------------------ measuring */
  _marker(p) {
    const s = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius * 0.006, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x53e3ff, depthTest: false, transparent: true }),
    );
    s.position.copy(p);
    s.renderOrder = 5;
    return s;
  }

  _addMeasurePoint(p) {
    if (this.measurePts.length >= 2) this._clearMeasure();
    this.measurePts.push(p);
    this.measureGroup.add(this._marker(p));
    if (this.measurePts.length === 2) {
      const [a, b] = this.measurePts;
      const g = new THREE.BufferGeometry().setFromPoints([a, b]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffd27a, depthTest: false, transparent: true }));
      line.renderOrder = 5;
      this.measureGroup.add(line);
      const d = a.distanceTo(b);
      const dv = Math.abs(b.clone().sub(a).dot(this.up));
      const dh = Math.sqrt(Math.max(0, d * d - dv * dv));
      this._showMeasure(`模型坐标估算：距离 ${d.toFixed(2)} · 水平 ${dh.toFixed(2)} · 垂直 ${dv.toFixed(2)}（按米制模型；非测绘精度）`);
    } else {
      this._showMeasure('已选第 1 点，请点击第 2 点');
    }
    this.renderDirty = true;
  }

  _showMeasure(text) { const el = $('#measure-readout'); el.textContent = text; el.classList.remove('hidden'); }

  _clearMeasure() {
    this.measureToken++;
    this.measurePicking = false;
    this.measurePts = [];
    this.measureGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.measureGroup.clear();
    $('#measure-readout').classList.add('hidden');
    this.renderDirty = true;
  }

  /* ------------------------------------------------------------------ buildings */
  _alignKey() { return `twin.align.${this.current}${this.buildingsData?.aligned ? '.fina' : ''}`; }

  async _loadBuildings(m) {
    const token = this.loadToken;
    this.buildingsLoading = true;
    $('#insp-bld').innerHTML = '<p class="muted" role="status">建筑属性加载中…</p>';
    try {
      const data = await api.buildings(m.stem);
      if (token !== this.loadToken) return;
      const list = Array.isArray(data.buildings) ? data.buildings : [];
      if (!list.length) { $('#insp-bld').innerHTML = '<p class="muted" role="status">该模型的建筑属性数据为空。</p>'; return; }
      this.buildingsData = data;
      let off = null;
      try { off = JSON.parse(localStorage.getItem(this._alignKey()) || 'null'); } catch (_) { off = null; }
      if (!Array.isArray(off) || off.length !== 3 || !off.every(Number.isFinite)) off = data.aligned ? [0, 0, 0] : this._autoAlign(list, 'z');
      this.buildings.setData(list, new THREE.Vector3().fromArray(off));
      this.buildings.visible = $('#toolbar [data-act="buildings"]').classList.contains('on');
      this._renderBuildingPanel();
      this._renderTags();
      this.renderDirty = true;
      this.hoverDirty = true;
    } catch (e) {
      if (token === this.loadToken) {
        $('#insp-bld').innerHTML = `<p class="notice bad" role="status">建筑属性读取失败：${esc(e.message)}</p><button class="btn ghost" id="bld-retry">重试建筑属性</button>`;
        $('#bld-retry').onclick = () => this._loadBuildings(m);
        toast(`建筑属性读取失败：${e.message}`, 'err');
      }
    } finally {
      if (token === this.loadToken) this.buildingsLoading = false;
    }
  }

  /** mode 'z': keep the footprint XY and drop roofs onto the splat ground; 'xyz': also centre footprints on the scene. */
  _autoAlign(list, mode) {
    const st = this.splat?.stats;
    if (!st) return [0, 0, 0];
    let minBase = Infinity, sx = 0, sy = 0, n = 0;
    for (const b of list) {
      minBase = Math.min(minBase, Number(b.base) || 0);
      for (const p of b.ring || []) { sx += p[0]; sy += p[1]; n++; }
    }
    const groundZ = this.ground.z;
    const dz = Number.isFinite(minBase) ? groundZ - minBase : 0;
    if (mode === 'xyz' && n) return [st.p50[0] - sx / n, st.p50[1] - sy / n, dz];
    return [0, 0, dz];
  }

  _renderBuildingPanel() {
    const box = $('#insp-bld');
    const items = this.buildings.items;
    const off = this.buildings.offset;
    const crs = this.buildingsData?.crs || '—';
    const geo = this.buildingsData?.geo || items.some((it) => Number.isFinite(it.data.lat) && Number.isFinite(it.data.lon)) ? '有经纬度' : '未提供经纬度';
    box.innerHTML = `
      <div id="bld-detail" tabindex="-1"><p class="muted">选择一个建筑，查看属性与关联证据。</p></div>
      <p id="bld-label-status" class="muted small scene-label-status">标签自动避让 · 放大查看更多，或展开下方列表选择建筑。</p>
      <details class="scene-disclosure scene-building-list"><summary>浏览全部 ${items.length} 栋建筑</summary>
      <div class="blist">${items.map((it, i) => {
        const b = it.data;
        return `<div class="bitem${i === this.buildings.selected ? ' sel' : ''}" data-i="${i}" role="button" tabindex="0" aria-pressed="${i === this.buildings.selected}">
          <div class="h"><span>建筑 #${esc(b.id)}</span><span class="muted">${b.floors_est ? '约 ' : ''}${esc(b.floors ?? '—')} 层</span></div>
          <div class="muted small">面积 ${esc(b.area_m2 ?? '—')} m² · 高 ${esc(b.height_m ?? '—')} m · 朝向 ${esc(b.facade_azimuth ?? '—')}°</div>
        </div>`;
      }).join('')}</div></details>
      <details class="scene-disclosure scene-alignment"><summary>对齐调整</summary>
      <div class="notice">坐标系 <b>${esc(crs)}</b>（${esc(geo)}）。建筑轮廓与 3DGS 的对齐量可手动微调，并按模型保存在本机浏览器中。</div>
      ${this.buildingsData?.aligned ? '<p class="muted small">成果包已按 offset 对齐，默认偏移为 0；贴地 / 中心对齐仅在需要额外微调时使用。</p>' : ''}
      <div class="row2" style="margin-top:10px">
        <label class="field"><span>ΔX <b id="v-ax">${off.x.toFixed(1)}</b></span><input type="range" id="a-x" min="${Math.min(-120, Math.floor(off.x))}" max="${Math.max(120, Math.ceil(off.x))}" step="0.1" value="${off.x}"></label>
        <label class="field"><span>ΔY <b id="v-ay">${off.y.toFixed(1)}</b></span><input type="range" id="a-y" min="${Math.min(-120, Math.floor(off.y))}" max="${Math.max(120, Math.ceil(off.y))}" step="0.1" value="${off.y}"></label>
      </div>
      <label class="field"><span>ΔZ（高程） <b id="v-az">${off.z.toFixed(1)}</b></span><input type="range" id="a-z" min="${Math.min(-120, Math.floor(off.z))}" max="${Math.max(120, Math.ceil(off.z))}" step="0.1" value="${off.z}"></label>
      <div class="btn-row">
        <button class="btn ghost" id="a-auto-z">贴地对齐</button>
        <button class="btn ghost" id="a-auto-xyz">中心对齐</button>
        <button class="btn ghost" id="a-raw">原始坐标</button>
      </div></details>`;
    const apply = () => {
      const v = new THREE.Vector3(Number($('#a-x').value), Number($('#a-y').value), Number($('#a-z').value));
      $('#v-ax').textContent = v.x.toFixed(1); $('#v-ay').textContent = v.y.toFixed(1); $('#v-az').textContent = v.z.toFixed(1);
      this.buildings.setOffset(v);
      this.tagsDirty = this.hoverDirty = this.renderDirty = true;
      this.hover.camDirty = true;
      try { localStorage.setItem(this._alignKey(), JSON.stringify(v.toArray())); } catch (_) { toast('偏移已应用，但浏览器未能保存，下次打开需重新设置', 'info'); }
    };
    ['#a-x', '#a-y', '#a-z'].forEach((id) => $(id).addEventListener('input', apply));
    const setOff = (arr) => {
      ['#a-x', '#a-y', '#a-z'].forEach((id, i) => {
        const input = $(id);
        input.min = Math.min(-120, Math.floor(arr[i]));
        input.max = Math.max(120, Math.ceil(arr[i]));
        input.value = arr[i];
      });
      apply();
    };
    $('#a-auto-z').onclick = () => setOff(this._autoAlign(this.buildingsData.buildings, 'z'));
    $('#a-auto-xyz').onclick = () => setOff(this._autoAlign(this.buildingsData.buildings, 'xyz'));
    $('#a-raw').onclick = () => setOff([0, 0, 0]);
    box.querySelectorAll('.bitem').forEach((el) => {
      el.addEventListener('click', () => this.selectBuilding(Number(el.dataset.i), true));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.selectBuilding(Number(el.dataset.i), true); }
      });
    });
    if (this.buildings.selected >= 0) this._renderBuildingDetail(this.buildings.selected);
  }

  _renderBuildingDetail(i) {
    const b = this.buildings.items[i]?.data;
    const box = $('#bld-detail');
    if (!b || !box) return;
    const elevation = (value) => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value).toFixed(1) : '—';
    const rows = [
      ['面积', `${b.area_m2 ?? '—'} m²`], ['周长', `${b.perim_m ?? '—'} m`],
      ['地面 / 屋顶高程', `${elevation(b.base)} / ${elevation(b.top)} m`],
      ['高度 / 层数', `${b.height_m ?? '—'} m / ${b.floors ?? '—'} 层${b.floors_est ? '（估算）' : ''}`],
      ['主立面', `${b.facade_len_m ?? '—'} m · 朝向 ${b.facade_azimuth ?? '—'}°`],
      ['窗行数', b.window_rows ?? '—'],
      ['相邻建筑', `${b.neighbors_50m ?? '—'} 栋（50 m 内）${b.nearest_m != null ? `，最近 ${b.nearest_m} m` : ''}`],
      ['立面材质', b.material ? `${b.material}${b.color ? ` · ${b.color}` : ''}` : '未识别'],
      ['经纬度', b.lat != null ? `${b.lon}, ${b.lat}` : '无'],
    ];
    box.innerHTML = `<div class="card"><h3>建筑 #${esc(b.id)}</h3>
      <div class="btn-row"><button class="btn" id="b-street">街景视角</button><button class="btn ghost" id="b-orbit">环绕该建筑</button></div>
      <div id="bld-ev" class="ev"></div>
      <details class="scene-disclosure"><summary>建筑属性</summary><table class="tbl">${rows.map((r) => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join('')}</table></details></div>`;
    $('#b-street').onclick = () => this.streetView(i);
    this._loadEvidence(b);
    $('#b-orbit').onclick = () => {
      const c = this.buildings.worldCenter(i);
      const d = Math.max(25, Math.sqrt(Number(b.area_m2) || 100) * 3);
      this.flyTo(c.clone().addScaledVector(this.forward, -d).addScaledVector(this.up, d * 0.7), c, 900);
      this.controls.autoRotate = true;
      $('#toolbar [data-act="orbit"]').classList.add('on');
      $('#toolbar [data-act="orbit"]').setAttribute('aria-pressed', 'true');
    };
  }

  /** fina: evidence chain of one building (images, quotes, links, OSM) from /api/evidence. */
  async _loadEvidence(b) {
    const box = $('#bld-ev');
    const bd = this.buildingsData;
    this.evidenceAbort?.abort();
    if (!box) return;
    box.setAttribute('role', 'status');
    if (!bd?.evidence_api || b?.id == null) { box.innerHTML = '<div class="muted small">该模型未提供建筑证据数据。</div>'; return; }
    const controller = new AbortController();
    this.evidenceAbort = controller;
    box.innerHTML = '<div class="muted small">证据加载中…</div>';
    let ev;
    try {
      const r = await fetch(`${bd.evidence_api}/${encodeURIComponent(b.id)}`, { signal: controller.signal });
      ev = await r.json();
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw new Error('证据数据格式无效');
      if (!r.ok) throw new Error(ev.error || `HTTP ${r.status}`);
    } catch (e) {
      if (!controller.signal.aborted && box.isConnected && this.buildingsData === bd) box.innerHTML = `<div class="muted small">证据读取失败（${esc(e.message)}），可重新选择该建筑重试。</div>`;
      return;
    }
    if (controller.signal.aborted || !box.isConnected || this.buildingsData !== bd) return;
    const score = ev.score != null && typeof ev.score !== 'boolean' && String(ev.score).trim() !== '' && Number.isFinite(Number(ev.score)) ? `原始评分 ${Number(ev.score)}` : '';
    const match = ev.match === 'context' ? 'context（周边参考）' : ev.match;
    const meta = [ev.level ? `证据等级 ${ev.level}` : '', match ? `匹配 ${match}` : '', score, ev.matched_by ? `关联方式 ${ev.matched_by}` : ''].filter(Boolean).join(' · ');
    const safeURL = (u) => typeof u === 'string' && (/^https?:\/\//i.test(u) || /^\/(?!\/)/.test(u));
    const allImgs = (Array.isArray(ev.images) ? ev.images : []).filter((m) => m && safeURL(m.url));
    const imgs = allImgs.slice(0, 12);
    const links = (Array.isArray(ev.links) ? ev.links : []).filter((l) => l && /^https?:\/\//i.test(l.url));
    const quotes = (Array.isArray(ev.quotes) ? ev.quotes : (typeof ev.quotes === 'string' ? [ev.quotes] : []))
      .map((q) => (typeof q === 'string' ? q : (q && (q.text || q.quote || q.snippet)) || '')).filter(Boolean);
    const host = (u) => { try { return new URL(u).hostname; } catch (_) { return u; } };
    const osm = ev.osm && typeof ev.osm === 'object' && !Array.isArray(ev.osm) ? Object.entries(ev.osm) : [];
    const sheet = safeURL(ev.sheet) ? ev.sheet : null;
    const level = typeof ev.level === 'string' ? ev.level.trim().toUpperCase() : ev.level;
    const explanation = level === 'C'
      ? 'C 级为弱先验，仅供场景或材质参考；关联图像不代表已核实的该建筑单体实测照片。'
      : ev.match === 'context'
        ? '记录为周边匹配，图像仅作场景参考，尚不能确认对应此建筑单体。'
        : '等级与名称沿用成果记录；关联图像可能包含参考资料或生成材质，具体来源见原始证据记录。';
    const imageLabel = (m) => /(?:\/ortho\/|local_ortho)/i.test(`${m.path || m.url} ${m.label || ''}`) ? '正射裁片'
      : /(?:\/textures?\/|local_texture)/i.test(`${m.path || m.url} ${m.label || ''}`) ? '纹理 / 材质图' : '关联参考图';
    const imageHTML = (list) => `<div class="ev-thumbs">${list.map((m) => `<a href="${esc(m.url)}" target="_blank" rel="noopener" title="${imageLabel(m)}"><img loading="lazy" src="${esc(m.url)}" alt="${imageLabel(m)}"><span class="ev-image-label">${imageLabel(m)}</span></a>`).join('')}</div>`;
    let rawText = ev.text || '';
    try { rawText = JSON.stringify(JSON.parse(rawText), null, 2); } catch (_) { /* preserve prose records */ }
    box.innerHTML = `<h4>${ev.name ? esc(ev.name) : '关联证据'}</h4>`
      + `<div class="ev-meta">${level ? `证据等级 ${esc(level)}` : '未提供证据等级'}</div>`
      + `<p class="ev-summary muted small">${explanation}</p>`
      + (ev.name_match === false ? '<p class="notice">证据名称与模型记录不一致，详见原始证据记录。</p>' : '')
      + (imgs.length ? `<h4>关联图像（${allImgs.length}）</h4>${imageHTML(imgs)}` : '')
      + (allImgs.length > imgs.length ? `<details class="ev-more"><summary>其余 ${allImgs.length - imgs.length} 张图像</summary>${imageHTML(allImgs.slice(12))}</details>` : '')
      + (sheet ? `<div class="btn-row"><a class="btn ghost" href="${esc(sheet)}" target="_blank" rel="noopener">场景证据总览图 ↗</a></div>` : '')
      + '<details class="scene-disclosure ev-raw-record"><summary>原始证据记录</summary>'
      + (meta ? `<div class="ev-meta">${esc(meta)}</div>` : '')
      + (ev.name_match === false ? `<p class="muted small">模型记录名称：${esc(ev.sidecar_name || '未提供名称')}；证据名称：${esc(ev.name || '未提供名称')}。</p>` : '')
      + (ev.evidence_json ? `<div class="muted small">来源文件：${esc(ev.evidence_json)}</div>` : '')
      + (quotes.length ? `<h4>摘录</h4>${quotes.map((q) => `<div class="ev-quote">${esc(q)}</div>`).join('')}` : '')
      + (links.length ? `<h4>来源链接</h4><div class="ev-links">${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.url)}">${esc(host(l.url))}${l.label ? ` · ${esc(l.label)}` : ''}</a>`).join('')}</div>` : '')
      + (osm.length ? `<h4>OSM 标签</h4><table class="tbl">${osm.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('')}</table>` : '')
      + (rawText ? `<pre class="ev-raw">${esc(rawText)}</pre>` : '')
      + '</details>'
      + (!imgs.length && !links.length && !quotes.length && !ev.text && !osm.length && !sheet ? '<div class="muted small">该建筑没有可展示的证据条目</div>' : '');
  }

  selectBuilding(i, fly) {
    if (!this.buildings.items[i]) return;
    this.buildings.setSelected(i);
    $$('#insp-bld .bitem').forEach((el) => {
      el.classList.toggle('sel', Number(el.dataset.i) === i);
      el.setAttribute('aria-pressed', String(Number(el.dataset.i) === i));
    });
    this._renderBuildingDetail(i);
    $$('#insp-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'bld'));
    for (const id of ['model', 'render', 'bld']) $(`#insp-${id}`).classList.toggle('hidden', id !== 'bld');
    $('#insp-bld').scrollTop = 0;
    if (document.activeElement?.matches('.bitem, .btag')) $('#bld-detail').focus({ preventScroll: true });
    this.tagsDirty = this.hoverDirty = this.renderDirty = true;
    if (fly) {
      const it = this.buildings.items[i];
      const c = this.buildings.worldCenter(i);
      const d = Math.max(20, (it.top - it.base) * 2.6, Math.sqrt(Number(it.data.area_m2) || 100) * 2.4);
      this.flyTo(c.clone().addScaledVector(this.forward, -d).addScaledVector(this.right, -d * 0.4).addScaledVector(this.up, d * 0.8), c, 900);
    }
  }

  /** Eye-level view facing the longest facade (same idea as the original attr_overlay). */
  streetView(i) {
    const it = this.buildings.items[i];
    if (!it) return;
    const pts = it.ring;
    let best = 0, nx = 0, ny = 0, mx = 0, my = 0;
    for (let k = 0; k < pts.length; k++) {
      const next = pts[(k + 1) % pts.length];
      const dx = next[0] - pts[k][0], dy = next[1] - pts[k][1];
      const L = Math.hypot(dx, dy);
      if (L > best) { best = L; nx = -dy / L; ny = dx / L; mx = (pts[k][0] + next[0]) / 2; my = (pts[k][1] + next[1]) / 2; }
    }
    const cx = it.center.x, cy = it.center.y;
    if (nx * (cx - mx) + ny * (cy - my) > 0) { nx = -nx; ny = -ny; }
    const D = Math.max(12, 0.62 * best);
    const o = this.buildings.offset;
    const eye = new THREE.Vector3(mx + nx * D, my + ny * D, it.base + 1.7).add(o);
    const tgt = new THREE.Vector3(cx, cy, it.base + Math.min(6, (it.top - it.base) * 0.5)).add(o);
    this.flyTo(eye, tgt, 1100);
  }

  _renderTags() {
    const box = $('#building-tags');
    box.classList.toggle('hidden', !this.buildings.visible);
    box.innerHTML = this.buildings.items.map((it, i) => `<span class="btag${i === this.buildings.selected ? ' sel' : ''}" data-i="${i}" role="button" tabindex="0" aria-pressed="${i === this.buildings.selected}" style="visibility:hidden">#${esc(it.data.id)} · ${it.data.floors_est ? '约 ' : ''}${esc(it.data.floors ?? '?')}F · ${esc(it.data.height_m ?? '?')} m</span>`).join('');
    this.tagSizes = [];
    this.tagsDirty = true;
    box.querySelectorAll('.btag').forEach((el) => {
      const i = Number(el.dataset.i);
      el.addEventListener('click', () => this.selectBuilding(i, true));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.selectBuilding(i, true); }
      });
      el.addEventListener('focus', () => { this._setHover(i); this.tagsDirty = true; });
      el.addEventListener('blur', () => { if (this.hover.idx === i && !this.hover.last) this._setHover(-1); this.tagsDirty = true; });
      el.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'touch') return;
        this.hover.pinned = false;
        this._setHover(i);
      });
      el.addEventListener('pointerleave', () => { if (this.hover.idx === i && !this.hover.last) this._setHover(-1); });
    });
  }

  _updateTags() {
    if (!this.buildings.items.length || !this.buildings.visible) return;
    if (!this.tagsDirty) return;
    const tags = $('#building-tags').children;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    if (this.tagSizes.length !== tags.length) {
      for (const el of tags) { el.style.visibility = 'hidden'; el.style.display = ''; }
      this.tagSizes = Array.from(tags, (el) => ({ w: el.offsetWidth || 125, h: el.offsetHeight || 24 }));
    }
    const candidates = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < tags.length; i++) {
      this.buildings.worldTop(i, v).addScaledVector(this.up, 1.5);
      v.project(this.camera);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      const priority = document.activeElement === tags[i] ? 4 : i === this.buildings.selected ? 3 : i === this.hover.idx ? 2 : 0;
      candidates.push({ i, x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, depth: v.z, priority, ...this.tagSizes[i] });
    }
    const zoom = Math.max(1, this.radius * 2.3 / Math.max(1, this.camera.position.distanceTo(this.controls.target)));
    const budget = Math.max(4, Math.min(32, Math.floor(w * h / 70000 * zoom)));
    const placed = new Map(layoutBuildingLabels(candidates, w, h, budget).map((p) => [p.i, p]));
    for (let i = 0; i < tags.length; i++) {
      const el = tags[i], p = placed.get(i);
      el.style.display = p ? '' : 'none';
      el.style.visibility = p ? 'visible' : 'hidden';
      el.classList.toggle('sel', i === this.buildings.selected);
      el.classList.toggle('hov', i === this.hover.idx);
      el.setAttribute('aria-pressed', String(i === this.buildings.selected));
      if (p) { el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; el.style.zIndex = String(p.priority + 1); }
    }
    const status = $('#bld-label-status');
    if (status) status.textContent = `显示 ${placed.size} / ${tags.length} 个建筑标签 · 放大查看更多，选中或悬停优先显示；全部建筑可在下方列表选择。`;
    this.tagsDirty = false;
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    this.renderer.domElement.toBlob((blob) => {
      if (!blob) { toast('截图失败', 'err'); return; }
      downloadBlob(blob, `twin_${(this.current || 'scene').replace(/\.splat$/, '')}_${stamp()}.png`);
      toast('截图已保存到浏览器下载目录', 'ok');
    }, 'image/png');
  }

  setActive(on) {
    this.active = !!on;
    if (!this.active || document.hidden) {
      if (this.raf !== null) cancelAnimationFrame(this.raf);
      this.raf = null;
      this.focusToken++;
      this.hover.pending = this.hover.last = this.hover.down = null;
      this._setHover(-1);
      this._hideHoverOverlay();
      if (this.hoverEls) this.hoverEls.hint.classList.remove('show');
      this.hover.hintText = '';
      return;
    }
    this.frames = 0;
    this.fpsT = performance.now();
    this.lastRenderAt = undefined;
    this._resize();
    this._animate();
  }
}
