import * as THREE from "three";
import { waveHeight } from "./waves.ts";

// Water effects in game coordinates (x across, z forward), drawn relative to
// the scene's origin. Particles are soft round sprites lit by the sun colour;
// the wake is a strip of foam laid on the waves behind the jetski.

const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * uScale / max(0.2, -mvPosition.z);
  // Fade out right in front of the lens instead of smearing across the screen.
  vAlpha = aAlpha * smoothstep(2.0, 5.5, -mvPosition.z);
  vColor = aColor;
  #include <fog_vertex>
}`;

const PARTICLE_FRAG = /* glsl */ `
uniform vec3 uLight;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.12, d) * vAlpha;
  // Lit from above, a little darker underneath: reads as a droplet, not a disc.
  float shade = 0.78 + 0.45 * (0.5 - c.y);
  gl_FragColor = vec4(vColor * uLight * shade, a);
  #include <fog_fragment>
}`;

export class Particles {
  readonly points: THREE.Points;
  private n = 0;
  private readonly max: number;
  private readonly pos: Float64Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly span: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly colour: Float32Array;
  private readonly physics: Float32Array; // gravity, drag
  private readonly aPos: THREE.BufferAttribute;
  private readonly aSize: THREE.BufferAttribute;
  private readonly aAlpha: THREE.BufferAttribute;
  private readonly aColor: THREE.BufferAttribute;
  readonly material: THREE.ShaderMaterial;

  constructor(max: number, light: THREE.Color) {
    this.max = max;
    this.pos = new Float64Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.span = new Float32Array(max);
    this.size = new Float32Array(max * 2);
    this.alpha = new Float32Array(max);
    this.colour = new Float32Array(max * 3);
    this.physics = new Float32Array(max * 2);
    const geometry = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", this.aPos);
    geometry.setAttribute("aSize", this.aSize);
    geometry.setAttribute("aAlpha", this.aAlpha);
    geometry.setAttribute("aColor", this.aColor);
    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 500 }, uLight: { value: light } }]),
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.material.uniforms.uLight.value = light;
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  get count() {
    return this.n;
  }

  clear() {
    this.n = 0;
  }

  /** Pixels per metre at 1 m away, so `size` is in metres. */
  setScale(pixelsPerMetre: number) {
    this.material.uniforms.uScale.value = pixelsPerMetre;
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size0: number,
    size1: number,
    alpha: number,
    colour: THREE.Color,
    gravity = 9.8,
    drag = 0.6,
  ) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = life;
    this.span[i] = life;
    this.size[i * 2] = size0;
    this.size[i * 2 + 1] = size1;
    this.alpha[i] = alpha;
    this.colour.set([colour.r, colour.g, colour.b], i * 3);
    this.physics[i * 2] = gravity;
    this.physics[i * 2 + 1] = drag;
  }

  update(dt: number, originZ: number) {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] -= dt;
      const y = this.pos[i * 3 + 1];
      if (this.life[i] <= 0 || (y < -0.3 && this.vel[i * 3 + 1] < 0)) {
        this.move(this.n - 1, i);
        this.n--;
        continue;
      }
      const drag = Math.max(0, 1 - this.physics[i * 2 + 1] * dt);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 2] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag - this.physics[i * 2] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    const p = this.aPos.array as Float32Array;
    const s = this.aSize.array as Float32Array;
    const a = this.aAlpha.array as Float32Array;
    const c = this.aColor.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      const t = 1 - this.life[i] / this.span[i];
      p[i * 3] = this.pos[i * 3];
      p[i * 3 + 1] = this.pos[i * 3 + 1];
      p[i * 3 + 2] = -(this.pos[i * 3 + 2] - originZ);
      s[i] = this.size[i * 2] + (this.size[i * 2 + 1] - this.size[i * 2]) * t;
      // Quick fade in, long fade out.
      a[i] = this.alpha[i] * Math.min(1, t * 8) * Math.pow(1 - t, 1.3);
      c[i * 3] = this.colour[i * 3];
      c[i * 3 + 1] = this.colour[i * 3 + 1];
      c[i * 3 + 2] = this.colour[i * 3 + 2];
    }
    for (const attr of [this.aPos, this.aSize, this.aAlpha, this.aColor]) attr.needsUpdate = true;
    this.points.geometry.setDrawRange(0, this.n);
  }

  private move(from: number, to: number) {
    if (from === to) return;
    for (let k = 0; k < 3; k++) {
      this.pos[to * 3 + k] = this.pos[from * 3 + k];
      this.vel[to * 3 + k] = this.vel[from * 3 + k];
      this.colour[to * 3 + k] = this.colour[from * 3 + k];
    }
    this.life[to] = this.life[from];
    this.span[to] = this.span[from];
    this.size[to * 2] = this.size[from * 2];
    this.size[to * 2 + 1] = this.size[from * 2 + 1];
    this.alpha[to] = this.alpha[from];
    this.physics[to * 2] = this.physics[from * 2];
    this.physics[to * 2 + 1] = this.physics[from * 2 + 1];
  }
}

const WAKE_VERT = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vAlpha = aAlpha * smoothstep(3.0, 9.0, -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const WAKE_FRAG = /* glsl */ `
uniform sampler2D uFoam;
uniform vec3 uLight;
varying float vAlpha;
varying vec2 vUv;
#include <fog_pars_fragment>
void main() {
  float f = texture2D(uFoam, vUv).r;
  float f2 = texture2D(uFoam, vUv * 2.3 + 0.41).r;
  float foam = clamp(f * 1.3 + f2 * 0.8, 0.0, 1.0);
  // Broken, lacy foam: only where the pattern is strong, more of it where the water is churned.
  float a = vAlpha * smoothstep(0.55 - 0.35 * vAlpha, 0.95 - 0.3 * vAlpha, foam);
  gl_FragColor = vec4(vec3(1.0) * uLight * 1.15, a);
  #include <fog_fragment>
}`;

const ACROSS = [-1, -0.88, -0.65, -0.35, -0.12, 0, 0.12, 0.35, 0.65, 0.88, 1];
const WAKE_LIFE = 3.2;

/** A V of foam spreading behind the jetski, churned white right behind the jet. */
export class Wake {
  readonly mesh: THREE.Mesh;
  private samples: { x: number; z: number; t: number; strength: number }[] = [];
  private readonly maxSamples: number;
  private readonly positions: Float32Array;
  private readonly uvs: Float32Array;
  private readonly alphas: Float32Array;
  private readonly geometry: THREE.BufferGeometry;

  constructor(foam: THREE.Texture, light: THREE.Color, maxSamples = 120) {
    this.maxSamples = maxSamples;
    const verts = maxSamples * ACROSS.length;
    this.positions = new Float32Array(verts * 3);
    this.uvs = new Float32Array(verts * 2);
    this.alphas = new Float32Array(verts);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("uv", new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aAlpha", new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    const index: number[] = [];
    const w = ACROSS.length;
    for (let i = 0; i < maxSamples - 1; i++) {
      for (let k = 0; k < w - 1; k++) {
        const a = i * w + k;
        index.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
      }
    }
    geometry.setIndex(index);
    this.geometry = geometry;
    const material = new THREE.ShaderMaterial({
      vertexShader: WAKE_VERT,
      fragmentShader: WAKE_FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uFoam: { value: foam }, uLight: { value: light } }]),
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    material.uniforms.uFoam.value = foam;
    material.uniforms.uLight.value = light;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  clear() {
    this.samples = [];
  }

  /** Drops a point of the trail; strength 0 marks a gap (airborne). */
  add(x: number, z: number, time: number, strength: number) {
    this.samples.unshift({ x, z, t: time, strength });
    if (this.samples.length > this.maxSamples) this.samples.pop();
  }

  update(originZ: number, time: number) {
    while (this.samples.length && time - this.samples[this.samples.length - 1].t >= WAKE_LIFE) this.samples.pop();
    const w = ACROSS.length;
    const n = this.samples.length;
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const age = time - s.t;
      const fade = Math.pow(1 - age / WAKE_LIFE, 1.6) * s.strength;
      const half = 0.35 + age * 1.3; // the V opens as it ages
      const v = (s.z * 0.18) % 1;
      // Churned water never runs ruler-straight: let the trail meander a little as it ages.
      const drift = (Math.sin(s.z * 0.9) * 0.6 + Math.sin(s.z * 2.3) * 0.4) * Math.min(0.35, age * 0.25);
      for (let k = 0; k < w; k++) {
        const across = ACROSS[k];
        const x = s.x + drift + across * half;
        const j = i * w + k;
        this.positions[j * 3] = x;
        this.positions[j * 3 + 1] = waveHeight(x, s.z, time) + 0.1;
        this.positions[j * 3 + 2] = -(s.z - originZ);
        this.uvs[j * 2] = across * half * 0.35;
        this.uvs[j * 2 + 1] = v;
        // White water churned right behind the jet, then the two spreading arms.
        // A narrow strip of churned white water straight behind the jet...
        const d = Math.abs(across) * half;
        const centre = Math.exp(-((d / 0.5) ** 2)) * Math.exp(-age * 1.1);
        // ...and the two thin arms of the V, which take a moment to form.
        const arms = Math.exp(-(((half - d) / 0.3) ** 2)) * Math.exp(-age * 0.5) * Math.min(1, age * 2.5);
        this.alphas[j] = Math.min(0.85, centre + arms * 0.75) * fade;
      }
    }
    // Hide the unused tail of the strip.
    for (let j = n * w; j < this.maxSamples * w; j++) this.alphas[j] = 0;
    for (const name of ["position", "uv", "aAlpha"]) this.geometry.getAttribute(name).needsUpdate = true;
    this.geometry.setDrawRange(0, Math.max(0, (n - 1) * (w - 1) * 6));
  }
}
