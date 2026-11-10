// Shared UI helpers for Twin Studio.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export function fmtNum(n) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtScore(s) {
  return Number.isFinite(s) ? s.toFixed(s >= 10 ? 0 : 1) : '—';
}

export function scoreClass(s) {
  if (!Number.isFinite(s)) return 'na';
  if (s >= 4) return 'good';
  if (s >= 3.5) return 'mid';
  return 'low';
}

export function toast(msg, kind = 'info', ms = 3600) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  t.textContent = msg;
  if (box.children.length >= 4) box.firstElementChild.remove();
  box.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s, transform .3s';
    t.style.opacity = '0';
    t.style.transform = 'translateY(6px)';
    setTimeout(() => t.remove(), 320);
  }, ms);
}

let closeLightbox = null;
export function lightbox(src, description = '图像预览') {
  closeLightbox?.();
  const previousFocus = document.activeElement;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-modal', 'true');
  lb.setAttribute('aria-label', description);
  const img = document.createElement('img');
  img.src = src;
  img.alt = description;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightbox-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭图像预览');
  const caption = document.createElement('p');
  caption.className = 'lightbox-caption';
  caption.textContent = '点击空白处或按 Esc 关闭';
  const cleanup = () => {
    lb.remove();
    window.removeEventListener('keydown', onKey, true);
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    closeLightbox = null;
  };
  const onKey = (e) => {
    // Modal interaction must not trigger scene keyboard shortcuts underneath.
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
    if (e.key === 'Tab') { e.preventDefault(); close.focus(); }
  };
  img.addEventListener('error', () => { caption.textContent = '图片暂时无法加载，请关闭后重试'; });
  close.addEventListener('click', cleanup);
  lb.addEventListener('click', (e) => { if (e.target === lb) cleanup(); });
  lb.append(img, caption, close);
  window.addEventListener('keydown', onKey, true);
  document.body.appendChild(lb);
  closeLightbox = cleanup;
  close.focus();
}

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Deterministic PRNG for procedural content.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

export function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
