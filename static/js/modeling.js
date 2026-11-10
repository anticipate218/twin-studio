// Procedural modeling: footprints (buildings.json or generated district) + agent textures -> textured 3D city,
// exportable as GLB. Also hosts the 3DGS reconstruction job form (legacy citytwin pipeline) and the
// local material-agent launcher.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { api } from './api.js';
import { $, $$, esc, toast, downloadBlob, stamp, mulberry32, fmtScore, fmtBytes, fmtNum, lightbox } from './ui.js';
import { buildingGeometry, facadeMaterial, proceduralDistrict, cleanRing } from './buildings.js';

// PATCH upload-pipeline: user image upload -> reconstruction -> model library.
const RECON_STEPS = ['上传', '读取对齐', '地形分类', '生成高斯', '写出预览', '完成'];
const STAGE_STEP = { upload: 0, queued: 1, load: 1, dsm: 1, grid: 2, terrain: 2, classify: 2, surface: 3, facade: 3, write: 4, preview: 4, done: 5 };
const STAGE_LABEL = { queued: '排队', load: '读取影像', dsm: '对齐 DSM', grid: '构建网格', terrain: '地形估计', classify: '地物分类', surface: '地表 / 屋顶面元', facade: '立面面元', write: '写出 .splat', preview: '生成预览', done: '完成', cancelled: '已取消', error: '失败' };
const EXT_FAMILY = { '.jpg': ['jpeg'], '.jpeg': ['jpeg'], '.png': ['png'], '.webp': ['webp'], '.tif': ['tiff', 'bigtiff'], '.tiff': ['tiff', 'bigtiff'], '.img': ['erdas-img', 'tiff', 'bigtiff'] };
const FAMILY_LABEL = { jpeg: 'JPEG', png: 'PNG', tiff: 'TIFF', bigtiff: 'BigTIFF', webp: 'WebP', 'erdas-img': 'ERDAS IMG' };
const COUNT_LABEL = { gaussians: '高斯', splats: '高斯', buildings: '建筑', ground: '地表', surface: '地表', roof: '屋顶', roofs: '屋顶', facade: '立面', facades: '立面', points: '点' };
const JOB_STATUS = { done: ['ok', '完成'], running: ['info', '运行中'], error: ['bad', '失败'], uploaded: ['', '待启动'] };

function sniffFamily(h) {
  const s = (a, b) => String.fromCharCode(...h.slice(a, b));
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'jpeg';
  if (h[0] === 0x89 && s(1, 4) === 'PNG') return 'png';
  if ((h[0] === 0x49 && h[1] === 0x49 && h[2] === 0x2a && h[3] === 0) || (h[0] === 0x4d && h[1] === 0x4d && h[2] === 0 && h[3] === 0x2a)) return 'tiff';
  if ((h[0] === 0x49 && h[1] === 0x49 && h[2] === 0x2b && h[3] === 0) || (h[0] === 0x4d && h[1] === 0x4d && h[2] === 0 && h[3] === 0x2b)) return 'bigtiff';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'webp';
  if (s(0, 15) === 'EHFA_HEADER_TAG') return 'erdas-img';
  return null;
}

export class ModelingView {
  constructor(root) {
    this.root = root;
    this.inited = false;
    this.textures = [];
    this.selectedTex = new Set();
    this.texCache = new Map();
    this.source = 'district';
    this.buildingSets = [];
    this.city = null;
    this.system = null;
    this.active = true;
    this.buildSeq = 0;
    this.texturesSeq = 0;
    this.fileSeq = { image: 0, dsm: 0 };
    this.reconPollSeq = 0;
    this.agentPollSeq = 0;
    this.jobActionSeq = 0;
    this.jobsSeq = 0;
    this.agent = { phase: 'idle', id: null, timer: 0, fails: 0 };
    this.exporting = false;
    document.addEventListener('visibilitychange', () => this._syncPolling());
  }

  init() {
    if (!this.initPromise) this.initPromise = this._init();
    return this.initPromise;
  }

  async _init() {
    if (this.inited) return;
    this.inited = true;
    this.root.innerHTML = `
      <aside class="panel glass">
        <div class="seg" id="mod-tabs"><button class="active" data-t="proc">程序化建模</button><button data-t="recon">影像重建</button><button data-t="agent">材质生成</button></div>
        <div class="form" id="tab-proc">
          <label class="field"><span>建筑轮廓来源</span>
            <select id="p-source" aria-label="建筑轮廓来源"><option value="district">程序化街区（参数生成）</option></select></label>
          <div id="district-params">
            <div class="row2">
              <label class="field"><span>街区行 <b id="v-rows">4</b></span><input type="range" id="p-rows" min="1" max="10" value="4"></label>
              <label class="field"><span>街区列 <b id="v-cols">5</b></span><input type="range" id="p-cols" min="1" max="10" value="5"></label>
            </div>
            <div class="row2">
              <label class="field"><span>最低高度 <b id="v-minh">9</b> m</span><input type="range" id="p-minh" min="3" max="60" value="9"></label>
              <label class="field"><span>最高高度 <b id="v-maxh">72</b> m</span><input type="range" id="p-maxh" min="10" max="240" value="72"></label>
            </div>
            <div class="row2">
              <label class="field"><span>地块尺寸 <b id="v-block">34</b> m</span><input type="range" id="p-block" min="16" max="80" value="34"></label>
              <label class="field"><span>街道宽度 <b id="v-street">14</b> m</span><input type="range" id="p-street" min="6" max="40" value="14"></label>
            </div>
            <label class="field"><span>布局种子</span><input type="number" id="p-seed" value="7" min="0" max="4294967295" step="1"></label>
          </div>
          <div class="row2">
            <label class="field"><span>层高 <b id="v-floorh">3.2</b> m</span><input type="range" id="p-floorh" min="2.6" max="5" step="0.1" value="3.2"></label>
            <label class="field"><span>纹理尺度 <b id="v-tile2">4.0</b> m</span><input type="range" id="p-tile" min="1" max="12" step="0.5" value="4"></label>
          </div>
          <div class="field"><span>立面材质 · 可多选分配到建筑</span><div class="tex-pick" id="tex-pick"><div class="skeleton" style="height:60px;grid-column:span 4"></div></div><span id="tex-status" class="muted small" role="status"></span><button class="btn ghost" id="p-tex-refresh">刷新材质</button></div>
          <label class="field"><span>光照</span>
            <select id="p-light" aria-label="光照"><option value="day">白天 · 晴</option><option value="dusk">黄昏 · 暖光</option><option value="night">夜景 · 城市光</option></select></label>
          <div class="btn-row">
            <button class="btn primary" id="p-build">⬢ 生成模型</button>
            <button class="btn" id="p-export" disabled>导出 GLB</button>
            <button class="btn ghost" id="p-shot">截图</button>
          </div>
          <div id="p-summary" class="muted small" role="status" aria-live="polite"></div>
          <div id="p-export-status" class="muted small" role="status" aria-live="polite"></div>
          <div id="exports-list"></div>
        </div>
        <div class="form hidden" id="tab-recon">
          <div id="recon-status" class="notice">正在检查重建链路…</div>
          <div class="dropzone" id="r-drop-image" tabindex="0" role="button" aria-label="选择航拍或正射影像">
            <input type="file" id="r-image" accept=".jpg,.jpeg,.png,.tif,.tiff,.webp,.img" hidden>
            <div class="dz-empty"><b>① 航拍 / 正射影像</b><span>拖入或点击选择 · JPG / PNG / TIF / WebP / IMG · 单个文件 ≤ <i class="r-max">—</i> MB</span></div>
            <div class="dz-file hidden"></div>
          </div>
          <div class="dropzone" id="r-drop-dsm" tabindex="0" role="button" aria-label="选择 DSM 高程 GeoTIFF（可选）">
            <input type="file" id="r-dsm" accept=".tif,.tiff" hidden>
            <div class="dz-empty"><b>② DSM 高程 GeoTIFF<em>可选</em></b><span>有 DSM：提取真实建筑高度与立面 · 无 DSM：降级为平坦地表</span></div>
            <div class="dz-file hidden"></div>
          </div>
          <div class="row2">
            <label class="field"><span>任务名称（可选）</span><input type="text" id="r-title" maxlength="60" placeholder="如：天河 CBD 航拍"></label>
            <label class="field"><span>场景宽度（米）</span><input type="number" id="r-width" value="220" min="5" max="5000" title="影像没有地理参考时用于换算尺度；GeoTIFF 以自身坐标为准"></label>
          </div>
          <div class="r-mode" id="r-mode"></div>
          <div class="btn-row">
            <button class="btn primary" id="r-submit" disabled>开始重建</button>
            <button class="btn hidden" id="r-cancel">取消</button>
            <button class="btn ghost" id="r-reset">清空</button>
          </div>
          <ol class="r-steps" id="r-steps"></ol>
          <div class="progress"><i id="r-prog"></i></div>
          <div class="r-prog-text muted small" id="r-prog-text"></div>
          <div id="r-result"></div>
          <details class="r-logbox" id="r-logbox"><summary>任务日志</summary><div class="job-log" id="r-log">尚未提交任务。</div></details>
          <div class="card r-history"><h3><span>最近任务</span><button class="btn ghost" id="r-refresh" type="button">刷新</button></h3><div id="r-jobs" class="muted small">加载中…</div></div>
        </div>
        <div class="form hidden" id="tab-agent">
          <div id="agent-status" class="notice">正在检查本地生成环境…</div>
          <div class="row2">
            <label class="field"><span>项目纬度</span><input type="number" id="g-lat" min="-90" max="90" step="any" value="23.136009"></label>
            <label class="field"><span>项目经度</span><input type="number" id="g-lon" min="-180" max="180" step="any" value="113.327319"></label>
          </div>
          <div class="row2">
            <label class="field"><span>迭代轮数</span><input type="number" id="g-rounds" min="1" max="6" value="3"></label>
            <label class="field"><span>每轮种子数</span><input type="number" id="g-seeds" min="1" max="16" value="8"></label>
          </div>
          <div class="btn-row"><button class="btn primary" id="g-run">生成项目材质</button><button class="btn ghost hidden" id="g-resume">重新查询进度</button></div>
          <div class="muted small" id="g-progress" role="status" aria-live="polite">使用项目经纬度生成立面材质。</div>
          <details class="r-logbox"><summary>生成日志与技术详情</summary><div class="job-log" id="g-log">未运行。</div></details>
        </div>
      </aside>
      <div class="viewport" id="mod-viewport">
        <div class="hud-top"><div class="hud-title"><h1 id="mod-title">程序化城市建模</h1><div class="hud-metrics" id="mod-metrics"></div></div>
          <div class="hud-stats"><span id="mod-stats">—</span></div></div>
        <div class="keyhint">左键旋转 · 右键平移 · 滚轮缩放 · 点击建筑查看属性</div>
        <div class="measure-readout hidden" id="mod-pick"></div>
      </div>`;
    this._bindTabs();
    this._setup3D();
    this._bindForm();
    await Promise.all([this._loadTextures(), this._loadBuildingSources(), this._loadSystem(), this._loadExports()]);
    this.ready = true;
    this._loadReconJobs();
    await this.build();
  }

