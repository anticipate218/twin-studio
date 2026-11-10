/* Twin Studio splat worker.
 * - Packs antimatter15 ".splat" records (32 B: pos f32x3, scale f32x3, rgba u8x4, rot u8x4 [w,x,y,z])
 *   into an RGBA32UI texture: per splat 2 texels = [x,y,z,0] [cov01, cov23, cov45, rgba] (cov as half2x16).
 * - Depth-sorts splats back-to-front for a given model-view matrix (16-bit counting sort).
 * - Answers ray picks against splat centres.
 */
'use strict';

let positions = null;   // Float32Array n*3
let alphas = null;      // Uint8Array n
let count = 0;
let depthBuf = null;    // Int32Array n
let bucketBuf = null;   // Uint16Array n
const counts = new Uint32Array(65536);
const starts = new Uint32Array(65536);
let spare = null;       // recycled ArrayBuffer for sorted indices

const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);

function floatToHalf(v) {
  _f32[0] = v;
  const f = _i32[0];
  const sign = (f >> 31) & 0x0001;
  const exp = (f >> 23) & 0x00ff;
  let frac = f & 0x007fffff;
  let newExp;
  if (exp === 0) {
    newExp = 0;
  } else if (exp < 113) {
    newExp = 0;
    frac |= 0x00800000;
    frac = frac >> (113 - exp);
    if (frac & 0x01000000) { newExp = 1; frac = 0; }
  } else if (exp < 142) {
    newExp = exp - 112;
  } else {
    newExp = 31;
    frac = 0;
  }
  return (sign << 15) | (newExp << 10) | (frac >> 13);
}

function packHalf2x16(x, y) {
  return (floatToHalf(x) | (floatToHalf(y) << 16)) >>> 0;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function load(msg) {
  const buffer = msg.buffer;
  const n = Math.floor(buffer.byteLength / 32);
  const f = new Float32Array(buffer, 0, n * 8);
  const u = new Uint8Array(buffer, 0, n * 32);
  const texwidth = 2048;
  const texheight = Math.max(1, Math.ceil(n / 1024));
  const tex = new Uint32Array(texwidth * texheight * 4);
  const texF = new Float32Array(tex.buffer);
  const texU8 = new Uint8Array(tex.buffer);
  positions = new Float32Array(n * 3);
  alphas = new Uint8Array(n);
  depthBuf = new Int32Array(n);
  bucketBuf = new Uint16Array(n);
  count = n;
  let invalid = 0;
  let sumR = 0, sumG = 0, sumB = 0, sumN = 0;

  for (let i = 0; i < n; i++) {
    let x = f[8 * i], y = f[8 * i + 1], z = f[8 * i + 2];
    let a = u[32 * i + 27];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      x = 0; y = 0; z = 0; a = 0; invalid++;
    }
    positions[3 * i] = x; positions[3 * i + 1] = y; positions[3 * i + 2] = z;
    alphas[i] = a;
    texF[8 * i] = x; texF[8 * i + 1] = y; texF[8 * i + 2] = z;
    const cb = 4 * (8 * i + 7);
    texU8[cb] = u[32 * i + 24];
    texU8[cb + 1] = u[32 * i + 25];
    texU8[cb + 2] = u[32 * i + 26];
    texU8[cb + 3] = a;
    if (a > 30 && (i & 7) === 0) { sumR += u[32 * i + 24]; sumG += u[32 * i + 25]; sumB += u[32 * i + 26]; sumN++; }

    let sx = f[8 * i + 3], sy = f[8 * i + 4], sz = f[8 * i + 5];
    if (!Number.isFinite(sx)) sx = 0;
    if (!Number.isFinite(sy)) sy = 0;
    if (!Number.isFinite(sz)) sz = 0;
    let qw = (u[32 * i + 28] - 128) / 128;
    let qx = (u[32 * i + 29] - 128) / 128;
    let qy = (u[32 * i + 30] - 128) / 128;
    let qz = (u[32 * i + 31] - 128) / 128;
    const ql = Math.hypot(qw, qx, qy, qz) || 1;
    qw /= ql; qx /= ql; qy /= ql; qz /= ql;
    // Rotation matrix rows (as in antimatter15/splat), each row scaled by the matching axis scale.
    const M0 = (1 - 2 * (qy * qy + qz * qz)) * sx;
    const M1 = (2 * (qx * qy + qw * qz)) * sx;
    const M2 = (2 * (qx * qz - qw * qy)) * sx;
    const M3 = (2 * (qx * qy - qw * qz)) * sy;
    const M4 = (1 - 2 * (qx * qx + qz * qz)) * sy;
    const M5 = (2 * (qy * qz + qw * qx)) * sy;
    const M6 = (2 * (qx * qz + qw * qy)) * sz;
    const M7 = (2 * (qy * qz - qw * qx)) * sz;
    const M8 = (1 - 2 * (qx * qx + qy * qy)) * sz;
    const s0 = M0 * M0 + M3 * M3 + M6 * M6;
    const s1 = M0 * M1 + M3 * M4 + M6 * M7;
    const s2 = M0 * M2 + M3 * M5 + M6 * M8;
    const s3 = M1 * M1 + M4 * M4 + M7 * M7;
    const s4 = M1 * M2 + M4 * M5 + M7 * M8;
    const s5 = M2 * M2 + M5 * M5 + M8 * M8;
    tex[8 * i + 4] = packHalf2x16(4 * s0, 4 * s1);
    tex[8 * i + 5] = packHalf2x16(4 * s2, 4 * s3);
    tex[8 * i + 6] = packHalf2x16(4 * s4, 4 * s5);
  }

  // Robust statistics on a subsample of visible splats.
  const step = Math.max(1, Math.floor(n / 250000));
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < n; i += step) {
    if (alphas[i] < 20) continue;
    xs.push(positions[3 * i]); ys.push(positions[3 * i + 1]); zs.push(positions[3 * i + 2]);
  }
  const ax = Float32Array.from(xs).sort();
  const ay = Float32Array.from(ys).sort();
  const az = Float32Array.from(zs).sort();
  const pick = (p) => [percentile(ax, p), percentile(ay, p), percentile(az, p)];
  const stats = {
    count: n,
    invalid,
    p1: pick(1), p2: pick(2), p5: pick(5), p10: pick(10), p50: pick(50), p90: pick(90), p95: pick(95), p98: pick(98), p99: pick(99),
    min: [ax[0] ?? 0, ay[0] ?? 0, az[0] ?? 0],
    max: [ax[ax.length - 1] ?? 0, ay[ay.length - 1] ?? 0, az[az.length - 1] ?? 0],
    meanColor: sumN ? [sumR / sumN, sumG / sumN, sumB / sumN] : [128, 128, 128],
  };
  self.postMessage({ type: 'texture', id: msg.id, tex, texwidth, texheight, count: n, stats }, [tex.buffer]);
}

