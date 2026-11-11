import { SystemView as BaseSystemView } from '../static/js/system.js';
import { esc, fmtBytes } from '../static/js/ui.js';

export class SystemView extends BaseSystemView {
  renderCapabilities() {
    this.slot('system').innerHTML = '<table class="tbl"><tr><th>运行方式</th><td>纯浏览器 · 无需登录</td></tr><tr><th>场景与材质预览</th><td>WebGL2 本地渲染</td></tr><tr><th>参数建模与导出</th><td>可交互 · 可下载GLB</td></tr><tr><th>数据保存</th><td>仅当前浏览会话，刷新后清空</td></tr><tr><th>影像/DSM与GPU生成</th><td>需部署完整版</td></tr></table>';
  }
  renderRuns(runs) {
    this.slot('stat-runs').innerHTML = '<div class="big-num">'+runs.length+'</div><p class="muted">份程序化演示纹理 · 不包含AI评分</p>';
    this.slot('runs').innerHTML = '<p class="muted">示例纹理由程序绘制，用于体验平铺、三维预览和材质应用，不是AI生成结果或实景证据。</p><div class="btn-row">'+runs.map(r => '<a class="btn" href="#/material/'+encodeURIComponent(r.id)+'">'+esc(r.material)+'</a>').join('')+'</div>';
  }
  renderMemory() {
    this.slot('memory').innerHTML = '<p class="muted">演示站不保存生成任务，也不采集访客影像。完整部署后可在此查看实际运行记忆与质量记录。</p>';
  }
  renderExports(exports) {
    this.slot('stat-exports').innerHTML = '<div class="big-num">'+exports.length+'</div><p class="muted">份当前会话导出 · 刷新后清空</p>';
    this.slot('exports').innerHTML = exports.length ? exports.map(e => '<p><a href="'+esc(e.url)+'" download="'+esc(e.name)+'">'+esc(e.name)+'</a> · '+esc(fmtBytes(e.size))+'</p>').join('') : '<p class="muted">在程序化建模页面导出GLB后，可在这里再次下载。</p>';
  }
  renderDiagnostics() {
    this.slot('diagnostics').innerHTML = '<details><summary>在线体验说明</summary><p>场景、纹理和关联资料均为程序生成的合成示例，用于展示交互结构。没有真实地理证据等级或精度指标。修改与导出只在当前浏览器会话内。</p><p><a href="https://github.com/anticipate218/twin-studio/blob/main/docs/GETTING_STARTED.md" target="_blank" rel="noopener">部署完整系统 →</a></p></details>';
  }
}