  _bindTabs() {
    $('#mod-tabs', this.root).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) this._showTab(b.dataset.t);
    });
  }

  _showTab(t) {
    if (!['proc', 'recon', 'agent'].includes(t)) t = 'proc';
    $$('#mod-tabs button', this.root).forEach((x) => x.classList.toggle('active', x.dataset.t === t));
    for (const k of ['proc', 'recon', 'agent']) $(`#tab-${k}`, this.root).classList.toggle('hidden', k !== t);
  }

  setActive(on) {
    this.active = !!on;
    this._syncPolling();
  }

  _canPoll() { return this.active && !document.hidden; }

  _syncPolling() {
    const allowed = this._canPoll();
    if (this.pollingAllowed === allowed) return;
    this.pollingAllowed = allowed;
    ++this.reconPollSeq;
    ++this.agentPollSeq;
    clearTimeout(this.recon?.timer);
    clearTimeout(this.agent.timer);
    if (!allowed) return;
    if (this.recon?.phase === 'running') this._pollRecon(this.recon.jobId, { resumed: true });
    if (this.agent.phase === 'running') this._pollAgent();
  }

  _bindForm() {
    const R = this.root;
    const rng = (id, label, digits = 0) => {
      const el = $(id, R);
      const upd = () => { $(label, R).textContent = Number(el.value).toFixed(digits); };
      el.addEventListener('input', upd);
      upd();
    };
    rng('#p-rows', '#v-rows'); rng('#p-cols', '#v-cols'); rng('#p-minh', '#v-minh'); rng('#p-maxh', '#v-maxh');
    rng('#p-block', '#v-block'); rng('#p-street', '#v-street'); rng('#p-floorh', '#v-floorh', 1); rng('#p-tile', '#v-tile2', 1);
    $('#p-source', R).addEventListener('change', (e) => {
      this.source = e.target.value;
      $('#district-params', R).classList.toggle('hidden', this.source !== 'district');
      this.build();
    });
    $('#p-build', R).addEventListener('click', () => this.build());
    $('#p-tex-refresh', R).addEventListener('click', () => this._loadTextures());
    $('#p-export', R).addEventListener('click', () => this.exportGLB());
    $('#p-shot', R).addEventListener('click', () => {
      this.g.r.render(this.g.scene, this.g.cam);
      this.g.r.domElement.toBlob((b) => b && downloadBlob(b, `twin_city_${stamp()}.png`), 'image/png');
    });
    $('#p-light', R).addEventListener('change', (e) => this._applyLighting(e.target.value));
    this._bindRecon();
    $('#g-run', R).addEventListener('click', () => this.runAgent());
    $('#g-resume', R).addEventListener('click', () => {
      if (this.agent.id) { this.agent.phase = 'running'; this.agent.fails = 0; this._pollAgent(); }
    });
    window.addEventListener('twin:material', (e) => {
      if (!this._acceptMaterial(e.detail)) return;
      this._showTab('proc');
      if (this.ready) this.build();
    });
  }

  _acceptMaterial(sel) {
    if (!sel || typeof sel.url !== 'string' || !sel.url) return false;
    const clamp = (v, min, max, fallback) => Number.isFinite(Number(v)) && v !== null ? Math.min(max, Math.max(min, Number(v))) : fallback;
    const material = { ...sel, roughness: clamp(sel.roughness, 0.05, 1, 0.62), metalness: clamp(sel.metalness, 0, 1, 0.08) };
    const existing = this.textures.find((t) => t.url === sel.url);
    if (existing) Object.assign(existing, material); else this.textures.unshift(material);
    this.selectedTex = new Set([sel.url]);
    this.selectionTouched = true;
    $('#p-tile', this.root).value = clamp(sel.tile, 1, 12, 4);
    $('#p-tile', this.root).dispatchEvent(new Event('input'));
    this._renderTexPick();
    return true;
  }

  /* ------------------------------------------------------------------ data sources */
  async _loadTextures() {
    const seq = ++this.texturesSeq;
    $('#p-tex-refresh', this.root).disabled = true;
    if (!this.selectionRestored) {
      this.selectionRestored = true;
      let saved = window.twinSelectedMaterial;
      if (!saved) { try { saved = JSON.parse(localStorage.getItem('twin.material.selected') || 'null'); } catch (_) { /* storage unavailable */ } }
      if (!this.selectionTouched) this._acceptMaterial(saved);
    }
    try {
      const res = await api.runs();
      if (seq !== this.texturesSeq) return;
      const runs = (res.runs || []).filter((r) => r.texture);
      const seen = new Set();
      const previous = this.textures;
      this.textures = [];
      for (const r of runs.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))) {
        if (seen.has(r.texture)) continue;
        seen.add(r.texture);
        this.textures.push({ ...previous.find((t) => t.url === r.texture), url: r.texture, run: r.id, score: r.score, material: r.material || '' });
      }
      for (const t of previous) if (this.selectedTex.has(t.url) && !seen.has(t.url)) this.textures.push(t);
      if (!this.selectionTouched) {
        const mats = new Set();
        for (const t of this.textures) {
          if (this.selectedTex.size >= 4) break;
          const k = t.material || t.url;
          if (mats.has(k)) continue;
          mats.add(k);
          this.selectedTex.add(t.url);
        }
      }
      this._renderTexPick();
      $('#tex-status', this.root).textContent = this.textures.length ? '选择材质后点击“生成模型”更新预览；不选材质时使用纯色立面。' : '暂无生成材质，可先使用纯色立面建模。';
    } catch (e) {
      if (seq !== this.texturesSeq) return;
      this._renderTexPick();
      $('#tex-status', this.root).textContent = `材质列表读取失败：${e.message}。可点击“刷新材质”重试。`;
    } finally {
      if (seq === this.texturesSeq) $('#p-tex-refresh', this.root).disabled = false;
    }
  }

  _renderTexPick() {
    const box = $('#tex-pick', this.root);
    if (!this.textures.length) { box.innerHTML = '<div class="muted" style="grid-column:span 4">没有可用纹理，将使用纯色材质。</div>'; return; }
    box.innerHTML = this.textures.map((t) => `<button class="${this.selectedTex.has(t.url) ? 'on' : ''}" data-url="${esc(t.url)}" aria-pressed="${this.selectedTex.has(t.url)}" aria-label="${esc(t.material || t.run || '项目材质')}" title="${esc(t.run)} ${esc(t.material)}" style="background-image:url('${esc(t.url.replace(/'/g, '%27'))}')"><i>${esc(fmtScore(t.score))}</i></button>`).join('');
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const u = b.dataset.url;
      if (this.selectedTex.has(u)) this.selectedTex.delete(u); else this.selectedTex.add(u);
      this.selectionTouched = true;
      b.classList.toggle('on', this.selectedTex.has(u));
      b.setAttribute('aria-pressed', String(this.selectedTex.has(u)));
      $('#tex-status', this.root).textContent = `已选择 ${this.selectedTex.size} 种材质，点击“生成模型”应用。`;
    }));
  }

  async _loadBuildingSources() {
    try {
      const res = await api.models();
      this.buildingSets = (res.models || []).filter((m) => m.buildings);
      const sel = $('#p-source', this.root);
      const keep = sel.value;
      sel.querySelectorAll('option[value^="bld:"]').forEach((o) => o.remove());
      for (const m of this.buildingSets) {
        const o = document.createElement('option');
        o.value = `bld:${m.stem}`;
        o.textContent = `建筑属性 · ${m.title || m.stem}`;
        sel.appendChild(o);
      }
      sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'district';
      if (sel.value !== keep) this.source = sel.value;
    } catch (_) { /* optional */ }
  }

  async _loadSystem() {
    try {
      this.system = await api.system();
    } catch (e) {
      this.system = null;
    }
    const s = this.system;
    this._renderReconStatus();
    const as = $('#agent-status', this.root);
    const ag = s?.agent;
    // Keep the run entry usable; missing weights / GPU are reported when the run button is clicked (_checkAgent).
    if (!ag?.can_generate) { as.className = 'notice'; as.textContent = '填写项目位置，点击“生成项目材质”开始。运行前会检查本地生成条件。'; }
    else { as.className = 'notice ok'; as.textContent = '本地材质生成环境就绪，生成结果将加入项目材质库。'; }
    $('#g-run', this.root).disabled = ['checking', 'starting', 'running', 'waiting'].includes(this.agent.phase);
  }

  async _loadExports() {
    try {
      const res = await api.exports();
      const items = res.exports || [];
      $('#exports-list', this.root).innerHTML = items.length ? `<details class="card r-logbox"><summary>已导出模型（${items.length}）</summary><table class="tbl">${items.map((x) => `<tr><td><a href="${esc(x.url)}" download>${esc(x.name)}</a></td><td class="muted">${esc(fmtBytes(x.size))}</td></tr>`).join('')}</table></details>` : '';
    } catch (e) {
      $('#exports-list', this.root).innerHTML = `<div class="notice warn">历史导出读取失败：${esc(e.message)}<button class="btn ghost" id="p-exports-retry">刷新记录</button></div>`;
      $('#p-exports-retry', this.root).addEventListener('click', () => this._loadExports());
    }
  }

  /* ------------------------------------------------------------------ 3D */
  _setup3D() {
    const host = $('#mod-viewport', this.root);
    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.domElement.className = 'main';
    host.prepend(r.domElement);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(45, 1, 0.5, 6000);
    cam.up.set(0, 0, 1);
    cam.position.set(-220, -260, 200);
    const ctl = new OrbitControls(cam, r.domElement);
    ctl.enableDamping = true;
    ctl.maxPolarAngle = Math.PI * 0.495;
    ctl.screenSpacePanning = false;
    const hemi = new THREE.HemisphereLight(0xd6ecff, 0x1b2230, 1.0);
    // Buildings use Z-up; the hemisphere must illuminate roofs from +Z as well.
    hemi.position.set(0, 0, 1);
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    scene.add(hemi, sun, sun.target);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x1a202b, roughness: 0.96 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), groundMat);
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(1, 10, 0x2a8bb0, 0x1b3346);
    grid.rotation.x = Math.PI / 2;
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    scene.add(grid);
    this.g = { r, scene, cam, ctl, hemi, sun, ground, grid, host, raycaster: new THREE.Raycaster() };
    this._applyLighting('day');
    new ResizeObserver(() => {
      const w = host.clientWidth || 1, h = host.clientHeight || 1;
      r.setSize(w, h, false);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }).observe(host);
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.root.classList.contains('active')) return;
      ctl.update();
      r.render(scene, cam);
    };
    loop();
    let down = null;
    r.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    r.domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) { down = null; return; }
      down = null;
      this._pick(e);
    });
  }

  _applyLighting(mode) {
    const { scene, hemi, sun, r, ground } = this.g;
    if (mode === 'night') {
      scene.background = new THREE.Color(0x03050c);
      scene.fog = new THREE.FogExp2(0x03050c, 0.0016);
      hemi.color.set(0x5170a8); hemi.groundColor.set(0x0a0d16); hemi.intensity = 0.55;
      sun.color.set(0x9fb7ff); sun.intensity = 0.6;
      r.toneMappingExposure = 1.15;
      ground.material.color.set(0x0c1018);
    } else if (mode === 'dusk') {
      scene.background = new THREE.Color(0x2a1d2c);
      scene.fog = new THREE.FogExp2(0x2a1d2c, 0.0012);
      hemi.color.set(0xffc9a0); hemi.groundColor.set(0x251a24); hemi.intensity = 0.8;
      sun.color.set(0xffa964); sun.intensity = 2.4;
      r.toneMappingExposure = 1.05;
      ground.material.color.set(0x1e1a20);
    } else {
      scene.background = new THREE.Color(0x0b1424);
      scene.fog = new THREE.FogExp2(0x0b1424, 0.0009);
      hemi.color.set(0xe2f0ff); hemi.groundColor.set(0x63748a); hemi.intensity = 1.7;
      sun.color.set(0xfff1dc); sun.intensity = 2.8;
      r.toneMappingExposure = 1.08;
      ground.material.color.set(0x29364a);
    }
    this.lightMode = mode;
    if (this.city) this._applyNightWindows();
  }

  async _texture(url) {
    if (this.texCache.has(url)) return this.texCache.get(url);
    const p = new Promise((resolve) => {
      new THREE.TextureLoader().load(url, (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = this.g.r.capabilities.getMaxAnisotropy();
        resolve(t);
      }, undefined, () => resolve(null));
    });
    this.texCache.set(url, p);
    const texture = await p;
    if (!texture && this.texCache.get(url) === p) this.texCache.delete(url);
    return texture;
  }

  _number(id, label, min, max, integer = false) {
    const el = $(id, this.root);
    const value = Number(el.value);
    if (!String(el.value).trim() || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      el.focus();
      throw new Error(`${label}需为 ${min}–${max} 之间的${integer ? '整数' : '数值'}`);
    }
    return value;
  }

  _buildParams() {
    const params = { source: this.source, tile: this._number('#p-tile', '纹理尺度', 1, 12), floorH: this._number('#p-floorh', '层高', 2.6, 5), materials: [...this.selectedTex].map((url) => ({ ...this.textures.find((t) => t.url === url), url })) };
    if (params.source === 'district') {
      Object.assign(params, {
        rows: this._number('#p-rows', '街区行数', 1, 10, true), cols: this._number('#p-cols', '街区列数', 1, 10, true),
        minH: this._number('#p-minh', '最低高度', 3, 60), maxH: this._number('#p-maxh', '最高高度', 10, 240),
        block: this._number('#p-block', '地块尺寸', 16, 80), street: this._number('#p-street', '街道宽度', 6, 40),
        seed: this._number('#p-seed', '布局种子', 0, 4294967295, true),
      });
      if (params.minH > params.maxH) { $('#p-minh', this.root).focus(); throw new Error('最低高度不能大于最高高度，请调整后生成。'); }
    }
    return params;
  }

  async _footprints(params) {
    if (params.source.startsWith('bld:')) {
      const stem = params.source.slice(4);
      const data = await api.buildings(stem);
      const list = (data.buildings || []).filter((b) => Array.isArray(b.ring)).map((b) => ({ ...b, ring: cleanRing(b.ring) })).filter((b) => {
        if (b.ring.length < 3) return false;
        const area = b.ring.reduce((sum, p, i) => { const q = b.ring[(i + 1) % b.ring.length]; return sum + p[0] * q[1] - p[1] * q[0]; }, 0);
        return Math.abs(area) > 1e-6;
      });
      // Normalise to local ground: base 0, keep heights; centre footprints on the origin.
      let sx = 0, sy = 0, n = 0;
      for (const b of list) for (const p of cleanRing(b.ring)) { sx += p[0]; sy += p[1]; n++; }
      const cx = n ? sx / n : 0, cy = n ? sy / n : 0;
      const floorH = params.floorH;
      return {
        label: `建筑属性 · ${stem}`,
        list: list.map((b) => {
          const h = [Number(b.height_m), Number(b.top) - Number(b.base), Number(b.floors) * floorH].find((v) => Number.isFinite(v) && v > 0) || 3 * floorH;
          return { ...b, ring: cleanRing(b.ring).map((p) => [p[0] - cx, p[1] - cy]), base: 0, top: h, height_m: h };
        }),
      };
    }
    return {
      label: '程序化街区',
      list: proceduralDistrict(params),
    };
  }

  async build() {
    if (this.exporting) { this.buildQueued = true; return; }
    const seq = ++this.buildSeq;
    const btn = $('#p-build', this.root);
    btn.disabled = true;
    btn.textContent = '生成中…';
    $('#p-export', this.root).disabled = true;
    this.building = true;
    let city = null;
    let ownedMaterials = [];
    try {
      const params = this._buildParams();
      $('#p-summary', this.root).textContent = '正在读取建筑轮廓与材质…';
      const { label, list } = await this._footprints(params);
      if (seq !== this.buildSeq) return;
      if (!list.length) throw new Error('当前来源没有可用的建筑轮廓，请更换来源或重新上传影像。');
      const { tile, materials } = params;
      const loaded = await Promise.all(materials.map(async (m) => ({ ...m, texture: await this._texture(m.url) })));
      if (seq !== this.buildSeq) return;
      const usable = loaded.filter((m) => m.texture);
      const texs = usable.map((m) => m.texture);
      const mats = usable.length ? usable.map((m) => facadeMaterial(m.texture, m)) : [new THREE.MeshStandardMaterial({ color: 0x8aa0b8, roughness: 0.6 })];
      const roofMat = new THREE.MeshStandardMaterial({ color: 0x526176, roughness: 0.85, metalness: 0.05 });
      ownedMaterials = [...mats, roofMat];
      const rand = mulberry32(1234);
      city = new THREE.Group();
      city.name = 'TwinCity';
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxTop = 0, totalArea = 0, totalFloors = 0;
      list.forEach((b, i) => {
        const { walls, roof } = buildingGeometry(b.ring, b.base, b.top, tile);
        const mat = mats[Math.floor(rand() * mats.length) % mats.length];
        const w = new THREE.Mesh(walls, mat);
        const rf = new THREE.Mesh(roof, roofMat);
        w.castShadow = rf.castShadow = true;
        w.receiveShadow = rf.receiveShadow = true;
        const bg = new THREE.Group();
        bg.name = `building_${b.id ?? i}`;
        bg.userData = { id: b.id ?? i, floors: b.floors, height_m: b.height_m, area_m2: b.area_m2, source: label };
        w.userData.building = bg.userData;
        rf.userData.building = bg.userData;
        bg.add(w, rf);
        city.add(bg);
        for (const p of b.ring) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
        maxTop = Math.max(maxTop, b.top);
        totalArea += Number(b.area_m2) || 0;
        totalFloors += Number(b.floors) || 0;
      });
      if (this.city) {
        this.g.scene.remove(this.city);
        this._disposeCity(this.city);
      }
      this.g.scene.add(city);
      this.city = city;
      this.cityMeta = { label, count: list.length, tile, textures: texs.length };
      $('#mod-pick', this.root).classList.add('hidden');
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const span = Math.max(40, maxX - minX, maxY - minY);
      this.g.ground.scale.set(span * 3, span * 3, 1);
      this.g.ground.position.set(cx, cy, -0.02);
      this.g.grid.scale.set(span * 3, 1, span * 3);
      this.g.grid.position.set(cx, cy, 0.01);
      const sun = this.g.sun;
      sun.position.set(cx - span * 0.8, cy - span * 1.1, Math.max(maxTop * 2.5, span * 1.2));
      sun.target.position.set(cx, cy, 0);
      const sc = sun.shadow.camera;
      sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 1; sc.far = span * 6;
      sc.updateProjectionMatrix();
      const d = span * 1.15;
      this.g.cam.position.set(cx - d * 0.75, cy - d * 0.95, Math.max(maxTop * 1.4, d * 0.65));
      this.g.ctl.target.set(cx, cy, maxTop * 0.2);
      this.g.cam.far = span * 20;
      this.g.cam.updateProjectionMatrix();
      this._applyNightWindows();
      $('#mod-title', this.root).textContent = `${label} · ${list.length} 栋`;
      $('#mod-metrics', this.root).innerHTML = `<span class="badge c">占地 ${Math.round(maxX - minX)}×${Math.round(maxY - minY)} m</span><span class="badge g">最高 ${maxTop.toFixed(1)} m</span><span class="badge v">${texs.length || 0} 种真实纹理</span><span class="badge">纹理尺度 ${tile} m</span>`;
      $('#mod-stats', this.root).textContent = `${list.length} 栋 · ${totalFloors} 层 · ${Math.round(totalArea)} m² 基底`;
      const failed = loaded.length - usable.length;
      $('#p-summary', this.root).textContent = `已生成 ${list.length} 栋建筑，使用 ${texs.length} 种立面纹理，尺度 ${tile} 米/块。${failed ? `有 ${failed} 种材质载入失败，已使用可用材质或纯色立面；点击“生成模型”可重试。` : ''}`;
    } catch (e) {
      if (city && city !== this.city) city.traverse((o) => o.geometry?.dispose());
      if (city !== this.city) ownedMaterials.forEach((m) => m.dispose());
      if (seq !== this.buildSeq) return;
      $('#p-summary', this.root).textContent = `生成失败：${e.message}${this.city ? ' 当前预览保留上次成功的模型。' : ''}`;
      toast(`建模失败：${e.message}`, 'err', 6000);
    } finally {
      if (seq === this.buildSeq) {
        this.building = false;
        btn.disabled = false;
        btn.textContent = '⬢ 生成模型';
        $('#p-export', this.root).disabled = !this.city || this.exporting;
      }
    }
  }

  _disposeCity(city) {
    const mats = new Set();
    city.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
    });
    mats.forEach((m) => m.dispose());
  }

  _applyNightWindows() {
    if (!this.city) return;
    const night = this.lightMode === 'night';
    const done = new Set();
    this.city.traverse((o) => {
      if (!o.isMesh || !o.material?.map || done.has(o.material)) return;
      done.add(o.material);
      o.material.emissive = new THREE.Color(night ? 0xffd9a0 : 0x000000);
      o.material.emissiveMap = night ? o.material.map : null;
      o.material.emissiveIntensity = night ? 0.55 : 0;
      o.material.needsUpdate = true;
    });
  }

  _pick(e) {
    if (!this.city) return;
    const rect = this.g.r.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.g.raycaster.setFromCamera(ndc, this.g.cam);
    const hit = this.g.raycaster.intersectObject(this.city, true)[0];
    const box = $('#mod-pick', this.root);
    if (!hit) { box.classList.add('hidden'); return; }
    const b = hit.object.userData.building || {};
    box.classList.remove('hidden');
    box.textContent = `建筑 #${b.id} · ${b.floors ?? '—'} 层 · ${Number(b.height_m || 0).toFixed(1)} m · 基底 ${b.area_m2 ?? '—'} m²`;
  }

  async exportGLB() {
    if (this.exporting || this.building || this.savingExport) return;
    if (!this.city) { toast('请先生成模型', 'err'); return; }
    const btn = $('#p-export', this.root);
    this.exporting = true;
    btn.disabled = true;
    btn.textContent = '导出中…';
    $('#p-build', this.root).disabled = true;
    const status = $('#p-export-status', this.root);
    status.textContent = '正在整理模型与纹理，请稍候…';
    try {
      const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
      const exporter = new GLTFExporter();
      // Export in a Y-up frame (glTF convention) without mutating the live scene.
      const root = new THREE.Group();
      root.rotation.x = -Math.PI / 2;
      const clone = this.city.clone(true);
      root.add(clone);
      root.updateMatrixWorld(true);
      const glb = await exporter.parseAsync(root, { binary: true, onlyVisible: true, maxTextureSize: 2048 });
      const blob = new Blob([glb], { type: 'model/gltf-binary' });
      const name = `twin_city_${stamp()}.glb`;
      downloadBlob(blob, name);
      this.lastExport = { name, blob };
      await this._saveLastExport();
    } catch (e) {
      status.textContent = `导出失败：${e.message}。可重新点击“导出 GLB”。`;
      toast(`导出失败：${e.message}`, 'err', 6000);
    } finally {
      this.exporting = false;
      btn.disabled = false;
      btn.textContent = '导出 GLB';
      $('#p-build', this.root).disabled = false;
      if (this.buildQueued) { this.buildQueued = false; this.build(); }
    }
  }

  async _saveLastExport() {
    if (this.savingExport || !this.lastExport) return;
    this.savingExport = true;
    $('#p-export', this.root).disabled = true;
    const { name, blob } = this.lastExport;
    const status = $('#p-export-status', this.root);
    status.textContent = `已发起下载 ${name}（${fmtBytes(blob.size)}），正在保存到项目…`;
    try {
      const saved = await api.saveExport(name, blob);
      status.innerHTML = `<div class="notice ok">已发起 GLB 下载，并保存到项目。<details class="r-logbox"><summary>文件详情</summary><span>${esc(saved.path || saved.name || name)}</span></details></div>`;
      await this._loadExports();
    } catch (e) {
      status.innerHTML = `<div class="notice warn">已发起 GLB 下载，项目保存失败：${esc(e.message)}<div class="btn-row"><button class="btn" id="p-save-retry">重试保存</button><button class="btn ghost" id="p-download-again">再次下载</button></div></div>`;
      $('#p-save-retry', this.root).addEventListener('click', () => this._saveLastExport());
      $('#p-download-again', this.root).addEventListener('click', () => downloadBlob(blob, name));
    } finally {
      this.savingExport = false;
      $('#p-export', this.root).disabled = this.exporting || this.building || !this.city;
    }
  }

  /* ------------------------------------------------------------------ image upload -> reconstruction */
  _reconLimits() {
    const l = this.system?.recon?.local?.limits || {};
    return {
      image: l.image_ext || ['.img', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'],
      dsm: l.dsm_ext || ['.tif', '.tiff'],
      maxMB: Number(l.max_mb) || 2048,
    };
  }

  _reconAvailable() {
    const s = this.system;
    return !!(s && (s.recon?.mode === 'local' ? s.recon?.local?.available : s.legacy?.up && s.remote?.up));
  }

  _reconBusy() {
    return ['uploading', 'starting', 'running', 'waiting'].includes(this.recon?.phase);
  }

  _bindRecon() {
    const R = this.root;
    this.recon = { image: null, dsm: null, jobId: null, mode: null, phase: 'idle', started: false, abort: null, timer: 0, last: '', fails: 0 };
    for (const kind of ['image', 'dsm']) {
      const zone = $(`#r-drop-${kind}`, R);
      const input = $(`#r-${kind}`, R);
      zone.addEventListener('click', (e) => {
        if (e.target === input) return;
        if (e.target.closest('.dz-remove')) { e.stopPropagation(); if (!this._reconBusy()) this._setReconFile(kind, null); return; }
        if (!this._reconBusy()) input.click();
      });
      zone.addEventListener('keydown', (e) => {
        if (e.target === zone && (e.key === 'Enter' || e.key === ' ') && !this._reconBusy()) { e.preventDefault(); input.click(); }
      });
      input.addEventListener('change', () => {
        const f = input.files[0];
        input.value = '';
        if (f) this._setReconFile(kind, f);
      });
      zone.addEventListener('dragover', (e) => { e.preventDefault(); if (!this._reconBusy()) zone.classList.add('over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        if (this._reconBusy()) return;
        const files = [...(e.dataTransfer?.files || [])];
        if (!files.length) return;
        if (files.length > 1) toast('每个位置只接受一个文件，已使用第一个', 'info', 4000);
        this._setReconFile(kind, files[0]);
      });
    }
    $('#r-submit', R).addEventListener('click', () => this.submitRecon());
    $('#r-cancel', R).addEventListener('click', () => this.cancelRecon());
    $('#r-reset', R).addEventListener('click', () => this._resetRecon());
    $('#r-refresh', R).addEventListener('click', () => this._loadReconJobs());
    $('#recon-status', R).addEventListener('click', (e) => { if (e.target.closest('[data-recheck]')) this._loadSystem(); });
    $('#r-jobs', R).addEventListener('click', (e) => this._onJobAction(e));
    $('#r-result', R).addEventListener('click', (e) => this._onJobAction(e));
    window.addEventListener('beforeunload', (e) => {
      if (this.recon.phase === 'uploading') { e.preventDefault(); e.returnValue = ''; }
    });
    this._renderSteps(-1);
    this._renderReconMode();
  }

  async _setReconFile(kind, file) {
    if (this._reconBusy()) return;
    const seq = ++this.fileSeq[kind];
    const st = this.recon;
    if (st[kind]?.url) URL.revokeObjectURL(st[kind].url);
    st[kind] = null;
    if (file) {
      st[kind] = { file, pending: true, ext: (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase(), url: '' };
      this._renderReconFile(kind);
      this._renderReconMode();
      const chk = await this._checkReconFile(kind, file);
      if (seq !== this.fileSeq[kind]) { if (chk.url) URL.revokeObjectURL(chk.url); return; }
      st[kind] = { file, ...chk };
    }
    this._renderReconFile(kind);
    this._renderReconMode();
  }

  async _checkReconFile(kind, file) {
    const lim = this._reconLimits();
    const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    const allowed = kind === 'image' ? lim.image : lim.dsm;
    const other = this.recon[kind === 'image' ? 'dsm' : 'image']?.file;
    const res = { ext, family: null, error: '', warn: '', url: '' };
    if (!allowed.includes(ext)) {
      res.error = kind === 'image'
        ? `不支持的格式「${ext || '无扩展名'}」，请选择 ${allowed.map((e) => e.slice(1).toUpperCase()).join(' / ')}`
        : `DSM 必须是 GeoTIFF（.tif / .tiff），当前为「${ext || '无扩展名'}」`;
    } else if (!file.size) res.error = '文件为空（0 字节）';
    else if (file.size > lim.maxMB * 1048576) res.error = `文件 ${fmtBytes(file.size)}，超过上限 ${lim.maxMB} MB`;
    else if (other && other.name === file.name && other.size === file.size && other.lastModified === file.lastModified) res.error = '影像和 DSM 不能是同一个文件';
    if (!res.error) {
      try {
        res.family = sniffFamily(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
      } catch (e) {
        res.error = `无法读取文件：${e.message}`;
      }
      if (!res.error && !(EXT_FAMILY[ext] || []).includes(res.family)) {
        res.error = `文件内容与扩展名不符：检测到 ${FAMILY_LABEL[res.family] || '未知格式'}，扩展名为 ${ext}`;
      }
    }
    if (!res.error && kind === 'image') {
      if (['jpeg', 'png', 'webp'].includes(res.family)) res.url = URL.createObjectURL(file);
      if (file.size > 300 * 1048576) res.warn = '文件较大，上传与处理可能需要数分钟';
    }
    return res;
  }

  _renderReconFile(kind) {
    const zone = $(`#r-drop-${kind}`, this.root);
    const f = this.recon[kind];
    zone.classList.toggle('has-file', !!f);
    zone.classList.toggle('invalid', !!f?.error);
    $('.dz-empty', zone).classList.toggle('hidden', !!f);
    const box = $('.dz-file', zone);
    box.classList.toggle('hidden', !f);
    if (!f) { box.innerHTML = ''; return; }
    const badge = (FAMILY_LABEL[f.family] || f.ext.slice(1) || '?').toUpperCase().slice(0, 5);
    const thumb = f.url ? `<img class="dz-thumb" src="${f.url}" alt="">` : `<div class="dz-thumb dz-icon">${esc(badge)}</div>`;
    const state = f.pending ? '<span class="muted">正在检查文件内容…</span>' : f.error ? `<span class="dz-err">✕ ${esc(f.error)}</span>` : `<span class="dz-ok">✓ 文件格式检查通过${f.warn ? ` · ${esc(f.warn)}` : ''}</span>`;
    box.innerHTML = `${thumb}<div class="dz-meta"><b title="${esc(f.file.name)}">${esc(f.file.name)}</b><span>${fmtBytes(f.file.size)} · ${esc(FAMILY_LABEL[f.family] || f.ext || '未知格式')}</span>${state}</div><button type="button" class="dz-remove" title="移除" aria-label="移除文件">×</button>`;
  }

  _renderReconMode() {
    const st = this.recon;
    const local = this.system?.recon?.mode === 'local';
    const img = st.image;
    const dsm = st.dsm;
    let html;
    if (!img) html = '<span class="muted">先选择一张影像；DSM 可选。</span>';
    else if (img.pending || dsm?.pending) html = '<span class="muted">正在检查文件，请稍候…</span>';
    else if (img.error || dsm?.error) html = '<span class="r-tag bad">文件未通过校验</span>请替换或移除有问题的文件';
    else if (!this._reconAvailable()) html = '<span class="r-tag warn">等待服务就绪</span>文件已选择，恢复重建服务后可提交。';
    else if (!local) html = `<span class="r-tag ok">远端 3DGS</span>影像${dsm ? ' + DSM' : ''}将上传到 web3d 服务并派发训练`;
    else if (dsm) html = '<span class="r-tag ok">影像 + DSM</span>本机直建：真实高程的地表、屋顶与立面面元，并提取建筑属性';
    else html = '<span class="r-tag warn">仅影像 · 降级</span>本机只生成平坦地表面元，不含建筑高度；附上 DSM 可得到真实建筑';
    $('#r-mode', this.root).innerHTML = html;
    this._syncReconButtons();
  }

  _renderReconStatus() {
    const s = this.system;
    const rs = $('#recon-status', this.root);
    const lim = this._reconLimits();
    $$('.r-max', this.root).forEach((el) => { el.textContent = String(lim.maxMB); });
    if (!s) { rs.className = 'notice bad'; rs.textContent = '无法读取系统状态，暂时不能提交重建任务。'; }
    else if (s.recon?.mode === 'local') {
      const lr = s.recon.local || {};
      const host = s.remote?.host ? `${esc(s.remote.host)}${s.remote.port ? `:${esc(s.remote.port)}` : ''}` : '远端主机';
      if (lr.available) {
        rs.className = 'notice warn';
        rs.innerHTML = `<b>影像建模可用</b><p>附加 DSM 可生成真实建筑高度、屋顶与立面；仅上传影像时生成平坦地表。结果将加入场景模型库。</p><details class="r-logbox"><summary>处理方式与限制</summary>远端 3DGS 主机 ${host} ${s.remote?.up ? '可达，但重建服务不在线' : '不可达'}，已切换为本机直建。本机方式不做 SfM / 3DGS 光度优化，不等同于远端训练结果。</details>`;
      } else { rs.className = 'notice bad'; rs.textContent = `远端重建主机不可达，本机直建也不可用：${lr.reason || '未知原因'}`; }
    }
    else if (!s.legacy?.up) { rs.className = 'notice bad'; rs.textContent = `本机旧版服务 ${s.legacy?.url || ''} 未运行，无法派发重建任务。`; }
    else if (!s.remote?.up) { rs.className = 'notice bad'; rs.innerHTML = `本机 8080 服务在线，但远端重建主机 <b>${esc(s.remote?.host)}:${esc(s.remote?.port)}</b> 当前不可达，提交的任务会失败。恢复网络连接后即可使用。`; }
    else { rs.className = 'notice ok'; rs.innerHTML = `重建链路就绪：本机 8080 在线，远端 <b>${esc(s.remote.host)}</b> 可达，将执行完整 3DGS 训练。`; }
    rs.insertAdjacentHTML('beforeend', '<div class="btn-row"><button class="btn ghost" data-recheck>重新检查服务</button></div>');
    this._renderReconMode();
  }

  _syncReconButtons() {
    const R = this.root;
    const st = this.recon;
    if (!st) return;
    const busy = this._reconBusy();
    const ready = st.image && !st.image.pending && !st.dsm?.pending && !st.image.error && !st.dsm?.error;
    const sub = $('#r-submit', R);
    sub.disabled = busy || !ready || !this._reconAvailable();
    sub.textContent = busy ? (st.phase === 'uploading' ? '上传中…' : st.phase === 'waiting' ? '等待恢复查询' : '重建中…') : (st.phase === 'error' ? '重新提交' : '开始重建');
    $('#r-cancel', R).classList.toggle('hidden', !(st.phase === 'uploading' || (['starting', 'running', 'waiting'].includes(st.phase) && st.mode === 'local')));
    $('#r-cancel', R).disabled = !!st.cancelRequested;
    $('#r-cancel', R).textContent = st.cancelRequested ? '正在取消…' : '取消任务';
    $('#r-reset', R).disabled = busy;
    for (const k of ['image', 'dsm']) $(`#r-drop-${k}`, R).classList.toggle('locked', busy);
    $('#r-title', R).disabled = busy;
    $('#r-width', R).disabled = busy;
  }

  _renderSteps(active, state = '') {
    const last = RECON_STEPS.length - 1;
    $('#r-steps', this.root).innerHTML = RECON_STEPS.map((t, i) => {
      let c = '';
      if (i < active || (i === last && active === last && state !== 'bad')) c = 'done';
      else if (i === active) c = state || 'active';
      return `<li class="${c}"><i>${c === 'done' ? '✓' : c === 'bad' ? '!' : i + 1}</i><span>${t}</span></li>`;
    }).join('');
  }

  _setProgress(pct, text = '', kind = '') {
    const bar = $('#r-prog', this.root);
    bar.style.width = `${Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0}%`;
    bar.parentElement.classList.toggle('bad', kind === 'bad');
    bar.parentElement.classList.toggle('ok', kind === 'ok');
    $('#r-prog-text', this.root).textContent = text;
  }

  _say(t) {
    const log = $('#r-log', this.root);
    if (log.dataset.fresh !== '1') { log.textContent = ''; log.dataset.fresh = '1'; }
    log.textContent += `${log.textContent ? '\n' : ''}${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  ${t}`;
    log.scrollTop = log.scrollHeight;
  }

  _clearLog() {
    const log = $('#r-log', this.root);
    log.textContent = '';
    log.dataset.fresh = '1';
  }

  async submitRecon() {
    const R = this.root;
    const st = this.recon;
    if (this._reconBusy()) return;
    if (!this._reconAvailable()) { toast('重建链路不可用，请查看上方状态说明', 'err'); return; }
    if (!st.image) { toast('请先选择影像文件', 'err'); return; }
    if (st.image.pending || st.dsm?.pending) { toast('文件仍在检查中，请稍候', 'info'); return; }
    if (st.image.error || st.dsm?.error) { toast('有文件未通过校验，请替换后再提交', 'err'); return; }
    const width = Number($('#r-width', R).value);
    if (!Number.isFinite(width) || width < 5 || width > 5000) { toast('场景宽度需在 5–5000 米之间', 'err'); $('#r-width', R).focus(); return; }
    const title = $('#r-title', R).value.trim().slice(0, 60);
    const img = st.image.file;
    const dsm = st.dsm?.file || null;
    st.mode = this.system?.recon?.mode === 'local' ? 'local' : 'remote';
    ++this.reconPollSeq;
    ++this.jobActionSeq;
    st.jobId = null; st.started = false; st.last = ''; st.fails = 0; st.cancelRequested = false;
    $('#r-result', R).innerHTML = '';
    this._clearLog();
    $('#r-logbox', R).open = false;
    st.phase = 'uploading';
    this._syncReconButtons();
    this._renderSteps(0);
    const total = img.size + (dsm ? dsm.size : 0);
    const onProgress = (base) => (loaded) => {
      const done = Math.min(total, base + loaded);
      if (st.cancelRequested) return;
      this._setProgress((done / total) * 10, `上传 ${Math.round((done / total) * 100)}% · ${fmtBytes(done)} / ${fmtBytes(total)}${done === total ? ' · 等待服务器确认文件…' : ''}`);
    };
    this._setProgress(0, '准备上传…');
    try {
      this._say(`上传影像 ${img.name}（${fmtBytes(img.size)}）`);
      const up = await api.reconUploadXHR(img, 'image', { width, title }, { onProgress: onProgress(0), handle: st });
      st.abort = null;
      if (!up.id) throw new Error('服务器未返回影像任务编号，请刷新最近任务确认上传结果。');
      st.jobId = up.id;
      if (st.cancelRequested) { this._failRecon('已保存的影像可在最近任务中查看，尚未启动重建。', { cancelled: true, uploadStopped: true }); return; }
      this._say(`影像已保存：任务 ${up.id}${up.format ? ` · ${up.format}` : ''}`);
      if (up.duplicate_of) this._say(`提示：这张影像与任务 ${up.duplicate_of} 完全相同`);
      let started;
      if (dsm) {
        this._say(`上传 DSM ${dsm.name}（${fmtBytes(dsm.size)}）`);
        started = await api.reconUploadXHR(dsm, 'dsm', { id: up.id, width, title }, { onProgress: onProgress(img.size), handle: st });
      } else {
        st.phase = 'starting';
        this._syncReconButtons();
        started = await api.reconStart({ id: up.id, width, title });
      }
      st.abort = null;
      if (st.cancelRequested && st.mode === 'local') {
        try { await api.reconCancel(started.id || up.id); this._say('已请求取消任务，正在确认状态…'); }
        catch (e) { st.cancelRequested = false; this._say(`取消未确认：${e.message}，继续查询任务。`); }
      }
      this._say(st.mode === 'local' ? `本机直建已启动（${dsm ? '影像 + DSM' : '仅影像 · 平坦地表'}，不做 SfM / 光度优化）` : `远端任务已派发：${started.id || up.id}`);
      this._renderSteps(1);
      this._pollRecon(started.id || up.id);
    } catch (e) {
      st.abort = null;
      // A DSM upload or start request can reach the server before its response is lost.
      // Reconcile the known job before claiming the processing has stopped.
      if (st.jobId && st.mode === 'local') {
        let known = null;
        try { known = await api.reconJob(st.jobId); } catch (_) { /* no confirmed job state */ }
        if (known && ['running', 'done', 'error', 'cancelled'].includes(known.status)) {
          this._say(`传输响应中断：${e.message}。已找到服务器任务，继续确认状态。`);
          if (st.cancelRequested && known.status === 'running') {
            try { await api.reconCancel(st.jobId); }
            catch (cancelError) { st.cancelRequested = false; this._say(`取消未确认：${cancelError.message}`); }
          }
          this._pollRecon(st.jobId);
          return;
        }
      }
      this._failRecon(e.aborted ? '已停止传输；服务器可能已接收文件，请刷新最近任务确认。' : e.message, { cancelled: !!e.aborted, uploadStopped: !!e.aborted });
    } finally {
      this._loadReconJobs();
    }
  }

  async cancelRecon() {
    const st = this.recon;
    if (st.cancelRequested) return;
    if (st.phase === 'uploading') {
      st.cancelRequested = true;
      this._syncReconButtons();
      st.abort?.();
      return;
    }
    if (st.phase === 'starting' && st.mode === 'local') {
      st.cancelRequested = true;
      this._syncReconButtons();
      this._say('已请求取消，将在服务器确认启动后停止任务。');
      return;
    }
    if (['running', 'waiting'].includes(st.phase) && st.jobId && st.mode === 'local') {
      const id = st.jobId;
      const actionSeq = this.jobActionSeq;
      st.cancelRequested = true;
      this._syncReconButtons();
      try {
        await api.reconCancel(id);
        if (st.jobId !== id || actionSeq !== this.jobActionSeq || st.phase === 'done') return;
        this._say('已请求取消，等待进程退出…');
        this._pollRecon(id);
      } catch (e) {
        if (st.jobId !== id || actionSeq !== this.jobActionSeq) return;
        st.cancelRequested = false;
        toast(`取消失败：${e.message}`, 'err', 6000);
      } finally {
        this._syncReconButtons();
      }
    }
  }

  _resetRecon() {
    if (this._reconBusy()) return;
    ++this.reconPollSeq;
    ++this.jobActionSeq;
    clearTimeout(this.recon.timer);
    this._setReconFile('image', null);
    this._setReconFile('dsm', null);
    $('#r-title', this.root).value = '';
    $('#r-result', this.root).innerHTML = '';
    Object.assign(this.recon, { phase: 'idle', jobId: null, started: false, last: '', cancelRequested: false });
    this._renderSteps(-1);
    this._setProgress(0, '');
    const log = $('#r-log', this.root);
    log.textContent = '尚未提交任务。';
    log.dataset.fresh = '';
    this._syncReconButtons();
  }

  _failRecon(msg, { cancelled = false, uploadStopped = false } = {}) {
    const st = this.recon;
    ++this.reconPollSeq;
    clearTimeout(st.timer);
    st.phase = cancelled ? 'cancelled' : 'error';
    st.cancelRequested = false;
    this._say(`${cancelled ? '已取消' : '失败'}：${msg}`);
    const cur = $$('#r-steps li', this.root).findIndex((li) => !li.classList.contains('done'));
    this._renderSteps(cur < 0 ? 0 : cur, 'bad');
    const stateLabel = uploadStopped ? '上传已停止' : '任务已取消';
    this._setProgress(0, cancelled ? stateLabel : `失败：${msg}`, 'bad');
    const retryId = st.started && st.mode === 'local' ? st.jobId : null;
    $('#r-result', this.root).innerHTML = `<div class="notice ${cancelled ? 'warn' : 'bad'} r-fail"><div>${esc(cancelled ? `${stateLabel}。${msg}` : msg)}</div><div class="btn-row">${retryId ? `<button class="btn" data-act="retry" data-id="${esc(retryId)}">重试此任务</button>` : ''}<button class="btn ghost" data-act="resubmit">重新上传并提交</button></div></div>`;
    if (!cancelled) toast(`重建失败：${msg}`, 'err', 7000);
    this._syncReconButtons();
  }

  _pollRecon(id, { resumed = false } = {}) {
    const st = this.recon;
    const seq = ++this.reconPollSeq;
    clearTimeout(st.timer);
    Object.assign(st, { jobId: id, phase: 'running', started: true, fails: 0 });
    this._syncReconButtons();
    if (resumed) this._say(`继续跟踪任务 ${id}`);
    const current = () => seq === this.reconPollSeq && st.jobId === id && st.phase === 'running' && this._canPoll();
    const tick = async () => {
      if (!current()) return;
      let s;
      try {
        s = await api.reconJob(id);
        if (!current()) return;
        st.fails = 0;
      } catch (e) {
        if (!current()) return;
        st.fails += 1;
        if (st.fails === 1 || st.fails % 5 === 0) this._say(`查询状态失败（第 ${st.fails} 次）：${e.message}`);
        if (st.fails >= 5) {
          st.phase = 'waiting';
          st.cancelRequested = false;
          $('#r-result', this.root).innerHTML = `<div class="notice warn">暂时无法查询任务，后台任务可能仍在运行。${esc(e.message)}<div class="btn-row"><button class="btn" data-act="reconnect">重新查询进度</button></div></div>`;
          this._syncReconButtons();
          return;
        }
        st.timer = setTimeout(tick, 3000);
        return;
      }
      if (!current()) return;
      if (s.mode === 'local') st.mode = 'local';
      const raw = Number(s.progress ?? s.pct ?? 0) || 0;
      const pct = Math.max(0, Math.min(100, st.mode === 'local' || s.pct != null || raw > 1 ? raw : raw * 100));
      const label = STAGE_LABEL[s.stage] || s.stage || s.status || '';
      const msg = s.msg || s.message || '';
      const line = msg && msg !== label ? `${label} · ${msg}` : label;
      if (line && line !== st.last) { this._say(line); st.last = line; }
      if (s.status === 'done' || s.done === true) {
        st.phase = 'done';
        st.cancelRequested = false;
        this._renderSteps(RECON_STEPS.length - 1);
        this._setProgress(100, `完成${Number.isFinite(Number(s.elapsed)) ? ` · 用时 ${Number(s.elapsed).toFixed(1)} s` : ''}`, 'ok');
        this._renderResult(s);
        this._syncReconButtons();
        toast(s.mode === 'local' ? '本机直建完成，模型已加入模型库' : '重建完成，模型已加入模型库', 'ok', 6000);
        this._afterReconDone();
        return;
      }
      if (s.status === 'error' || s.status === 'cancelled' || s.cancelled) {
        (s.log_tail || []).slice(-6).forEach((t) => this._say(`│ ${t}`));
        this._failRecon(s.error || msg || '未知错误', { cancelled: !!s.cancelled || s.status === 'cancelled' });
        this._loadReconJobs();
        return;
      }
      const step = STAGE_STEP[s.stage] ?? (pct >= 85 ? 4 : pct >= 50 ? 3 : pct >= 20 ? 2 : 1);
      this._renderSteps(Math.min(Math.max(step, 1), RECON_STEPS.length - 2));
      this._setProgress(10 + pct * 0.9, `${label || '处理中'} · ${Math.round(pct)}%`);
      st.timer = setTimeout(tick, 1500);
    };
    tick();
  }

  async _afterReconDone() {
    window.dispatchEvent(new CustomEvent('twin:models-changed'));
    await this._loadBuildingSources();
    this._loadReconJobs();
  }

  _noBuildingContours(result) {
    const count = result.counts?.buildings;
    return result.flat === true || (count != null && count !== '' && Number(count) === 0);
  }

  _renderResult(s) {
    const noContours = this._noBuildingContours(s);
    let stem = '';
    try { stem = s.buildings_url ? decodeURIComponent(String(s.buildings_url).split('/').pop()) : ''; } catch (_) { stem = ''; }
    const counts = s.counts && typeof s.counts === 'object'
      ? Object.entries(s.counts).filter(([, v]) => v !== null && v !== '' && Number.isFinite(Number(v))).slice(0, 6) : [];
    const tag = s.mode === 'local' ? (s.flat ? ['warn', '仅影像 · 平坦地表'] : ['ok', '影像 + DSM 直建']) : ['ok', '远端 3DGS'];
    const note = s.mode === 'local'
      ? `<p class="muted small">${s.flat ? '未提供 DSM：只生成平坦地表影像面元，不含建筑高度与立面。' : ''}本机直建未做 SfM / 3DGS 光度优化，不等同于远端训练结果。</p>` : '';
    $('#r-result', this.root).innerHTML = `<div class="card r-done">
      ${s.preview ? `<img class="r-preview" src="${esc(s.preview)}" alt="重建预览" data-act="zoom">` : ''}
      <div class="r-done-head"><b title="${esc(s.model || '')}">${esc(s.title || s.model || s.id || '')}</b><span class="r-tag ${tag[0]}">${tag[1]}</span></div>
      ${counts.length ? `<div class="r-kpis">${counts.map(([k, v]) => `<div><b>${esc(fmtNum(Number(v)))}</b><span>${esc(COUNT_LABEL[k] || k)}</span></div>`).join('')}</div>` : ''}
      ${note}
      ${noContours ? '<p class="muted small">本次结果没有可用的建筑轮廓。可补充或检查 DSM 后重新重建；也可使用程序化建模页的参数街区功能。</p>' : ''}
      <div class="r-actions">
        ${s.scene_url ? `<button class="btn primary" data-act="scene" data-url="${esc(s.scene_url)}">◉ 场景渲染</button>` : ''}
        ${stem && !noContours ? `<button class="btn" data-act="proc" data-stem="${esc(stem)}">⬢ 以该轮廓建模</button>` : ''}
        <button class="btn" data-act="material">材质生成</button>
        ${s.splat_url ? `<a class="btn ghost" href="${esc(s.splat_url)}" download>下载 .splat</a>` : ''}
        ${s.buildings_url ? `<a class="btn ghost" href="${esc(s.buildings_url)}" target="_blank" rel="noopener">建筑 JSON</a>` : ''}
      </div></div>`;
  }

  async _useBuildings(stem) {
    await this._loadBuildingSources();
    const sel = $('#p-source', this.root);
    const v = `bld:${stem}`;
    if (![...sel.options].some((o) => o.value === v)) { toast('模型库里还没有这组建筑数据，请稍后刷新', 'err'); return; }
    sel.value = v;
    sel.dispatchEvent(new Event('change'));
    this._showTab('proc');
    toast('已载入重建得到的建筑轮廓，可调整材质与光照后导出 GLB', 'ok', 5000);
  }

  _trackJob(id) {
    if (this._reconBusy()) return;
    ++this.jobActionSeq;
    this.recon.mode = 'local';
    this.recon.last = '';
    $('#r-result', this.root).innerHTML = '';
    this._clearLog();
    this._renderSteps(1);
    this._pollRecon(id, { resumed: true });
  }

  async _loadReconJobs() {
    const seq = ++this.jobsSeq;
    const box = $('#r-jobs', this.root);
    if (!box) return;
    let jobs;
    try {
      jobs = (await api.reconJobs()).jobs || [];
      if (seq !== this.jobsSeq) return;
    } catch (e) {
      if (seq !== this.jobsSeq) return;
      box.innerHTML = `<span class="dz-err">无法读取任务列表：${esc(e.message)}</span>`;
      return;
    }
    if (!jobs.length) { box.textContent = '还没有上传过影像。'; return; }
    box.innerHTML = jobs.map((j) => {
      const [cls, label] = j.cancelled ? ['warn', '已取消'] : (JOB_STATUS[j.status] || ['', j.status || '未知']);
      const pct = j.status === 'running' && Number.isFinite(Number(j.progress)) ? ` ${Math.round(Number(j.progress))}%` : '';
      const acts = [];
      if (j.status === 'done') {
        acts.push(`<button class="btn ghost" data-act="show" data-id="${esc(j.id)}">结果</button>`);
        if (j.scene_url) acts.push(`<button class="btn ghost" data-act="scene" data-url="${esc(j.scene_url)}">场景</button>`);
        if (j.buildings_url && !this._noBuildingContours(j)) {
          let stem = '';
          try { stem = decodeURIComponent(String(j.buildings_url).split('/').pop()); } catch (_) { stem = ''; }
          if (stem) acts.push(`<button class="btn ghost" data-act="proc" data-stem="${esc(stem)}">以该轮廓建模</button>`);
        }
        if (this._noBuildingContours(j)) acts.push('<span class="muted small">暂无建筑轮廓，可补充或检查 DSM 后重建。</span>');
      } else if (j.purged) acts.push('<span class="muted small">原始影像已超过保留期被清理，请重新上传</span>');
      else if (j.status === 'error') acts.push(`<button class="btn ghost" data-act="retry" data-id="${esc(j.id)}">重试</button>`);
      else if (j.status === 'uploaded') acts.push(`<button class="btn ghost" data-act="start" data-id="${esc(j.id)}">启动${j.flat ? '（仅影像）' : ''}</button>`);
      else if (j.status === 'running' && this.recon.jobId !== j.id) acts.push(`<button class="btn ghost" data-act="track" data-id="${esc(j.id)}">跟踪进度</button>`);
      const sub = [j.id, j.created ? String(j.created).slice(5, 16) : '', j.image_size ? fmtBytes(j.image_size) : ''].filter(Boolean).join(' · ');
      return `<div class="r-job"><div class="r-job-main"><b title="${esc(j.image_name || '')}">${esc(j.title || j.image_name || j.id)}</b><span>${esc(sub)}</span></div><div class="r-job-tags"><span class="r-tag ${cls}"${j.error ? ` title="${esc(j.error)}"` : ''}>${esc(label)}${pct}</span><span class="r-tag ${j.flat ? 'warn' : ''}">${j.flat ? '仅影像' : '含 DSM'}</span></div>${acts.length ? `<div class="r-job-act">${acts.join('')}</div>` : ''}</div>`;
    }).join('');
    const run = jobs.find((j) => j.status === 'running');
    if (run && this.recon.phase === 'idle') this._trackJob(run.id);
  }

  async _onJobAction(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'zoom') { lightbox(b.src); return; }
    if (act === 'scene') { location.hash = b.dataset.url; return; }
    if (act === 'proc') { await this._useBuildings(b.dataset.stem); return; }
    if (act === 'material') { this._showTab('agent'); return; }
    if (act === 'resubmit') { this.submitRecon(); return; }
    if (act === 'reconnect') {
      if (this.recon.jobId) { $('#r-result', this.root).innerHTML = ''; this._pollRecon(this.recon.jobId, { resumed: true }); }
      return;
    }
    if (act === 'track') { this._trackJob(b.dataset.id); return; }
    if (this._reconBusy()) { toast('已有任务在进行，请等待完成或先取消', 'info'); return; }
    if (act === 'show') {
      const seq = ++this.jobActionSeq;
      try {
        const s = await api.reconJob(b.dataset.id);
        if (seq !== this.jobActionSeq || this._reconBusy()) return;
        Object.assign(this.recon, { jobId: s.id || b.dataset.id, phase: 'done' });
        this._renderSteps(RECON_STEPS.length - 1);
        this._setProgress(100, `任务 ${this.recon.jobId} · 已完成`, 'ok');
        this._renderResult(s);
        this._syncReconButtons();
        $('#r-result', this.root).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (err) {
        toast(`读取任务失败：${err.message}`, 'err');
      }
      return;
    }
    if (act === 'retry' || act === 'start') {
      const id = b.dataset.id;
      ++this.jobActionSeq;
      Object.assign(this.recon, { phase: 'starting', mode: 'local', jobId: id, cancelRequested: false });
      this._syncReconButtons();
      b.disabled = true;
      try {
        const r = await api.reconStart({ id });
        if (this.recon.cancelRequested) {
          try { await api.reconCancel(id); } catch (e) { this.recon.cancelRequested = false; this._say(`取消未确认：${e.message}`); }
        }
        Object.assign(this.recon, { mode: 'local', last: '' });
        $('#r-result', this.root).innerHTML = '';
        this._clearLog();
        this._say(`${act === 'retry' ? '重试' : '启动'}任务 ${id}${r.flat ? '（仅影像 · 平坦地表）' : ''}`);
        this._renderSteps(1);
        this._pollRecon(id);
      } catch (err) {
        this.recon.phase = 'error';
        this.recon.cancelRequested = false;
        toast(`启动失败：${err.message}`, 'err', 6000);
      } finally {
        b.disabled = false;
        this._syncReconButtons();
        this._loadReconJobs();
      }
    }
  }

  /* ------------------------------------------------------------------ material agent */
  async _checkAgent() {
    // Re-read the status on click so weights added after page load are picked up.
    const btn = $('#g-run', this.root);
    const as = $('#agent-status', this.root);
    btn.disabled = true;
    try {
      try { this.system = await api.system(); }
      catch (e) {
        as.className = 'notice bad';
        as.textContent = `暂时无法检查生成条件：${e.message}。恢复连接后可重新点击生成。`;
        return false;
      }
      const ag = this.system?.agent;
      if (ag?.can_generate) {
        as.className = 'notice ok';
        as.textContent = '本地材质生成条件已确认，正在准备项目任务。';
        return true;
      }
      as.className = 'notice bad';
      if (!ag) as.textContent = '无法读取材质 Agent 状态。';
      else as.innerHTML = `本地暂时不能生成：${esc(ag.reason || '')}`;
      as.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return false;
    } finally {
      btn.disabled = ['checking', 'starting', 'running', 'waiting'].includes(this.agent.phase);
    }
  }

  async runAgent() {
    if (['checking', 'starting', 'running', 'waiting'].includes(this.agent.phase)) return;
    const R = this.root;
    const log = $('#g-log', R);
    const st = this.agent;
    st.phase = 'checking';
    $('#g-run', R).disabled = true;
    try {
      const params = {
        lat: this._number('#g-lat', '纬度', -90, 90), lon: this._number('#g-lon', '经度', -180, 180),
        rounds: this._number('#g-rounds', '迭代轮数', 1, 6, true), seeds: this._number('#g-seeds', '每轮候选数', 1, 16, true),
      };
      if (!(await this._checkAgent())) { st.phase = 'idle'; return; }
      st.phase = 'starting';
      log.textContent = '启动中…';
      $('#g-progress', R).textContent = '正在提交材质生成任务…';
      const { job_id: jid } = await api.agentRun(params);
      if (!jid) throw new Error('服务器未返回材质任务编号，请检查生成日志。');
      Object.assign(st, { id: jid, phase: 'running', fails: 0 });
      this._pollAgent();
    } catch (e) {
      st.phase = 'error';
      log.textContent = `失败：${e.message}`;
      $('#g-progress', R).textContent = `生成未启动：${e.message}`;
    } finally {
      $('#g-run', R).disabled = ['checking', 'starting', 'running', 'waiting'].includes(st.phase);
    }
  }

  _pollAgent() {
    const st = this.agent;
    const seq = ++this.agentPollSeq;
    const id = st.id;
    clearTimeout(st.timer);
    const current = () => seq === this.agentPollSeq && st.id === id && st.phase === 'running' && this._canPoll();
    $('#g-run', this.root).disabled = true;
    $('#g-resume', this.root).classList.add('hidden');
    const tick = async () => {
      if (!current()) return;
      let s;
      try {
        s = await api.agentJob(id);
        if (!current()) return;
        st.fails = 0;
      } catch (e) {
        if (!current()) return;
        st.fails++;
        $('#g-progress', this.root).textContent = `暂时无法查询生成进度：${e.message}。后台任务可能仍在运行。`;
        if (st.fails >= 5) { st.phase = 'waiting'; $('#g-resume', this.root).classList.remove('hidden'); return; }
        st.timer = setTimeout(tick, 3000);
        return;
      }
      const log = $('#g-log', this.root);
      log.textContent = (s.log_tail || []).join('\n') || s.status;
      log.scrollTop = log.scrollHeight;
      if (['running', 'queued', 'starting', 'pending'].includes(s.status)) {
        $('#g-progress', this.root).textContent = '项目材质生成中，可切换页面；返回后会继续查询进度。';
        st.timer = setTimeout(tick, 2500);
        return;
      }
      st.phase = s.status === 'done' ? 'done' : 'error';
      $('#g-run', this.root).disabled = false;
      if (s.status === 'done') {
        $('#g-progress', this.root).innerHTML = `生成完成，结果已加入项目材质库。<a class="btn ghost" href="#/material${s.run_id ? `/${encodeURIComponent(s.run_id)}` : ''}">查看材质</a>`;
        this._loadTextures();
        window.dispatchEvent(new CustomEvent('twin:materials-changed'));
        toast('项目材质生成完成', 'ok', 6000);
      } else {
        $('#g-progress', this.root).textContent = `生成失败：${s.error || s.message || s.status}。展开日志查看原因，处理后可重试。`;
      }
    };
    tick();
  }
}
