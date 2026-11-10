// Building geometry from footprints (buildings.json rings) + holographic / textured materials.
import * as THREE from 'three';
import { mulberry32 } from './ui.js';

/** Remove a closing duplicate vertex and orient the ring counter-clockwise. */
export function cleanRing(ring) {
  const pts = (ring || []).map((p) => [Number(p[0]), Number(p[1])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) pts.pop();
  }
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) pts.reverse();
  return pts;
}

export function ringCentroid(ring) {
  const pts = cleanRing(ring);
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return pts.length ? [x / pts.length, y / pts.length] : [0, 0];
}

/** Greedy screen-space label placement; geometry and camera framing stay unchanged. */
export function layoutBuildingLabels(candidates, width, height, limit) {
  const placed = [];
  const margin = 8, top = 68, bottom = height - 88, gap = 6;
  const ordered = [...candidates].sort((a, b) => b.priority - a.priority || a.depth - b.depth || a.i - b.i);
  for (const candidate of ordered) {
    if (placed.length >= limit && !candidate.priority) continue;
    const { w, h } = candidate;
    if (width < w + margin * 2 || bottom - top < h) continue;
    const x = Math.max(margin + w / 2, Math.min(width - margin - w / 2, candidate.x));
    const anchorY = candidate.priority ? Math.max(top + h, Math.min(bottom, candidate.y)) : candidate.y;
    const shifts = candidate.priority ? [0, -h - gap, h + gap, -2 * (h + gap), 2 * (h + gap)] : [0];
    for (const shift of shifts) {
      const y = anchorY + shift;
      if (y - h < top || y > bottom) continue;
      const rect = { left: x - w / 2, right: x + w / 2, top: y - h, bottom: y };
      if (placed.some((p) => rect.left < p.right + gap && rect.right + gap > p.left && rect.top < p.bottom + gap && rect.bottom + gap > p.top)) continue;
      placed.push({ ...candidate, ...rect, x, y });
      break;
    }
  }
  return placed;
}

/**
 * Wall + roof geometry in a Z-up frame. Wall UVs are metric: u = distance along the facade / tile,
 * v = height above base / tile, so a seamless material texture tiles at real-world scale.
 */
export function buildingGeometry(ring, base, top, tile = 4) {
  const pts = cleanRing(ring);
  const pos = [], nrm = [], uv = [], idx = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const nx = dy / len, ny = -dx / len;
    const v0 = pos.length / 3;
    pos.push(x1, y1, base, x2, y2, base, x2, y2, top, x1, y1, top);
    for (let k = 0; k < 4; k++) nrm.push(nx, ny, 0);
    const u0 = acc / tile, u1 = (acc + len) / tile, vh = (top - base) / tile;
    uv.push(u0, 0, u1, 0, u1, vh, u0, vh);
    idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    acc += len;
  }
  const walls = new THREE.BufferGeometry();
  walls.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  walls.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  walls.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  walls.setIndex(idx);
  walls.computeBoundingSphere();

  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  const roof = new THREE.ShapeGeometry(shape);
  const rp = roof.attributes.position;
  for (let i = 0; i < rp.count; i++) rp.setZ(i, top);
  const ruv = roof.attributes.uv;
  for (let i = 0; i < ruv.count; i++) ruv.setXY(i, rp.getX(i) / tile, rp.getY(i) / tile);
  rp.needsUpdate = true;
  roof.computeVertexNormals();
  roof.computeBoundingSphere();
  return { walls, roof, perimeter: acc };
}