function sort(msg) {
  const n = count;
  if (!n) return;
  const v = msg.view;
  const m2 = v[2], m6 = v[6], m10 = v[10], m14 = v[14];
  const t0 = performance.now();
  let out = null;
  if (spare && spare.byteLength === n * 4) out = new Float32Array(spare);
  else out = new Float32Array(n);
  spare = null;

  let minD = 0x7fffffff, maxD = -0x7fffffff;
  for (let i = 0; i < n; i++) {
    const d = ((m2 * positions[3 * i] + m6 * positions[3 * i + 1] + m10 * positions[3 * i + 2] + m14) * 4096) | 0;
    depthBuf[i] = d;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  const range = maxD - minD;
  if (range <= 0) {
    for (let i = 0; i < n; i++) out[i] = i;
  } else {
    const inv = 65535 / range;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const b = ((depthBuf[i] - minD) * inv) | 0;
      bucketBuf[i] = b;
      counts[b]++;
    }
    starts[0] = 0;
    for (let i = 1; i < 65536; i++) starts[i] = starts[i - 1] + counts[i - 1];
    // Ascending view-space z = farthest first (three.js cameras look down -Z): back-to-front.
    for (let i = 0; i < n; i++) out[starts[bucketBuf[i]]++] = i;
  }
  self.postMessage({ type: 'sorted', id: msg.id, indices: out, ms: performance.now() - t0 }, [out.buffer]);
}

function pick(msg) {
  const [ox, oy, oz] = msg.origin;
  let [dx, dy, dz] = msg.dir;
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl; dy /= dl; dz /= dl;
  const cone = msg.cone || 0.004;
  const minAlpha = msg.minAlpha ?? 40;
  const clip = msg.clip;
  let best = -1, bestT = Infinity;
  for (let i = 0; i < count; i++) {
    if (alphas[i] < minAlpha) continue;
    const px = positions[3 * i], py = positions[3 * i + 1], pz = positions[3 * i + 2];
    if (clip && (px < clip[0] || py < clip[1] || pz < clip[2] || px > clip[3] || py > clip[4] || pz > clip[5])) continue;
    const vx = px - ox, vy = py - oy, vz = pz - oz;
    const t = vx * dx + vy * dy + vz * dz;
    if (t <= 0 || t >= bestT) continue;
    const d2 = vx * vx + vy * vy + vz * vz - t * t;
    const tol = cone * t;
    if (d2 < tol * tol) { bestT = t; best = i; }
  }
  const point = best >= 0 ? [positions[3 * best], positions[3 * best + 1], positions[3 * best + 2]] : null;
  self.postMessage({ type: 'picked', id: msg.id, point, index: best });
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') load(m);
    else if (m.type === 'sort') sort(m);
    else if (m.type === 'recycle') spare = m.buffer;
    else if (m.type === 'pick') pick(m);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
  }
};
