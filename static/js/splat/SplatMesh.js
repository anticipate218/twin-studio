// SplatMesh — a three.js Mesh that renders 3D Gaussian Splatting scenes stored in the
// antimatter15 ".splat" format (the format of every model in web3d/models).
// Rendering follows the EWA projection used by antimatter15/splat, adapted to three.js
// camera conventions (view looks down -Z) with back-to-front premultiplied blending, so the
// splats composite correctly over three.js backgrounds, grids and other effects.
import * as THREE from 'three';

const VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D u_texture;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 u_focal;
uniform vec2 u_viewport;
uniform float u_scaleMod;
uniform float u_alphaMod;
uniform float u_brightness;
uniform float u_pointMode;
uniform float u_pointSize;
uniform vec4 u_clipMin;
uniform vec4 u_clipMax;

in vec3 position;
in float splatIndex;

out vec4 vColor;
out vec2 vPosition;

void cull() { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vColor = vec4(0.0); vPosition = vec2(0.0); }

void main() {
  uint idx = uint(splatIndex);
  ivec2 tc = ivec2(int((idx & 1023u) << 1), int(idx >> 10));
  uvec4 cen = texelFetch(u_texture, tc, 0);
  vec3 p = uintBitsToFloat(cen.xyz);
  if (u_clipMax.w > 0.5 && (any(lessThan(p, u_clipMin.xyz)) || any(greaterThan(p, u_clipMax.xyz)))) { cull(); return; }

  vec4 cam = modelViewMatrix * vec4(p, 1.0);
  if (cam.z > -0.02) { cull(); return; }
  vec4 pos2d = projectionMatrix * cam;
  float clip = 1.2 * pos2d.w;
  if (pos2d.z < -clip || pos2d.z > clip || pos2d.x < -clip || pos2d.x > clip || pos2d.y < -clip || pos2d.y > clip) { cull(); return; }

  uvec4 cov = texelFetch(u_texture, ivec2(tc.x + 1, tc.y), 0);
  vec2 u1 = unpackHalf2x16(cov.x);
  vec2 u2 = unpackHalf2x16(cov.y);
  vec2 u3 = unpackHalf2x16(cov.z);
  mat3 Vrk = mat3(u1.x, u1.y, u2.x, u1.y, u2.y, u3.x, u2.x, u3.x, u3.y) * (u_scaleMod * u_scaleMod);

  float z = cam.z;
  float z2 = z * z;
  mat3 J = mat3(
    u_focal.x / -z, 0.0, 0.0,
    0.0, u_focal.y / -z, 0.0,
    u_focal.x * cam.x / z2, u_focal.y * cam.y / z2, 0.0
  );
  mat3 T = J * mat3(modelViewMatrix);
  mat3 cov2d = T * Vrk * transpose(T);

  float a = cov2d[0][0] + 0.3;
  float b = cov2d[0][1];
  float d = cov2d[1][1] + 0.3;
  float mid = 0.5 * (a + d);
  float radius = length(vec2(0.5 * (a - d), b));
  float lambda1 = mid + radius;
  float lambda2 = mid - radius;
  if (lambda2 < 0.0) { cull(); return; }
  vec2 dv = vec2(b, lambda1 - a);
  dv = dot(dv, dv) < 1e-12 ? vec2(1.0, 0.0) : normalize(dv);
  vec2 majorAxis = min(sqrt(2.0 * lambda1), 1024.0) * dv;
  vec2 minorAxis = min(sqrt(2.0 * lambda2), 1024.0) * vec2(dv.y, -dv.x);

  vec4 col = vec4(float(cov.w & 255u), float((cov.w >> 8) & 255u), float((cov.w >> 16) & 255u), float((cov.w >> 24) & 255u)) / 255.0;
  col.rgb *= u_brightness;
  col.a = min(1.0, col.a * u_alphaMod);
  if (u_pointMode > 0.5) {
    majorAxis = vec2(u_pointSize, 0.0);
    minorAxis = vec2(0.0, u_pointSize);
    col.a = col.a > 0.08 ? 1.0 : 0.0;
  }
  vColor = col;
  vPosition = position.xy;
  vec2 center = pos2d.xy / pos2d.w;
  gl_Position = vec4(center + position.x * majorAxis / u_viewport + position.y * minorAxis / u_viewport, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float u_pointMode;
in vec4 vColor;
in vec2 vPosition;
out vec4 fragColor;
void main() {
  float A = -dot(vPosition, vPosition);
  if (A < -4.0) discard;
  float B = u_pointMode > 0.5 ? vColor.a : exp(A) * vColor.a;
  if (B < 1.0 / 255.0) discard;
  fragColor = vec4(vColor.rgb * B, B);
}
`;

export class SplatMesh extends THREE.Mesh {
  constructor() {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = 0;
    const material = new THREE.RawShaderMaterial({
      // Gaussian quads are built with a left-handed (minor = rot(-90) of major) basis, so their
      // on-screen winding is clockwise; FrontSide culling would drop every splat.
      side: THREE.DoubleSide,
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        u_texture: { value: null },
        u_focal: { value: new THREE.Vector2(1000, 1000) },
        u_viewport: { value: new THREE.Vector2(1, 1) },
        u_scaleMod: { value: 1 },
        u_alphaMod: { value: 1 },
        u_brightness: { value: 1 },
        u_pointMode: { value: 0 },
        u_pointSize: { value: 2 },
        u_clipMin: { value: new THREE.Vector4(-1e9, -1e9, -1e9, 0) },
        u_clipMax: { value: new THREE.Vector4(1e9, 1e9, 1e9, 0) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    super(geometry, material);
    this.name = 'SplatMesh';
    this.frustumCulled = false;
    this.renderOrder = 0;
    this.visible = false;
    this.splatCount = 0;
    this.stats = null;
    this.lastSortMs = 0;
    this._texture = null;
    this._indexAttr = null;
    this._reqId = 1;
    this._waiters = new Map();
    this._sortBusy = false;
    this._sortPending = false;
    this._lastView = new Float32Array(16);
    this._hasLastView = false;
    this._viewNow = new Float32Array(16);
    this._v2 = new THREE.Vector2();
    this._mv = new THREE.Matrix4();
    this._disposed = false;
    this.worker = new Worker(new URL('./splat-worker.js', import.meta.url));
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(`splat worker error: ${e.message || e}`);
      for (const w of this._waiters.values()) w.reject(err);
      this._waiters.clear();
    };
    this.onBeforeRender = (renderer, scene, camera) => this._beforeRender(renderer, camera);
  }

  _call(msg, transfer) {
    const id = this._reqId++;
    return new Promise((resolve, reject) => {
      this._waiters.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer || []);
    });
  }

  _onMessage(m) {
    if (this._disposed) return;
    if (m.type === 'sorted') {
      if (this._indexAttr && m.indices.length === this.splatCount) {
        this._indexAttr.array.set(m.indices);
        this._indexAttr.needsUpdate = true;
      }
      this.lastSortMs = m.ms;
      this.worker.postMessage({ type: 'recycle', buffer: m.indices.buffer }, [m.indices.buffer]);
      this._sortBusy = false;
      if (this._sortPending) { this._sortPending = false; this._sendSort(); }
      return;
    }
    const w = this._waiters.get(m.id);
    if (!w) return;
    this._waiters.delete(m.id);
    if (m.type === 'error') w.reject(new Error(m.message));
    else w.resolve(m);
  }

  /** Download a .splat file (streamed, with progress) and upload it to the GPU. */
  async load(url, onProgress = () => {}, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}`);
    const total = Number(res.headers.get('Content-Length')) || 0;
    let buf = new Uint8Array(total > 0 ? total : 32 * 1024 * 1024);
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > buf.length) {
        const grown = new Uint8Array(Math.max(buf.length * 2, received + value.length));
        grown.set(buf.subarray(0, received));
        buf = grown;
      }
      buf.set(value, received);
      received += value.length;
      onProgress({ phase: 'download', loaded: received, total });
    }
    const usable = received - (received % 32);
    if (usable < 32) throw new Error('文件为空或不是有效的 .splat');
    const exact = usable === buf.length ? buf.buffer : buf.slice(0, usable).buffer;
    onProgress({ phase: 'pack', loaded: usable, total: usable });
    const m = await this._call({ type: 'load', buffer: exact }, [exact]);
    if (this._disposed) return null;
    this._setupGPU(m);
    return { stats: m.stats, bytes: received, count: m.count };
  }

  _setupGPU(m) {
    if (this._texture) this._texture.dispose();
    const tex = new THREE.DataTexture(m.tex, m.texwidth, m.texheight, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
    tex.internalFormat = 'RGBA32UI';
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    this._texture = tex;
    this.material.uniforms.u_texture.value = tex;

    const order = new Float32Array(m.count);
    for (let i = 0; i < m.count; i++) order[i] = i;
    const attr = new THREE.InstancedBufferAttribute(order, 1);
    attr.setUsage(THREE.DynamicDrawUsage);
    if (this.geometry.getAttribute('splatIndex')) this.geometry.deleteAttribute('splatIndex');
    this.geometry.setAttribute('splatIndex', attr);
    this.geometry.instanceCount = m.count;
    this._indexAttr = attr;
    this.splatCount = m.count;
    this.stats = m.stats;
    this._hasLastView = false;
    this.visible = true;
  }

  _beforeRender(renderer, camera) {
    if (!this.splatCount) return;
    const size = renderer.getDrawingBufferSize(this._v2);
    const u = this.material.uniforms;
    u.u_viewport.value.set(size.x, size.y);
    const p = camera.projectionMatrix.elements;
    u.u_focal.value.set(p[0] * size.x * 0.5, p[5] * size.y * 0.5);
    // three.js updates object.modelViewMatrix only after onBeforeRender, so compute it here.
    this._mv.multiplyMatrices(camera.matrixWorldInverse, this.matrixWorld);
    const mv = this._mv.elements;
    for (let i = 0; i < 16; i++) this._viewNow[i] = mv[i];
    if (this._hasLastView) {
      let diff = 0;
      for (let i = 0; i < 16; i++) diff = Math.max(diff, Math.abs(this._viewNow[i] - this._lastView[i]));
      const scale = this.stats ? Math.max(1, Math.abs(this.stats.p98[0] - this.stats.p2[0])) : 1;
      if (diff < 1e-5 * scale) return;
    }
    if (this._sortBusy) { this._sortPending = true; return; }
    this._sendSort();
  }

  _sendSort() {
    this._lastView.set(this._viewNow);
    this._hasLastView = true;
    this._sortBusy = true;
    this.worker.postMessage({ type: 'sort', view: this._lastView.slice(), id: 0 });
  }

  /** Nearest splat centre hit by a world-space ray (null when nothing is close). */
  async pick(origin, dir, opts = {}) {
    if (!this.splatCount) return null;
    const inv = new THREE.Matrix4().copy(this.matrixWorld).invert();
    const o = origin.clone().applyMatrix4(inv);
    const d = dir.clone().transformDirection(inv);
    const u = this.material.uniforms;
    const clip = u.u_clipMax.value.w > 0.5
      ? [u.u_clipMin.value.x, u.u_clipMin.value.y, u.u_clipMin.value.z, u.u_clipMax.value.x, u.u_clipMax.value.y, u.u_clipMax.value.z]
      : null;
    const m = await this._call({ type: 'pick', origin: o.toArray(), dir: d.toArray(), cone: opts.cone || 0.0045, minAlpha: opts.minAlpha ?? 40, clip });
    if (!m.point) return null;
    return new THREE.Vector3().fromArray(m.point).applyMatrix4(this.matrixWorld);
  }

  setClipBox(min, max, enabled) {
    const u = this.material.uniforms;
    u.u_clipMin.value.set(min[0], min[1], min[2], 0);
    u.u_clipMax.value.set(max[0], max[1], max[2], enabled ? 1 : 0);
  }

  dispose() {
    this._disposed = true;
    this.worker.terminate();
    for (const w of this._waiters.values()) w.reject(new Error('disposed'));
    this._waiters.clear();
    if (this._texture) this._texture.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
