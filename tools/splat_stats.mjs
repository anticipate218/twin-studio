// Read-only .splat inspector (antimatter15 format: 32 bytes per gaussian =
// pos f32x3, scale f32x3, rgba u8x4, rot u8x4 as (q*128+128)).
//   node tools/splat_stats.mjs <file.splat> [more.splat ...]
import fs from 'node:fs';
import path from 'node:path';

const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))))] : NaN;
const f = (v, d = 3) => (Number.isFinite(v) ? (Math.abs(v) >= 1e5 ? v.toExponential(4) : v.toFixed(d)) : String(v));
const num = (a) => Float64Array.from(a).sort();

for (const file of process.argv.slice(2)) {
  if (!fs.existsSync(file)) { console.log(`\n### ${file}: not found`); continue; }
  const buf = fs.readFileSync(file);
  const n = Math.floor(buf.length / 32);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const step = Math.max(1, Math.floor(n / 200000));
  const P = [[], [], []], S = [[], [], []], Smax = [], Smin = [], A = [], L = [], Q = [];
  let bad = 0, zeroAlpha = 0, lowAlpha = 0, sampled = 0;
  for (let i = 0; i < n; i += step) {
    const o = i * 32;
    const p = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
    const s = [dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true)];
    if (![...p, ...s].every(Number.isFinite)) { bad++; continue; }
    sampled++;
    for (let k = 0; k < 3; k++) { P[k].push(p[k]); S[k].push(s[k]); }
    Smax.push(Math.max(...s)); Smin.push(Math.min(...s));
    const r = buf[o + 24], g = buf[o + 25], b = buf[o + 26], a = buf[o + 27];
    A.push(a); if (a === 0) zeroAlpha++; if (a < 20) lowAlpha++;
    L.push(0.299 * r + 0.587 * g + 0.114 * b);
    const q = [0, 1, 2, 3].map((k) => (buf[o + 28 + k] - 128) / 128);
    Q.push(Math.hypot(...q));
  }
  const Ps = P.map(num), Ss = S.map(num), Sx = num(Smax), Sn = num(Smin), As = num(A), Ls = num(L), Qs = num(Q);
  const ext = [0, 1, 2].map((k) => pct(Ps[k], 98) - pct(Ps[k], 2));
  const sortedExt = [...ext].sort((x, y) => x - y);
  const area = sortedExt[1] * sortedExt[2];
  console.log(`\n### ${path.basename(file)}  bytes=${buf.length}  gaussians=${n}  rem32=${buf.length % 32}  sampleStep=${step}  sampled=${sampled}  nonFinite=${bad}`);
  for (let k = 0; k < 3; k++) {
    console.log(`  pos.${'xyz'[k]}  min=${f(Ps[k][0])} p1=${f(pct(Ps[k], 1))} p2=${f(pct(Ps[k], 2))} p50=${f(pct(Ps[k], 50))} p98=${f(pct(Ps[k], 98))} p99=${f(pct(Ps[k], 99))} max=${f(Ps[k][Ps[k].length - 1])}  ext2-98=${f(ext[k])}`);
  }
  const absMax = Math.max(...Ps.map((a) => Math.max(Math.abs(a[0]), Math.abs(a[a.length - 1]))));
  const ulp = absMax * 2 ** -23;
  console.log(`  |pos|max=${f(absMax)}  float32 ulp at that magnitude=${f(ulp, 6)} m`);
  for (let k = 0; k < 3; k++) {
    console.log(`  scale.${'xyz'[k]} p1=${f(pct(Ss[k], 1), 5)} p50=${f(pct(Ss[k], 50), 5)} p99=${f(pct(Ss[k], 99), 5)} max=${f(Ss[k][Ss[k].length - 1], 5)}  negatives=${Ss[k].filter((v) => v < 0).length}`);
  }
  console.log(`  scale.maxAxis p10=${f(pct(Sx, 10), 5)} p50=${f(pct(Sx, 50), 5)} p90=${f(pct(Sx, 90), 5)}   scale.minAxis p50=${f(pct(Sn, 50), 5)}`);
  console.log(`  footprint ${f(sortedExt[2], 1)} x ${f(sortedExt[1], 1)} m, mean spacing sqrt(area/n)=${f(Math.sqrt(area / n), 4)} m, median maxAxis/spacing=${f(pct(Sx, 50) / Math.sqrt(area / n), 3)}`);
  console.log(`  alpha p5=${pct(As, 5)} p25=${pct(As, 25)} p50=${pct(As, 50)} p75=${pct(As, 75)} p95=${pct(As, 95)}  zero=${(100 * zeroAlpha / sampled).toFixed(2)}%  <20=${(100 * lowAlpha / sampled).toFixed(2)}%`);
  console.log(`  luma p5=${f(pct(Ls, 5), 1)} p50=${f(pct(Ls, 50), 1)} p95=${f(pct(Ls, 95), 1)}   quat|q| p1=${f(pct(Qs, 1))} p50=${f(pct(Qs, 50))} p99=${f(pct(Qs, 99))}`);
}
