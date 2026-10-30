import * as THREE from "three";
import { foamTexture, waterNormals } from "./textures.ts";
import { WAVE_GLSL, WAVES, wavePhases } from "./waves.ts";

// The sea is a grid around the camera, dense up close and sparse far away. Its
// vertices ride Gerstner waves; the material is three.js's physical material
// (so it reflects the sunset sky and catches the sun), with ripples, crest and
// shore foam, and light glowing through the crests patched in.

function grid(detail: number) {
  const xs: number[] = [];
  const zs: number[] = [];
  // Across: half-metre cells near the lanes, widening out to the sides.
  for (let x = 0, step = 0.5 / detail; x < 170; x += step, step *= x > 14 ? 1.05 : 1) xs.push(x);
  const across = [...xs.slice(1).map((x) => -x).reverse(), ...xs];
  // Along: from behind the camera to the horizon, growing with distance.
  for (let z = 30, step = 0.5 / detail; z > -460; z -= step, step *= z < -30 ? 1.035 : 1) zs.push(z);

  const positions = new Float32Array(across.length * zs.length * 3);
  let i = 0;
  for (const z of zs) for (const x of across) {
    positions[i++] = x;
    positions[i++] = 0;
    positions[i++] = z;
  }
  const indices: number[] = [];
  const w = across.length;
  for (let r = 0; r < zs.length - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const a = r * w + c;
      indices.push(a, a + 1, a + w, a + 1, a + w + 1, a + w);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(positions.length).fill(0), 3));
  geometry.setIndex(indices);
  return geometry;
}

export class Ocean {
  readonly mesh: THREE.Mesh;
  private readonly phases = new Float32Array(WAVES.length);
  private readonly uniforms = {
    uPhase: { value: this.phases },
    uNormalMap: { value: waterNormals() },
    uFoamMap: { value: foamTexture() },
    uDetailA: { value: new THREE.Vector2() },
    uDetailB: { value: new THREE.Vector2() },
    uFoamA: { value: new THREE.Vector2() },
    uFoamB: { value: new THREE.Vector2() },
    uShoreX: { value: 8.5 },
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uScatter: { value: new THREE.Color(0.03, 0.42, 0.38) },
  };

  constructor(detail: number, sunDir: THREE.Vector3, shoreX: number) {
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uShoreX.value = shoreX;
    const material = new THREE.MeshPhysicalMaterial({
      color: 0x0b5366,
      roughness: 0.07,
      metalness: 0,
      ior: 1.333,
      envMapIntensity: 1.1,
    });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\n${WAVE_GLSL}\nvarying vec3 vWaterPos;\nvarying vec3 vWaterNormal;\nvarying float vWaterHeight;`,
        )
        .replace(
          "#include <beginnormal_vertex>",
          `float gHeight; vec3 gNormal; vec3 gPos = gerstner(position, gNormal, gHeight);
           vec3 objectNormal = gNormal;
           vWaterPos = gPos; vWaterNormal = gNormal; vWaterHeight = gHeight;`,
        )
        .replace("#include <begin_vertex>", "vec3 transformed = gPos;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
           uniform sampler2D uNormalMap; uniform sampler2D uFoamMap;
           uniform vec2 uDetailA; uniform vec2 uDetailB; uniform vec2 uFoamA; uniform vec2 uFoamB;
           uniform float uShoreX; uniform float uTime; uniform vec3 uSunDir; uniform vec3 uScatter;
           varying vec3 vWaterPos; varying vec3 vWaterNormal; varying float vWaterHeight;`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
           // Game-space coordinates of this point (x across, z forward), for textures.
           vec2 seaXZ = vec2(vWaterPos.x, -vWaterPos.z);
           float fA = texture2D(uFoamMap, seaXZ * 0.085 + uFoamA).r;
           float fB = texture2D(uFoamMap, seaXZ * 0.21 + uFoamB).r;
           float crest = smoothstep(0.2, 0.44, vWaterHeight);
           float shoreGap = uShoreX - vWaterPos.x + 0.7 * sin(uTime * 1.1 + seaXZ.y * 0.23);
           float shore = 1.0 - smoothstep(0.0, 2.8, shoreGap);
           float seaFoam = clamp(crest * (fA * 1.7 + fB * 0.6) + shore * smoothstep(0.1, 0.55, fA + fB * 0.6), 0.0, 1.0);
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.96, 0.98), seaFoam);`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
           roughnessFactor = mix(roughnessFactor, 0.6, seaFoam);`,
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
           {
             vec3 tA = texture2D(uNormalMap, seaXZ * 0.045 + uDetailA).xyz * 2.0 - 1.0;
             vec3 tB = texture2D(uNormalMap, seaXZ * 0.12 + uDetailB).xyz * 2.0 - 1.0;
             float detail = 1.0 / (1.0 + length(vWaterPos - cameraPosition) * 0.012);
             vec3 nW = normalize(vWaterNormal + vec3(tA.x + tB.x * 0.6, 0.0, -(tA.y + tB.y * 0.6)) * 0.5 * detail);
             normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
           }`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
           {
             // Sunlight glowing through the crests when looking towards the sun.
             vec3 toEye = normalize(cameraPosition - vWaterPos);
             float againstSun = pow(max(dot(-toEye, uSunDir), 0.0), 4.0);
             float thick = smoothstep(-0.15, 0.4, vWaterHeight);
             totalEmissiveRadiance += uScatter * (0.05 + 0.55 * againstSun * thick) * (1.0 - seaFoam);
           }`,
        );
    };
    this.mesh = new THREE.Mesh(grid(detail), material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  update(originZ: number, time: number) {
    wavePhases(originZ, time, this.phases);
    const u = this.uniforms;
    u.uTime.value = time;
    // Texture offsets for the game-space position, wrapped in double precision.
    const wrap = (v: number) => v - Math.floor(v);
    u.uDetailA.value.set(wrap(time * 0.012), wrap(originZ * 0.045 + time * 0.02));
    u.uDetailB.value.set(wrap(-time * 0.018), wrap(originZ * 0.12 - time * 0.015));
    u.uFoamA.value.set(wrap(time * 0.01), wrap(originZ * 0.085 + time * 0.012));
    u.uFoamB.value.set(wrap(0.37 - time * 0.014), wrap(originZ * 0.21 + 0.37 + time * 0.009));
  }
}
