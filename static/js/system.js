// Project outcomes first; deployment information stays in opt-in diagnostics.
import { api } from './api.js';
import { esc, fmtBytes, fmtNum, fmtScore, scoreClass } from './ui.js';

const SOURCES = { system: '计算与生成能力', models: '模型', runs: '材质运行', memory: 'Agent 记忆', exports: '导出成果' };
const REQUEST_TIMEOUT = 20000;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isFinite(value) && value >= 0;
const sum = (items, key) => items.every((item) => isCount(item[key])) ? items.reduce((n, item) => n + item[key], 0) : null;
const badge = (value, yes, no, unknown = '状态未知') => `<span class="badge ${value === true ? 'g' : value === false ? 'a' : ''}">${esc(value === true ? yes : value === false ? no : unknown)}</span>`;
const score = (value) => `<span class="score ${scoreClass(value)}">${esc(fmtScore(value))}</span>`;
const table = (headers, rows) => `<div style="overflow-x:auto"><table class="tbl"><thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;

function validateResponse(key, data) {
  if (!isRecord(data) || data.error) throw new Error(data?.error || '接口未返回有效数据');
  if (['models', 'runs', 'exports'].includes(key)) {
    const id = { models: 'file', runs: 'id', exports: 'name' }[key];
    if (!Array.isArray(data[key]) || !data[key].every((item) => isRecord(item) && typeof item[id] === 'string' && item[id])) {
      throw new Error('接口返回的清单格式不完整');
    }
  } else if (key === 'system' && !isRecord(data.studio)) {
    throw new Error('系统检测结果缺少服务信息');
  } else if (key === 'memory') {
    if (!isRecord(data.index) || !isRecord(data.buildings) || !isRecord(data.failure_counts)
      || !Object.values(data.buildings).every(isRecord) || !Object.values(data.failure_counts).every(isCount)
      || (data.index.buildings !== undefined && (!Array.isArray(data.index.buildings) || !data.index.buildings.every(isRecord)))) {
      throw new Error('接口返回的记忆格式不完整');
    }
  }
  return data;
}

function memoryBuildings(data) {
  const buildings = new Map(Object.entries(data.buildings).map(([key, value]) => [key, { ...value, key }]));
  for (const [i, building] of (data.index.buildings || []).entries()) {
    const key = building.key || `index-${i}`;
    buildings.set(key, { ...buildings.get(key), ...building });
  }
  return [...buildings.values()];
}

export class SystemView {
  constructor(root) {
    this.root = root;
    this.request = 0;
  }

  async init() {
    const request = ++this.request;
    const states = Object.fromEntries(Object.keys(SOURCES).map((key) => [key, { status: 'loading' }]));
    this.root.innerHTML = `
      <header class="card glass span12">
        <div class="section-head"><div><h2>项目成果总览</h2><p class="muted">汇集三维场景、建筑属性、材质评价与建模导出，查看项目积累并继续下一步工作。</p></div>
          <button type="button" class="btn" data-system="refresh" disabled>刷新中…</button></div>
        <div class="notice" data-system="status" role="status" aria-live="polite">正在读取项目成果…</div>
      </header>
      <nav class="card glass span12" aria-label="四模块工作流">
        <div class="section-head"><h3>从场景到成果</h3><span class="muted">浏览建筑 → 生成材质 → 参数建模 → 成果复盘</span></div>
        <div class="btn-row">
          <a class="btn ghost" href="#/scene">01 · 场景与建筑</a>
          <a class="btn ghost" href="#/material">02 · 材质与 Agent</a>
          <a class="btn ghost" href="#/modeling">03 · 建模与导出</a>
          <a class="btn primary" href="#/system" aria-current="page">04 · 成果总览</a>
        </div>
      </nav>
      <section class="card glass span4"><h3>模型与建筑</h3><div data-system="stat-models"></div></section>
      <section class="card glass span4"><h3>材质运行</h3><div data-system="stat-runs"></div></section>
      <section class="card glass span4"><h3>导出成果</h3><div data-system="stat-exports"></div></section>
      <section class="card glass span12"><div class="section-head"><h3>场景模型与建筑资产</h3><a class="btn ghost" href="#/scene">进入场景</a></div><div data-system="models"></div></section>
      <section class="card glass span6"><div class="section-head"><h3>Agent 评价</h3><a href="#/material">查看材质运行 →</a></div><div data-system="runs"></div></section>
      <section class="card glass span6"><h3>建筑记忆与改进记录</h3><div data-system="memory"></div></section>
      <section class="card glass span6"><div class="section-head"><h3>可交付的导出成果</h3><a href="#/modeling">继续建模 →</a></div><div data-system="exports"></div></section>
      <section class="card glass span6"><h3>计算与生成能力</h3><div data-system="system"></div></section>
      <div class="card glass span12" data-system="diagnostics"></div>`;
    const refresh = this.slot('refresh');
    refresh.addEventListener('click', () => this.init());
    for (const key of Object.keys(SOURCES)) this.renderSource(key, states[key]);
    this.renderProgress(states);
    this.renderDiagnostics(states);

    // Render each source as it settles. A slow or broken probe cannot hide other outcomes.
    await Promise.all(Object.keys(SOURCES).map(async (key) => {
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('请求超时，请刷新重试')), REQUEST_TIMEOUT); });
        const data = validateResponse(key, await Promise.race([Promise.resolve().then(() => api[key]()), timeout]));
        if (request !== this.request) return;
        states[key] = { status: 'ready', data };
      } catch (error) {
        if (request !== this.request) return;
        states[key] = { status: 'error', error: String(error?.message || error || '请求失败') };
      } finally {
        clearTimeout(timer);
      }
      if (request !== this.request) return;
      this.renderSource(key, states[key]);
      this.renderProgress(states);
      this.renderDiagnostics(states);
    }));
  }

  slot(name) { return this.root.querySelector(`[data-system="${name}"]`); }

  renderProgress(states) {
    const entries = Object.entries(states);
    const pending = entries.filter(([, state]) => state.status === 'loading').length;
    const failures = entries.filter(([, state]) => state.status === 'error').map(([key]) => SOURCES[key]);
    const status = this.slot('status');
    const refresh = this.slot('refresh');
    refresh.disabled = pending > 0;
    refresh.textContent = pending ? '刷新中…' : '刷新总览';
    this.root.setAttribute('aria-busy', String(pending > 0));
    status.className = `notice${failures.length === entries.length ? ' bad' : !pending && !failures.length ? ' ok' : ''}`;
    if (pending) {
      status.textContent = `刷新中：已完成 ${entries.length - pending}/${entries.length} 项读取${failures.length ? `，${failures.join('、')}读取失败` : ''}。已返回的数据可继续查看。`;
    } else if (failures.length) {
      status.textContent = `${failures.length === entries.length ? '全部数据' : '部分数据'}读取失败：${failures.join('、')}。可点击刷新重试，具体原因见技术诊断。`;
    } else {
      status.textContent = `刷新完成 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 已读取全部 ${entries.length} 项数据`;
    }
  }

  renderSource(key, state) {
    const target = this.slot(key);
    const stat = this.slot(`stat-${key}`);
    if (state.status !== 'ready') {
      const message = state.status === 'error' ? `${SOURCES[key]}读取失败，请刷新重试。` : `正在读取${SOURCES[key]}…`;
      target.innerHTML = `<div class="notice${state.status === 'error' ? ' bad' : ''}">${esc(message)}${key === 'system' ? ' 生成能力状态未知。' : ''}</div>`;
      if (stat) stat.innerHTML = `<div class="big-num">—</div><p class="muted">${esc(message)}</p>`;
      return;
    }
    if (key === 'models') this.renderModels(state.data.models);
    else if (key === 'runs') this.renderRuns(state.data.runs);
    else if (key === 'memory') this.renderMemory(state.data);
    else if (key === 'exports') this.renderExports(state.data.exports);
    else this.renderCapabilities(state.data);
  }

  renderModels(models) {
    const withBuildings = models.filter((model) => !!model.buildings).length;
    this.slot('stat-models').innerHTML = `<div class="big-num">${models.length}</div><p class="muted">个场景模型 · ${withBuildings} 个带建筑属性</p><div class="muted">${esc(fmtNum(sum(models, 'gaussians')))} 个高斯 · ${esc(fmtBytes(sum(models, 'size')))}</div>`;
    this.slot('models').innerHTML = models.length ? table(['项目模型', '建筑属性', '高斯数量', '文件大小', '预览'], models.map((model) => {
      const href = `#/scene/${encodeURIComponent(model.file)}`;
      const buildings = isCount(model.metrics?.buildings) ? `${fmtNum(model.metrics.buildings)} 栋标注` : model.buildings ? '可查建筑属性' : '未提供建筑属性';
      return `<tr><td><a href="${href}">${esc(model.title || model.file)}</a><div class="muted mono">${esc(model.file)}</div>
        ${model.final === true ? '<span class="badge c">最终成果</span>' : ''}${model.valid === false ? '<span class="badge a">文件需检查</span>' : ''}${model.registered === false ? '<span class="badge a">未登记</span>' : ''}</td>
        <td>${esc(buildings)}</td><td class="mono">${esc(fmtNum(model.gaussians))}</td><td class="mono">${esc(fmtBytes(model.size))}</td><td><a class="btn ghost" href="${href}" aria-label="预览 ${esc(model.title || model.file)}">预览 →</a></td></tr>`;
    }).join('')) : '<div class="notice">暂无模型。前往<a href="#/scene">场景模块</a>导入或重建第一个场景。</div>';
  }

  renderRuns(runs) {
    const agents = runs.filter((run) => run.kind === 'agent');
    const rated = agents.filter((run) => Number.isFinite(run.score)).sort((a, b) => b.score - a.score);
    const broken = runs.filter((run) => run.kind === 'error').length;
    this.slot('stat-runs').innerHTML = `<div class="big-num">${runs.length}</div><p class="muted">条运行记录 · ${agents.length} 份 Agent 报告</p><div class="muted">${runs.filter((run) => !!run.texture).length} 份带成品纹理${broken ? ` · ${broken} 条报告异常` : ''}</div>`;
    const summary = rated.length ? `<p class="muted">${rated.length} 份有效评分 · 最高分 ${score(rated[0].score)} · ≥4.0 的 ${rated.filter((run) => run.score >= 4).length} 份</p>`
      : `<div class="notice">${agents.length ? '暂无有效评分，已有 Agent 报告尚未提供分数。' : '暂无 Agent 评价。生成材质后，可在这里回看评分与运行结果。'}</div>`;
    const rows = [...rated, ...agents.filter((run) => !Number.isFinite(run.score))].slice(0, 5);
    this.slot('runs').innerHTML = `${summary}${broken ? `<p class="muted">${broken} 条运行报告读取异常，未计入评分。</p>` : ''}${rows.length ? table(['运行 / 建筑', '评分', '材质'], rows.map((run) => `<tr><td><a href="#/material/${encodeURIComponent(run.id)}">${esc(run.address || run.id)}</a></td><td>${Number.isFinite(run.score) ? score(run.score) : '<span class="badge">未评分</span>'}</td><td>${esc(run.material || '未标注')}</td></tr>`).join('')) : ''}${agents.length > 5 ? '<p class="muted">展示评分优先的前 5 份报告，更多记录见材质模块。</p>' : ''}`;
  }

  renderMemory(data) {
    const buildings = memoryBuildings(data);
    const failures = Object.entries(data.failure_counts).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
    this.slot('memory').innerHTML = buildings.length ? `<p class="muted">已积累 ${buildings.length} 条建筑记忆，用于回看尝试与最佳结果。</p>${table(['建筑', '尝试', '最佳评分', '最佳运行'], buildings.slice(0, 8).map((building) => `<tr><td>${esc(building.address || building.key || '未命名建筑')}</td><td>${isCount(building.attempts) ? esc(fmtNum(building.attempts)) : '—'}</td><td>${score(building.best_score)}</td><td>${typeof building.best_run === 'string' && building.best_run ? `<a href="#/material/${encodeURIComponent(building.best_run)}">查看运行 →</a>` : '<span class="muted">未记录</span>'}</td></tr>`).join(''))}${buildings.length > 8 ? '<p class="muted">当前展示前 8 条建筑记忆。</p>' : ''}`
      : '<div class="notice">暂无建筑记忆。Agent 完成运行并保存记忆后，会在这里汇总尝试次数与最佳结果。</div>';
    this.slot('memory').innerHTML += `<h3 style="margin-top:16px">评价问题记录</h3>${failures.length ? table(['问题类型', '记录次数'], failures.map(([name, count]) => `<tr><td>${esc(name)}</td><td class="mono">${esc(fmtNum(count))}</td></tr>`).join('')) : '<p class="muted">暂无失败类型记录；这不代表已有运行全部通过评价。</p>'}`;
  }

  renderExports(exports) {
    this.slot('stat-exports').innerHTML = `<div class="big-num">${exports.length}</div><p class="muted">份 GLB 成果 · ${esc(fmtBytes(sum(exports, 'size')))}</p><a href="#/modeling">建模与导出 →</a>`;
    this.slot('exports').innerHTML = exports.length ? `${table(['导出文件', '大小', '获取'], exports.slice(0, 5).map((item) => `<tr><td>${esc(item.name)}</td><td class="mono">${esc(fmtBytes(item.size))}</td><td><a class="btn ghost" href="/exports/${encodeURIComponent(item.name)}" download>下载 GLB</a></td></tr>`).join(''))}${exports.length > 5 ? '<p class="muted">展示清单前 5 份，更多导出可在建模模块查看。</p>' : ''}`
      : '<div class="notice">暂无导出成果。前往<a href="#/modeling">参数建模</a>，保存第一份 GLB 模型。</div>';
  }

  renderCapabilities(sys) {
    const gpus = Array.isArray(sys.gpu) ? sys.gpu.filter(isRecord) : null;
    const remote = sys.legacy?.up === false || sys.remote?.up === false ? false : sys.legacy?.up === true && sys.remote?.up === true ? true : undefined;
    const mode = { local: '本地重建', remote: '远端重建' }[sys.recon?.mode] || '方式未知';
    const rows = [
      ['项目服务', badge(true, '已响应')],
      ['计算设备', gpus === null ? badge(undefined) : gpus.length ? gpus.map((gpu) => `${esc(gpu.name || 'GPU')} ${esc(gpu.memory_total || '')}`).join('<br>') : badge(false, '', '未检测到 NVIDIA GPU')],
      ['当前重建方式', esc(mode)],
      ['本地重建环境', badge(sys.recon?.local?.available, '依赖检测通过', '暂不可用')],
      ['远端重建链路', badge(remote, '链路连通', '链路未连通')],
      ['材质生成环境', badge(sys.agent?.can_generate, '环境检测通过', '暂不可用')],
    ];
    this.slot('system').innerHTML = table(['能力', '检测结果'], rows.map(([name, value]) => `<tr><th scope="row">${esc(name)}</th><td>${value}</td></tr>`).join(''))
      + '<p class="muted">状态来自本次接口检测，环境与链路检查不代表生成任务已完成。部署信息与依赖说明见下方技术诊断。</p>';
  }

  renderDiagnostics(states) {
    const container = this.slot('diagnostics');
    const open = container.querySelector('details')?.open;
    const sys = states.system.data;
    const rows = Object.entries(states).map(([key, state]) => `<tr><th scope="row">${esc(SOURCES[key])}</th><td>${esc(state.status === 'ready' ? '读取成功' : state.status === 'error' ? state.error : '读取中…')}</td></tr>`).join('');
    const deployment = sys ? [
      ['Studio 版本', sys.studio?.version], ['项目目录', sys.studio?.root], ['成果包目录', sys.paths?.fina],
      ['场景服务地址', sys.legacy?.url], ['远端地址', sys.remote?.host ? `${sys.remote.host}${sys.remote.port == null ? '' : `:${sys.remote.port}`}` : null],
      ['场景数据目录', sys.paths?.web3d], ['Agent 目录', sys.paths?.agent || sys.agent?.root],
      ['生成权重目录', sys.agent?.sd_dir || sys.agent?.models_dir], ['材质生成说明', sys.agent?.reason || (sys.agent?.can_generate === true ? '环境检测通过' : '未提供')],
      ['Python 版本', sys.python], ['本地重建脚本', sys.recon?.local?.script], ['本地重建 Python', sys.recon?.local?.python],
      ['本地重建输出', sys.recon?.local?.outputs], ['本地重建说明', sys.recon?.local?.reason || (sys.recon?.local?.available === true ? '依赖检测通过' : '未提供')],
      ['缺失依赖', Array.isArray(sys.recon?.local?.missing) ? sys.recon.local.missing.join('、') || '无' : null],
    ] : [];
    const exportDir = states.exports.data?.dir || sys?.studio?.exports_dir;
    if (exportDir) deployment.push(['导出目录', exportDir]);
    const keys = isRecord(sys?.agent?.keys) ? Object.entries(sys.agent.keys) : [];
    container.innerHTML = `<details${open ? ' open' : ''}><summary>技术诊断 · 接口、部署与依赖</summary><p class="muted">用于排查读取或生成问题，包含本机目录与连接信息。</p>
      ${table(['数据来源', '本次读取结果'], rows)}
      ${deployment.length ? table(['诊断项', '当前信息'], deployment.map(([name, value]) => `<tr><th scope="row">${esc(name)}</th><td class="mono" style="overflow-wrap:anywhere">${esc(value ?? '未提供')}</td></tr>`).join('')) : ''}
      ${keys.length ? `<p>外部接口凭证：${keys.map(([name, value]) => `${esc(name)} ${badge(value, '已配置', '未配置')}`).join(' ')}</p>` : ''}
      ${sys?.agent?.secrets_in_repo ? '<div class="notice">检测到本地配置文件保存了接口凭证，分享部署文件前请检查凭证存放方式。</div>' : ''}
      </details>`;
  }
}
