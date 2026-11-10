// Material workshop: browse material-agent runs, inspect scores, seamless tiling, and a 3D facade preview.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { api } from './api.js';
import { $, $$, esc, fmtScore, scoreClass, toast, lightbox } from './ui.js';
import { buildingGeometry, facadeMaterial } from './buildings.js';

const CRIT_LABELS = { structure: '结构', material: '材质', color: '颜色', quality: '质量', tileable: '可平铺', fidelity: '保真', realism: '真实感', environment: '环境', completeness: '完整度', cleanliness: '干净度', focus: '主体聚焦' };

export class MaterialView {
  constructor(root) {
    this.root = root;
    this.runs = [];
    this.current = null;
    this.filter = 'agent';
    this.tiled = true;
    this.inited = false;
    this.detailSeq = 0;
    this.textureSeq = 0;
    this.listSeq = 0;
    this.active = true;
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
        <div class="panel-head"><h2>项目材质</h2><span class="muted" id="run-count">—</span><button class="btn ghost" id="m-refresh">刷新</button></div>
        <div class="filter-chips" id="run-filters">
          <button class="fchip active" data-k="agent">生成结果</button>
          <button class="fchip" data-k="pass">评分 ≥ 4.0</button>
          <button class="fchip" data-k="all">全部记录</button>
        </div>
        <div class="run-list" id="run-list"><div class="skeleton"></div><div class="skeleton"></div></div>
      </aside>
      <section class="panel glass detail" id="run-detail"><p class="muted">选择左侧一次运行查看材质结果。</p></section>
      <aside class="panel glass">
        <div class="panel-head"><h2>立面 3D 预览</h2><span class="muted" id="m3-info"></span></div>
        <div class="mini3d" id="mini3d"></div>
        <div class="side-pad">
          <label class="field"><span>纹理物理尺寸（米/块） <b id="v-tile">4.0</b></span><input type="range" id="m-tile" min="1" max="12" step="0.5" value="4"></label>
          <label class="field"><span>粗糙度 <b id="v-rough">0.62</b></span><input type="range" id="m-rough" min="0.05" max="1" step="0.01" value="0.62"></label>
          <label class="field"><span>金属度 <b id="v-metal">0.08</b></span><input type="range" id="m-metal" min="0" max="1" step="0.01" value="0.08"></label>
          <div class="btn-row"><button class="btn primary" id="m-use" disabled>应用到建筑模型</button><button class="btn ghost" id="m-spin" aria-pressed="true">暂停旋转</button></div>
          <div id="m-texture-status" class="muted small" role="status" aria-live="polite">选择材质后可预览并应用。</div>
          <p class="muted small">墙面 UV 以米为单位，纹理会按真实尺度在整栋楼上无缝平铺，可直接检验接缝和色差。</p>
        </div>
      </aside>`;
    $('#run-filters', this.root).addEventListener('click', (e) => {
      const b = e.target.closest('.fchip');
      if (!b) return;
      $$('#run-filters .fchip', this.root).forEach((x) => x.classList.toggle('active', x === b));
      this.filter = b.dataset.k;
      this._renderList();
    });
    $('#run-list', this.root).addEventListener('click', (e) => {
      const c = e.target.closest('.rcard');
      if (c) this.open(c.dataset.id);
    });
    $('#run-list', this.root).addEventListener('keydown', (e) => {
      const c = e.target.closest('.rcard');
      if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.open(c.dataset.id); }
    });
    $('#m-refresh', this.root).addEventListener('click', () => this._loadRuns());
    window.addEventListener('twin:materials-changed', () => {
      this.runsDirty = true;
      if (this.active) this._loadRuns();
    });
    this._setup3D();
    await this._loadRuns();
  }

  setActive(on) {
    this.active = !!on;
    if (on && this.inited && this.runsDirty) this._loadRuns();
  }

  async _loadRuns() {
    const seq = ++this.listSeq;
    $('#m-refresh', this.root).disabled = true;
    try {
      const res = await api.runs();
      if (seq !== this.listSeq) return;
      this.runsDirty = false;
      this.runs = res.runs || [];
      this._renderList();
      let fromHash = '';
      try { fromHash = decodeURIComponent(location.hash.split('/')[2] || ''); } catch (_) { /* malformed route */ }
      const best = [...this.runs].filter((r) => r.kind === 'agent').sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
      const pick = this.runs.find((r) => r.id === (this.current || fromHash)) || best || this.runs[0];
      if (pick) {
        if (pick.kind !== 'agent' && this.filter === 'agent') this._setFilter('all');
        await this.open(pick.id);
      } else {
        ++this.detailSeq;
        this.current = this.detail = null;
        this._clearTexture();
        $('#run-detail', this.root).innerHTML = '<div class="notice"><h2>还没有项目材质</h2><p>在建模工作台生成材质后，可在这里检查纹理、评分并应用到建筑。</p><a class="btn primary" href="#/modeling/agent">前往材质生成</a></div>';
      }
    } catch (e) {
      if (seq !== this.listSeq) return;
      $('#run-list', this.root).innerHTML = `<div class="notice bad">材质记录读取失败：${esc(e.message)}<p>点击上方“刷新”重试。</p></div>`;
    } finally {
      if (seq === this.listSeq) $('#m-refresh', this.root).disabled = false;
    }
  }

  _setFilter(filter) {
    this.filter = filter;
    $$('#run-filters .fchip', this.root).forEach((b) => b.classList.toggle('active', b.dataset.k === filter));
    this._renderList();
  }

  _renderList() {
    const list = this.runs.filter((r) => {
      if (this.filter === 'agent') return r.kind === 'agent';
      if (this.filter === 'pass') return r.kind === 'agent' && (r.score ?? 0) >= 4;
      return true;
    });
    $('#run-count', this.root).textContent = `${list.length} 次`;
    $('#run-list', this.root).innerHTML = list.map((r) => `
      <div class="rcard${r.id === this.current ? ' active' : ''}" data-id="${esc(r.id)}" role="button" tabindex="0" aria-pressed="${r.id === this.current}">
        <div class="thumb" ${r.thumb ? `style="background-image:url('${esc(r.thumb.replace(/'/g, '%27'))}')"` : ''}></div>
        <div style="min-width:0">
          <div class="t">${esc(r.id)}</div>
          <div class="s">${esc([r.material, r.color, r.lighting].filter(Boolean).join(' · ') || this._kindLabel(r.kind))}</div>
          <div class="s">${esc(r.address || (r.images ? `${r.images} 张图像` : ''))}</div>
        </div>
        <div class="score ${scoreClass(r.score)}">${fmtScore(r.score)}</div>
      </div>`).join('') || '<p class="muted" style="padding:10px">没有符合筛选条件的材质。可切换“全部记录”或刷新列表。</p>';
  }

  _kindLabel(k) { return { agent: '材质生成记录', legacy: '历史材质记录', experiment: '实验记录', incomplete: '尚未生成完成', empty: '暂无输出', error: '记录读取异常' }[k] || k; }

  async open(id) {
    const seq = ++this.detailSeq;
    this.current = id;
    this.detail = null;
    this._clearTexture();
    this._renderList();
    if (this.active && this.root.classList.contains('active')) {
      $('#run-list .rcard.active', this.root)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (this.active && location.hash.startsWith('#/material') && location.hash !== `#/material/${encodeURIComponent(id)}`) location.hash = `#/material/${encodeURIComponent(id)}`;
    const box = $('#run-detail', this.root);
    box.innerHTML = '<div class="skeleton" style="height:300px"></div>';
    try {
      const d = await api.run(id);
      if (seq !== this.detailSeq) return;
      this.detail = d;
      this._renderDetail(d);
      const tex = d.images?.texture || d.texture;
      if (tex) this._setTexture(tex);
    } catch (e) {
      if (seq !== this.detailSeq) return;
      box.innerHTML = `<div class="notice bad">材质读取失败：${esc(e.message)}<div class="btn-row"><button class="btn" id="m-retry">重新加载</button></div></div>`;
      $('#m-retry', this.root).addEventListener('click', () => this.open(id));
    }
  }

