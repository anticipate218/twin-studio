// Ambient 3D effects: scanning ground grid, floating dust, star dome.
import * as THREE from 'three';

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-6))));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** Infinite-looking holographic grid with a radar scan ring, oriented by an up vector. */
export class GroundGrid extends THREE.Mesh {
  constructor() {
    const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uCell: { value: 10 },
        uRadius: { value: 300 },
        uColor: { value: new THREE.Color('#3aa8ff') },
        uScan: { value: new THREE.Color('#53e3ff') },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vLocal;
        uniform float uRadius;
        void main() {
          vLocal = position.xy * uRadius * 2.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy * uRadius * 2.0, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vLocal;
        uniform float uTime, uCell, uRadius, uOpacity;
        uniform vec3 uColor, uScan;
        float gridLine(vec2 p, float cell) {
          vec2 c = p / cell;
          vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
          return 1.0 - min(min(g.x, g.y), 1.0);
        }
        void main() {
          float d = length(vLocal);
          float fade = 1.0 - smoothstep(uRadius * 0.35, uRadius, d);
          float minor = gridLine(vLocal, uCell);
          float major = gridLine(vLocal, uCell * 5.0);
          float cycle = mod(uTime * 0.12, 1.0);
          float ringR = cycle * uRadius;
          float ring = exp(-pow((d - ringR) / (uRadius * 0.018), 2.0)) * (1.0 - cycle);
          float axis = (1.0 - smoothstep(0.0, uCell * 0.06, abs(vLocal.x))) + (1.0 - smoothstep(0.0, uCell * 0.06, abs(vLocal.y)));
          vec3 col = uColor * (minor * 0.45 + major * 0.9) + uScan * (ring * 1.2 + axis * 0.25);
          float a = (minor * 0.16 + major * 0.38 + ring * 0.45 + axis * 0.15) * fade * uOpacity;
          if (a < 0.003) discard;
          gl_FragColor = vec4(col, a);
        }`,
    });
    super(geometry, material);
    this.name = 'GroundGrid';
    this.renderOrder = -1;
    this.frustumCulled = false;
  }

  place(center, up, radius) {
    this.position.copy(center);
    this.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up.clone().normalize());
    this.material.uniforms.uRadius.value = radius;
    this.material.uniforms.uCell.value = niceStep(radius / 24);
  }

  update(t) { this.material.uniforms.uTime.value = t; }
}

function softDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(180,235,255,0.8)');
  grd.addColorStop(1, 'rgba(120,160,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Slowly drifting luminous dust inside the scene volume. */
export class DustField extends THREE.Points {
  constructor(count = 1400) {
    const geometry = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[3 * i] = Math.random() * 2 - 1;
      pos[3 * i + 1] = Math.random() * 2 - 1;
      pos[3 * i + 2] = Math.random();
      seed[i] = Math.random();
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 18 },
        uMap: { value: softDotTexture() },
        uBasis: { value: new THREE.Matrix4() },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      vertexShader: /* glsl */ `
        attribute float seed;
        uniform float uTime, uSize, uPixelRatio;
        uniform mat4 uBasis;
        varying float vAlpha;
        void main() {
          vec3 p = position;
          p.z = fract(p.z + uTime * (0.006 + seed * 0.01));
          p.x += sin(uTime * 0.2 + seed * 40.0) * 0.02;
          p.y += cos(uTime * 0.17 + seed * 30.0) * 0.02;
          vec4 world = uBasis * vec4(p, 1.0);
          vec4 mv = viewMatrix * world;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * uPixelRatio * (0.4 + seed) / max(1.0, -mv.z * 0.02);
          vAlpha = (0.25 + 0.75 * seed) * smoothstep(0.0, 0.15, p.z) * (1.0 - smoothstep(0.75, 1.0, p.z));
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(t.rgb * vec3(0.55, 0.85, 1.0), t.a * vAlpha * 0.55);
        }`,
    });
    super(geometry, material);
    this.name = 'DustField';
    this.frustumCulled = false;
    this.renderOrder = 2;
  }

  /** Map the unit volume onto a box: center, horizontal axes r/f, up axis u, half extent and height. */
  place(center, right, forward, up, halfExtent, height) {
    const m = new THREE.Matrix4().makeBasis(
      right.clone().multiplyScalar(halfExtent),
      forward.clone().multiplyScalar(halfExtent),
      up.clone().multiplyScalar(height),
    );
    m.setPosition(center);
    this.material.uniforms.uBasis.value.copy(m);
  }

  update(t) { this.material.uniforms.uTime.value = t; }
}

/** Star dome that follows the camera (rendered first, behind everything). */
export class StarDome extends THREE.Points {
  constructor(count = 2600) {
    const geometry = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const tw = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos[3 * i] = r * Math.cos(th);
      pos[3 * i + 1] = r * Math.sin(th);
      pos[3 * i + 2] = u;
      tw[i] = Math.random();
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('tw', new THREE.BufferAttribute(tw, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) } },
      vertexShader: /* glsl */ `
        attribute float tw;
        uniform float uTime, uPixelRatio;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position * 1000.0, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_Position.z = gl_Position.w * 0.9999;
          gl_PointSize = (1.0 + tw * 2.2) * uPixelRatio;
          vA = 0.25 + 0.75 * (0.5 + 0.5 * sin(uTime * (0.6 + tw * 2.0) + tw * 60.0));
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(vec3(0.75, 0.88, 1.0), (1.0 - d * 2.0) * vA * 0.8);
        }`,
    });
    super(geometry, material);
    this.name = 'StarDome';
    this.frustumCulled = false;
    this.renderOrder = -10;
  }

  update(t, camera) {
    this.material.uniforms.uTime.value = t;
    this.position.copy(camera.position);
    this.scale.setScalar(camera.far * 0.0009);
  }
}