/** Holographic building shader: fresnel rim, floor lines and a vertical scan band. */
export function hologramMaterial(color = '#53e3ff') {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0.9 },
      uHighlight: { value: 0 },
      uBase: { value: 0 },
      uHeight: { value: 10 },
      uFloors: { value: 3 },
      uUp: { value: new THREE.Vector3(0, 0, 1) },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uUp;
      uniform float uBase, uHeight;
      varying vec3 vN;
      varying vec3 vView;
      varying float vH;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vView = cameraPosition - w.xyz;
        vH = (position.z - uBase) / max(uHeight, 0.001);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime, uOpacity, uHighlight, uFloors;
      varying vec3 vN;
      varying vec3 vView;
      varying float vH;
      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.0);
        float h = clamp(vH, 0.0, 1.0);
        float floors = smoothstep(0.90, 1.0, fract(vH * uFloors)) * step(0.02, h) * step(h, 0.98);
        float band = fract(uTime * 0.22);
        float scan = smoothstep(0.035, 0.0, abs(h - band));
        float topEdge = smoothstep(0.96, 1.0, h);
        vec3 col = uColor * (0.22 + fres * 1.1 + floors * 0.55 + topEdge * 0.6) + vec3(0.8, 0.95, 1.0) * scan * 0.55;
        col = mix(col, vec3(1.0, 0.78, 0.38) * (0.4 + fres), uHighlight * 0.65);
        float a = (0.07 + fres * 0.45 + floors * 0.22 + scan * 0.35 + topEdge * 0.2) * uOpacity * (1.0 + uHighlight * 1.2);
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
      }`,
  });
}

/** Overlay layer of holographic buildings for the 3DGS viewer. */
export class BuildingLayer extends THREE.Group {
  constructor() {
    super();
    this.name = 'BuildingLayer';
    this.items = [];
    this.selected = -1;
    this.hovered = -1;
    this.offset = new THREE.Vector3();
    this.renderOrder = 1;
  }

  setData(buildings, offset = new THREE.Vector3()) {
    this.clear();
    this.items = [];
    this.hovered = -1;
    this.selected = -1;
    this.offset.copy(offset);
    this.position.copy(offset);
    for (const b of buildings || []) {
      if (!b || !Array.isArray(b.ring) || b.ring.length < 3) continue;
      const base = Number(b.base) || 0;
      const top = Number.isFinite(Number(b.top)) ? Number(b.top) : base + (Number(b.height_m) || 10);
      const { walls, roof } = buildingGeometry(b.ring, base, top, 4);
      const mat = hologramMaterial();
      mat.uniforms.uBase.value = base;
      mat.uniforms.uHeight.value = Math.max(0.5, top - base);
      mat.uniforms.uFloors.value = Math.max(1, Number(b.floors) || Math.round((top - base) / 3.2));
      const wallMesh = new THREE.Mesh(walls, mat);
      const roofMat = mat.clone();
      roofMat.uniforms = THREE.UniformsUtils.clone(mat.uniforms);
      roofMat.uniforms.uOpacity.value = 0.55;
      const roofMesh = new THREE.Mesh(roof, roofMat);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(walls, 25),
        new THREE.LineBasicMaterial({ color: 0x7fe9ff, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      const outline = buildingOutline(b.ring, base, top);
      const g = new THREE.Group();
      g.add(wallMesh, roofMesh, edges, outline);
      g.userData.building = b;
      wallMesh.userData.bIndex = this.items.length;
      roofMesh.userData.bIndex = this.items.length;
      for (const o of [wallMesh, roofMesh, edges]) o.renderOrder = 1;
      this.add(g);
      const [cx, cy] = Number.isFinite(b.cx) && Number.isFinite(b.cy) ? [b.cx, b.cy] : ringCentroid(b.ring);
      this.items.push({ data: b, group: g, walls: wallMesh, roof: roofMesh, edges, outline, ring: cleanRing(b.ring), mats: [mat, roofMat], base, top, center: new THREE.Vector3(cx, cy, (base + top) / 2), topCenter: new THREE.Vector3(cx, cy, top) });
    }
  }

  setOffset(v) { this.offset.copy(v); this.position.copy(v); }

  worldCenter(i, out = new THREE.Vector3()) { return out.copy(this.items[i].center).add(this.offset); }
  worldTop(i, out = new THREE.Vector3()) { return out.copy(this.items[i].topCenter).add(this.offset); }

  pickables() { return this.items.flatMap((it) => [it.walls, it.roof]); }

  /**
   * hover-v2: project the footprint ring (base) and the roof ring (top) of building i to viewport
   * pixels and return their convex hull plus its bounding box. null when nothing is in front of the camera.
   */
  screenHull(i, camera, width, height) {
    const it = this.items[i];
    if (!it || !it.ring || it.ring.length < 3 || !camera) return null;
    this.updateMatrixWorld();
    const pts = [];
    let clipped = 0;
    for (const z of [it.base, it.top]) {
      for (const p of it.ring) {
        _hullV.set(p[0], p[1], z).applyMatrix4(this.matrixWorld).project(camera);
        if (!(_hullV.z >= -1 && _hullV.z <= 1)) { clipped++; continue; }
        pts.push([(_hullV.x + 1) * 0.5 * width, (1 - _hullV.y) * 0.5 * height]);
      }
    }
    if (pts.length < 3) return null;
    const hull = convexHull2D(pts);
    if (hull.length < 3) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of hull) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { hull, minX, minY, maxX, maxY, clipped };
  }

  setSelected(i) { this.selected = i; this._refresh(); }
  setHovered(i) { if (this.hovered !== i) { this.hovered = i; this._refresh(); } }

  _refresh() {
    this.items.forEach((it, i) => {
      const sel = i === this.selected;
      const hov = i === this.hovered;
      const h = sel ? 1 : hov ? 0.6 : 0;
      for (const m of it.mats) m.uniforms.uHighlight.value = h;
      it.edges.material.color.set(sel ? 0xffd27a : hov ? 0xbff6ff : 0x7fe9ff);
      it.edges.material.opacity = sel ? 0.95 : hov ? 0.9 : 0.55;
      if (it.outline) {
        it.outline.visible = sel || hov;
        for (const o of it.outline.children) {
          o.material.color.setHex(sel ? OUTLINE_SELECTED : OUTLINE_HOVER);
          o.material.opacity = 1;
        }
      }
    });
  }

  update(t) {
    for (const it of this.items) for (const m of it.mats) m.uniforms.uTime.value = t;
    const hov = this.items[this.hovered];
    if (hov && hov.outline && hov.outline.visible && this.hovered !== this.selected) {
      const k = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(t * 5.5));
      for (const o of hov.outline.children) o.material.opacity = k;
    }
  }

  dispose() {
    this.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.clear();
    this.items = [];
    this.hovered = -1;
    this.selected = -1;
  }
}

/** Physically based facade material using a seamless texture from the material agent. */
export function facadeMaterial(texture, { roughness = 0.62, metalness = 0.08, envIntensity = 1 } = {}) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness, metalness, envMapIntensity: envIntensity });
  if (texture) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    m.map = texture;
  }
  return m;
}

/**
 * Procedural district generator: returns buildings in the same schema as buildings.json
 * (ring, base, top, height_m, floors, area_m2, cx, cy) so both sources share one pipeline.
 */
export function proceduralDistrict({ rows = 4, cols = 5, block = 34, street = 14, minH = 9, maxH = 60, seed = 7, floorH = 3.2, lShapeRatio = 0.3 } = {}) {
  const rand = mulberry32(seed);
  const out = [];
  let id = 0;
  const totalW = cols * block + (cols - 1) * street;
  const totalD = rows * block + (rows - 1) * street;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = -totalW / 2 + c * (block + street);
      const y0 = -totalD / 2 + r * (block + street);
      const lots = rand() < 0.45 ? 2 : 1;
      for (let k = 0; k < lots; k++) {
        const lw = lots === 2 ? block / 2 - 2 : block - 4;
        const lx = x0 + 2 + (lots === 2 ? k * (block / 2) : 0);
        const ly = y0 + 2;
        const w = lw * (0.6 + rand() * 0.35);
        const d = (block - 4) * (0.55 + rand() * 0.4);
        const ox = lx + (lw - w) * rand();
        const oy = ly + (block - 4 - d) * rand();
        let ring;
        if (rand() < lShapeRatio) {
          const cw = w * (0.4 + rand() * 0.25), cd = d * (0.4 + rand() * 0.25);
          ring = [[ox, oy], [ox + w, oy], [ox + w, oy + d - cd], [ox + w - cw, oy + d - cd], [ox + w - cw, oy + d], [ox, oy + d]];
        } else {
          ring = [[ox, oy], [ox + w, oy], [ox + w, oy + d], [ox, oy + d]];
        }
        const centerBias = 1 - Math.min(1, Math.hypot(ox + w / 2, oy + d / 2) / (Math.max(totalW, totalD) * 0.6));
        const h = minH + (maxH - minH) * Math.pow(rand(), 1.6) * (0.35 + 0.65 * centerBias);
        const floors = Math.max(1, Math.round(h / floorH));
        const height = floors * floorH;
        let area = 0;
        for (let i = 0; i < ring.length; i++) {
          const [x1, y1] = ring[i];
          const [x2, y2] = ring[(i + 1) % ring.length];
          area += x1 * y2 - x2 * y1;
        }
        const [cx, cy] = ringCentroid(ring);
        out.push({ id: id++, ring, base: 0, top: height, height_m: +height.toFixed(2), floors, area_m2: +Math.abs(area / 2).toFixed(1), cx, cy, procedural: true });
      }
    }
  }
  return out;
}


/* ------------------------------------------------------------------ hover-v2: outline + screen-space hull */
export const OUTLINE_HOVER = 0x53e3ff;
export const OUTLINE_SELECTED = 0xffc861;
const _hullV = new THREE.Vector3();

/**
 * Exact footprint + roof contour plus the vertical edges at real corners, as one LineSegments.
 * depthTest is off so the contour stays readable through the 3DGS splats and the hologram walls.
 * Hidden by default; BuildingLayer._refresh shows it for the hovered / selected building.
 */
export function buildingOutline(ring, base, top) {
  const pts = cleanRing(ring);
  const n = pts.length;
  const pos = [];
  const lift = 0.05;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    pos.push(x1, y1, base + lift, x2, y2, base + lift);
    pos.push(x1, y1, top + lift, x2, y2, top + lift);
  }
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], bx = p2[0] - p1[0], by = p2[1] - p1[1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    const cos = (ax * bx + ay * by) / (la * lb);
    // noisy nDSM rings have many tiny kinks: only draw verticals at real corners (turn > ~32 deg)
    if (n <= 8 || cos < 0.85) pos.push(p1[0], p1[1], base + lift, p1[0], p1[1], top + lift);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeBoundingSphere();
  const mat = new THREE.LineBasicMaterial({ color: OUTLINE_HOVER, transparent: true, opacity: 1, depthTest: false, depthWrite: false });
  const line = new THREE.LineSegments(geo, mat);
  line.renderOrder = 20;
  const g = new THREE.Group();
  g.name = 'BuildingOutline';
  g.add(line);
  g.visible = false;
  return g;
}

/** Andrew's monotone chain. Returns the hull without repeating the first point. */
export function convexHull2D(points) {
  const p = points.filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