  _bars(obj) {
    const keys = Object.keys(obj || {}).filter((k) => obj[k] !== null && obj[k] !== '' && Number.isFinite(Number(obj[k])) && obj[k] <= 5 && obj[k] >= 0 && k in CRIT_LABELS);
    if (!keys.length) return '<p class="muted">无分项评分。</p>';
    return `<div class="bars">${keys.map((k) => `<div class="bar"><span>${esc(CRIT_LABELS[k] || k)}</span><div class="track"><div class="fill" style="width:${(Number(obj[k]) / 5) * 100}%"></div></div><b>${Number(obj[k]).toFixed(1)}</b></div>`).join('')}</div>`;
  }

  _renderDetail(d) {
    const box = $('#run-detail', this.root);
    const crit = d.critique || {};
    const clean = d.clean || {};
    const img = { ...d.images, texture: d.images?.texture || d.texture };
    const src = (url) => esc(String(url).replace(/'/g, '%27'));
    const tiles = img.texture ? `
      <div class="tex-stage">
        <div class="tex-box"><img src="${src(img.texture)}" data-src="${esc(img.texture)}" alt="最终立面纹理"><span class="cap">最终纹理（点击放大）</span></div>
        <div class="tex-box"><div class="tile" style="background-image:url('${src(img.texture)}');background-size:33.333% 33.333%"></div><span class="cap">3×3 平铺 · 接缝检查</span></div>
      </div>` : '<div class="notice warn">本次记录没有最终纹理。可查看参考图，或选择候选图在右侧预览。</div>';
    const gal = [['reference', '街景参考'], ['facade', '校正立面'], ['clean_view', '干净街景']].filter(([k]) => img[k]);
    const issues = [].concat(crit.issues || []).filter(Boolean);
    const sugg = [].concat(crit.suggestions || crit.suggestion || []).filter(Boolean);
    const num = (v, d = 1) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
    box.innerHTML = `
      <div class="detail-head">
        <div>
          <h2>${esc(d.id)}</h2>
          <div class="muted">${esc(d.address || '未记录项目位置')} ${Array.isArray(d.coordinate) ? ` · WGS84 ${esc(d.coordinate.join(', '))}` : ''}</div>
          <div class="badges" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            ${d.vision?.material ? `<span class="badge c">${esc(d.vision.material)}</span>` : ''}
            ${d.vision?.color ? `<span class="badge v">${esc(d.vision.color)}</span>` : ''}
            ${d.vision?.lighting ? `<span class="badge">${esc(d.vision.lighting)}</span>` : ''}
            ${d.vision?.storeys ? `<span class="badge">${esc(d.vision.storeys)} 层</span>` : ''}
            ${d.confidence ? `<span class="badge a">置信度 ${esc(d.confidence)}</span>` : ''}
            ${d.rounds != null ? `<span class="badge">${esc(d.rounds)} 轮 · ${esc(num(d.elapsed, 1))} s</span>` : ''}
          </div>
        </div>
        <div class="score ${scoreClass(d.score)}" style="font-size:22px;padding:8px 12px" title="综合评分，满分 5 分">${fmtScore(d.score)}${Number.isFinite(d.score) ? ' / 5' : ' 未评分'}</div>
      </div>
      ${tiles}
      <div class="card"><h3>材质评判</h3>
        ${this._bars(crit)}
        <details class="r-logbox"><summary>评分技术指标</summary><div class="muted small">色差 ΔE：${esc(num(crit.delta_e ?? crit.deltaE ?? crit.de))} · 接缝误差：${esc(num(d.seam ?? crit.seam ?? crit.seam_error))} · 投票：${esc(crit.votes ?? '—')}</div></details>
        ${issues.length ? `<p><b>问题：</b>${esc(issues.join('；'))}</p>` : ''}
        ${sugg.length ? `<p class="muted"><b>建议：</b>${esc(sugg.join('；'))}</p>` : ''}
      </div>
      ${Object.keys(clean).length ? `<div class="card"><h3>街景图评分${Number.isFinite(d.clean_score) ? ` · ${fmtScore(d.clean_score)} / 5` : ''}</h3>${this._bars(clean)}${clean.issues?.length ? `<p class="muted small">${esc([].concat(clean.issues).join('；'))}</p>` : ''}${clean.ssim != null ? `<details class="r-logbox"><summary>技术指标</summary><div class="muted small">SSIM ${esc(num(clean.ssim, 3))}</div></details>` : ''}</div>` : ''}
      ${gal.length ? `<div class="card"><h3>参考与渲染</h3><div class="gallery">${gal.map(([k, label]) => `<figure data-src="${esc(img[k])}"><img src="${src(img[k])}" alt="${esc(label)}" loading="lazy"><figcaption>${esc(label)}</figcaption></figure>`).join('')}</div></div>` : ''}
      ${d.candidates?.length ? `<div class="card"><h3>候选图（${d.candidates.length}）</h3><p class="muted small">点击图片放大；选择“预览此图”后可应用到建筑模型。</p><div class="cand-strip">${d.candidates.map((c) => `<div><img src="${src(c.url)}" data-src="${esc(c.url)}" title="${esc(c.name)}" loading="lazy" alt="${esc(c.name || '候选材质')}"><button class="btn ghost" data-texture="${esc(c.url)}">预览此图</button></div>`).join('')}</div></div>` : ''}
      ${d.prompt || d.clean_prompt ? `<details class="card r-logbox"><summary>生成提示词</summary><div class="prompt">${esc(d.prompt)}</div>${d.clean_prompt ? `<h3 style="margin-top:12px">街景提示词</h3><div class="prompt">${esc(d.clean_prompt)}</div>` : ''}</details>` : ''}
      ${d.pois?.length ? `<div class="card"><h3>周边 POI</h3><table class="tbl"><tr><th>名称</th><th>类别</th><th>距离</th></tr>${d.pois.slice(0, 10).map((p) => `<tr><td>${esc(p.title)}</td><td class="muted">${esc(p.category)}</td><td>${esc(p.distance ?? '')}</td></tr>`).join('')}</table></div>` : ''}`;
    box.querySelectorAll('[data-src]').forEach((el) => {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.addEventListener('click', () => lightbox(el.dataset.src));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lightbox(el.dataset.src); } });
    });
    box.querySelectorAll('[data-texture]').forEach((el) => el.addEventListener('click', () => this._setTexture(el.dataset.texture)));
    box.querySelectorAll('img').forEach((el) => el.addEventListener('error', () => {
      el.alt = '图片读取失败，点击下方重试';
      if (el.dataset.failed) return;
      el.dataset.failed = '1';
      const retry = document.createElement('button');
      retry.className = 'btn ghost'; retry.textContent = '重试图片';
      retry.addEventListener('click', (e) => { e.stopPropagation(); delete el.dataset.failed; el.src = el.getAttribute('src'); retry.remove(); });
      el.insertAdjacentElement('afterend', retry);
    }));
    box.scrollTop = 0;
  }

  /* ------------------------------------------------------------------ 3D preview */
  _setup3D() {
    const host = $('#mini3d', this.root);
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.shadowMap.enabled = true;
    r.setClearColor(0x05080f, 1);
    host.appendChild(r.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x05080f, 60, 160);
    const cam = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    cam.up.set(0, 0, 1);
    cam.position.set(-26, -34, 16);
    const ctl = new OrbitControls(cam, r.domElement);
    ctl.target.set(0, 0, 9);
    ctl.enableDamping = true;
    ctl.autoRotate = true;
    ctl.autoRotateSpeed = 1.2;
    const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x41546b, 1.4);
    hemi.position.set(0, 0, 1);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
    sun.position.set(-30, -40, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -40; sun.shadow.camera.right = 40; sun.shadow.camera.top = 40; sun.shadow.camera.bottom = -40;
    scene.add(sun);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(80, 64), new THREE.MeshStandardMaterial({ color: 0x111824, roughness: 0.95 }));
    ground.receiveShadow = true;
    scene.add(ground);
    const ringGrid = new THREE.PolarGridHelper(60, 12, 8, 64, 0x1f6e8f, 0x123044);
    ringGrid.rotation.x = Math.PI / 2;
    ringGrid.position.z = 0.02;
    scene.add(ringGrid);
    this.m3 = { r, scene, cam, ctl, host, mesh: null, tex: null };
    this._buildPreview();
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth || 1, h = host.clientHeight || 1;
      r.setSize(w, h, false);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    });
    ro.observe(host);
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.root.classList.contains('active')) return;
      ctl.update();
      r.render(scene, cam);
    };
    loop();
    const bind = (id, label, fn, digits) => {
      $(id, this.root).addEventListener('input', (e) => { $(label, this.root).textContent = Number(e.target.value).toFixed(digits); fn(Number(e.target.value)); });
    };
    bind('#m-tile', '#v-tile', () => this._buildPreview(), 1);
    bind('#m-rough', '#v-rough', (v) => { if (this.m3.mat) this.m3.mat.roughness = v; }, 2);
    bind('#m-metal', '#v-metal', (v) => { if (this.m3.mat) this.m3.mat.metalness = v; }, 2);
    $('#m-spin', this.root).addEventListener('click', (e) => {
      ctl.autoRotate = !ctl.autoRotate;
      e.currentTarget.textContent = ctl.autoRotate ? '暂停旋转' : '自动旋转';
      e.currentTarget.setAttribute('aria-pressed', String(ctl.autoRotate));
    });
    $('#m-use', this.root).addEventListener('click', () => {
      if (!this.m3.texUrl) { toast('当前运行没有纹理', 'err'); return; }
      const sel = { url: this.m3.texUrl, run: this.current, tile: Number($('#m-tile', this.root).value), roughness: Number($('#m-rough', this.root).value), metalness: Number($('#m-metal', this.root).value) };
      try { localStorage.setItem('twin.material.selected', JSON.stringify(sel)); }
      catch (_) { toast('浏览器未保存材质偏好，本次仍会应用到模型', 'info'); }
      // Also bridge a first visit to modeling when storage is unavailable.
      window.twinSelectedMaterial = sel;
      window.dispatchEvent(new CustomEvent('twin:material', { detail: sel }));
      toast('已设为程序化建模的立面材质', 'ok');
      location.hash = '#/modeling/proc';
    });
  }

  _buildPreview() {
    const { scene } = this.m3;
    if (this.m3.mesh) {
      scene.remove(this.m3.mesh);
      this.m3.mesh.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material !== this.m3.mat) o.material.dispose(); });
    }
    const tile = Number($('#m-tile', this.root)?.value || 4);
    const ring = [[-9, -6], [9, -6], [9, 2], [3, 2], [3, 6], [-9, 6]];
    const { walls, roof } = buildingGeometry(ring, 0, 18, tile);
    if (!this.m3.mat) this.m3.mat = facadeMaterial(this.m3.tex);
    const g = new THREE.Group();
    const w = new THREE.Mesh(walls, this.m3.mat);
    w.castShadow = true;
    const rf = new THREE.Mesh(roof, new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.8 }));
    rf.castShadow = true;
    g.add(w, rf);
    scene.add(g);
    this.m3.mesh = g;
  }

  _clearTexture() {
    ++this.textureSeq;
    $('#m-use', this.root).disabled = true;
    $('#m3-info', this.root).textContent = '';
    $('#m-texture-status', this.root).textContent = '尚未选择可用纹理。';
    if (!this.m3) return;
    this.m3.tex?.dispose();
    this.m3.tex = this.m3.texUrl = null;
    if (this.m3.mat) { this.m3.mat.map = null; this.m3.mat.needsUpdate = true; }
  }

  _setTexture(url) {
    this._clearTexture();
    const seq = this.textureSeq;
    const run = this.current;
    $('#m-texture-status', this.root).textContent = '正在载入立面材质…';
    new THREE.TextureLoader().load(url, (tex) => {
      if (seq !== this.textureSeq || run !== this.current) { tex.dispose(); return; }
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.m3.r.capabilities.getMaxAnisotropy();
      if (this.m3.tex) this.m3.tex.dispose();
      this.m3.tex = tex;
      this.m3.texUrl = url;
      if (!this.m3.mat) this.m3.mat = facadeMaterial(tex);
      this.m3.mat.map = tex;
      this.m3.mat.needsUpdate = true;
      $('#m3-info', this.root).textContent = `${tex.image.width}×${tex.image.height}`;
      $('#m-use', this.root).disabled = false;
      $('#m-texture-status', this.root).textContent = '预览已更新，可将当前材质应用到建筑模型。';
    }, undefined, () => {
      if (seq !== this.textureSeq || run !== this.current) return;
      const status = $('#m-texture-status', this.root);
      status.innerHTML = '<span class="dz-err">纹理载入失败，暂时不能应用。</span><button class="btn ghost" id="m-tex-retry">重试载入</button>';
      $('#m-tex-retry', this.root).addEventListener('click', () => this._setTexture(url));
    });
  }
}
