import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { SPECS, type ObstacleKind } from "./config.ts";
import { POPUP_SECONDS, type Game, type Obstacle, type Particle, type Power } from "./game.ts";
import { SKINS, type Skin } from "./save.ts";
import { Particles, Wake } from "./three/effects.ts";
import { Library, type Rider } from "./three/models.ts";
import { Ocean } from "./three/ocean.ts";
import { cloudTexture, foamTexture, sandTexture } from "./three/textures.ts";
import { waveHeight, waveSlope } from "./three/waves.ts";

// A real 3D scene for the same simulation. Everything is placed relative to
// the player (the scene's origin follows them), so numbers stay small for the
// GPU however far the run goes. Game z (forward) maps to three.js -z.

const SHORE = 8.5;
const AHEAD = 230;
const DECOR_STEP = 11;
const TAU = Math.PI * 2;

const NPC_SKINS: Skin[] = [
  { id: "npc1", name: "", price: 0, hull: "#29b6f6", stripe: "#f72585", vest: "#f9c74f", helmet: "#ffffff" },
  { id: "npc2", name: "", price: 0, hull: "#90be6d", stripe: "#277da1", vest: "#f94144", helmet: "#222222" },
  { id: "npc3", name: "", price: 0, hull: "#f8961e", stripe: "#ffffff", vest: "#577590", helmet: "#f3722c" },
];
const UMBRELLAS: [string, string][] = [
  ["#ef476f", "#ffffff"],
  ["#118ab2", "#ffd166"],
  ["#06d6a0", "#ffffff"],
  ["#f78c6b", "#073b4c"],
];

/** Where along an obstacle's length its model's origin sits. */
const ANCHOR: Record<ObstacleKind, number> = {
  boat: 2.3,
  rock: 1.1,
  log: 0.4,
  net: 0.25,
  rope: 0.2,
  deck: 0,
  pillar: 0,
  ramp: 0,
  jetski: 1.3,
  banana: 0.65,
};
const FLOATS = new Set<ObstacleKind>(["boat", "log", "net", "ramp", "jetski", "banana"]);

function hash(a: number, b = 0) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** Height of the beach at x: steep where the waves wash, flatter behind. */
export function sandHeight(x: number) {
  const d = x - SHORE;
  return d < 6 ? -0.15 + 0.15 * d : 0.75 + 0.03 * (d - 6);
}

type Quality = { pixelRatio: number; shadows: boolean; detail: number; particles: number; samples: number; bloom: boolean };

function chooseQuality(choice: "auto" | "high" | "low"): Quality {
  if (choice === "low") return { pixelRatio: 1, shadows: false, detail: 0.55, particles: 1200, samples: 0, bloom: false };
  const phone = choice === "auto" && (matchMedia("(pointer: coarse)").matches || Math.min(screen.width, screen.height) < 600);
  return phone
    ? { pixelRatio: Math.min(1.5, devicePixelRatio || 1), shadows: false, detail: 0.6, particles: 1600, samples: 0, bloom: true }
    : { pixelRatio: Math.min(1.5, devicePixelRatio || 1), shadows: true, detail: 1, particles: 4000, samples: 4, bloom: true };
}

export class Renderer3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.1, 6000);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly overlay: HTMLCanvasElement;
  private readonly octx: CanvasRenderingContext2D;
  private readonly quality: Quality;
  private readonly lib: Library;
  private readonly ocean: Ocean;
  private readonly sun = new THREE.DirectionalLight(0xffb27a, 3.0);
  private readonly sunDir = new THREE.Vector3();
  private readonly sky = new Sky();
  private readonly sand: THREE.Mesh;
  private readonly sandMap: THREE.Texture;
  private readonly spray: Particles;
  private readonly debris: Particles;
  private readonly wake: Wake;
  private readonly coins: THREE.InstancedMesh;
  private readonly buoys: THREE.InstancedMesh;
  private readonly lightColour = new THREE.Color(1.12, 1.04, 0.96);
  private player: Rider | null = null;
  private playerSkin = "";
  private readonly objects = new Map<number, { obj: THREE.Object3D; key: string }>();
  private readonly spare = new Map<string, THREE.Object3D[]>();
  private readonly powers = new Map<Power, THREE.Object3D>();
  private readonly decor = new Map<string, THREE.Object3D>();
  private readonly npcRiders = new Map<number, Rider>();
  private w = 1;
  private h = 1;
  private time = 0;
  private camX = 0;
  private duck = 0;
  private roll = 0;
  private wasAir = false;
  private lastSwitch = -10;
  private wasState = "run";
  private sprayTimer = 0;
  private wakeTimer = 0;
  private frameTimes: number[] = [];
  private readonly smashed = new Set<number>();
  private readonly copied = new WeakSet<Particle>();
  private horizonGroup: THREE.Group | null = null;
  private lastOrigin = 0;
  private readonly police: { group: THREE.Group; red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial };
  private readonly rearCamera = new THREE.PerspectiveCamera(55, 3, 0.5, 400);
  private readonly mirror = { x: 0, y: 0, w: 0, h: 0 };
  private readonly look = new THREE.Vector3(0, 1.2, -14);
  private camY = 3;
  private yaw = 0;
  private prevX = 0;
  private lastVy = 0;
  private wasAirForKick = false;
  private landKick = 0;
  private tier = 0;
  private readonly showFps = new URLSearchParams(location.search).has("fps");
  private fpsText = "";
  private readonly seenIds = new Set<number>();
  private readonly seenPowers = new Set<Power>();
  private readonly seenDecor = new Set<string>();
  private readonly otherWakes: { wake: Wake; id: number; last: number }[] = [];
  private readonly drops: { x: number; y: number; r: number; life: number; max: number; vy: number }[] = [];
  private readonly gulls: { obj: THREE.Group; x: number; y: number; z: number; phase: number }[] = [];
  private readonly dolphins: { obj: THREE.Object3D; x: number; z: number; vz: number; t: number; jumps: number; surfaced: boolean }[] = [];
  private nextPod = 8;
  private readonly dummy = new THREE.Object3D();
  private readonly white = new THREE.Color(0.95, 0.98, 1.0);
  private readonly mist = new THREE.Color(0.85, 0.92, 0.98);
  private readonly brown = new THREE.Color(0.35, 0.24, 0.14);
  private readonly gold = new THREE.Color(1.0, 0.82, 0.3);

  constructor(canvas: HTMLCanvasElement, quality: "auto" | "high" | "low" = "auto") {
    this.quality = chooseQuality(quality);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.42;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // A low sun ahead and to the left, over the open sea: the classic golden path on the water.
    const elevation = THREE.MathUtils.degToRad(2.2);
    const azimuth = THREE.MathUtils.degToRad(-24);
    this.sunDir.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));

    this.setupSky();
    this.scene.fog = new THREE.FogExp2(0xd99a7c, 0.0024);

    this.sun.castShadow = this.quality.shadows;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -24;
    sc.right = 24;
    sc.top = 24;
    sc.bottom = -24;
    sc.near = 1;
    sc.far = 200;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new THREE.HemisphereLight(0xffd9c4, 0x0b4552, 0.55));
    // A soft fill from behind the camera: the sun is ahead, and the rider must not be a silhouette.
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.9);
    fill.position.set(-3, 6, 12);
    this.scene.add(fill);

    this.lib = new Library();
    this.ocean = new Ocean(this.quality.detail, this.sunDir, SHORE);
    this.scene.add(this.ocean.mesh);

    // The beach: a strip of sand rising from the waterline, scrolling with the run.
    this.sandMap = sandTexture();
    const sandGeo = new THREE.PlaneGeometry(80, 1500, 40, 60).rotateX(-Math.PI / 2).translate(SHORE - 2 + 40, 0, -720);
    const sp = sandGeo.getAttribute("position");
    const uv = sandGeo.getAttribute("uv");
    for (let i = 0; i < sp.count; i++) {
      const x = sp.getX(i);
      sp.setY(i, sandHeight(x) + Math.sin(x * 0.7) * 0.04);
      uv.setXY(i, x / 6, -sp.getZ(i) / 6);
    }
    sandGeo.computeVertexNormals();
    const sandMat = new THREE.MeshStandardMaterial({ map: this.sandMap, roughness: 0.95 });
    sandMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vSandY;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSandY = position.y;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vSandY;")
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.05, 0.5, vSandY));",
        )
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\nroughnessFactor = mix(0.35, roughnessFactor, smoothstep(0.05, 0.4, vSandY));",
        );
    };
    this.sand = new THREE.Mesh(sandGeo, sandMat);
    this.sand.receiveShadow = this.quality.shadows;
    this.scene.add(this.sand);
    this.addHorizon();

    this.spray = new Particles(this.quality.particles, this.lightColour);
    this.debris = new Particles(800, this.lightColour);
    this.wake = new Wake(foamTexture(), this.lightColour);
    this.scene.add(this.spray.points, this.debris.points, this.wake.mesh);

    this.coins = new THREE.InstancedMesh(this.lib.coinGeometry(), this.lib.mats.gold, 400);
    this.coins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coins.castShadow = this.quality.shadows;
    this.coins.frustumCulled = false;
    this.buoys = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 14, 10), this.lib.mats.orange, 40);
    this.buoys.frustumCulled = false;
    this.scene.add(this.coins, this.buoys);

    this.composer = new EffectComposer(
      this.renderer,
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.quality.samples }),
    );
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.5, 1.05);
    this.bloom.enabled = this.quality.bloom;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    for (let i = 0; i < 3; i++) {
      const wake = new Wake(foamTexture(), this.lightColour, 70);
      this.scene.add(wake.mesh);
      this.otherWakes.push({ wake, id: -1, last: 0 });
    }
    for (let i = 0; i < 5; i++) {
      const obj = this.lib.gull();
      obj.visible = false;
      this.scene.add(obj);
      this.gulls.push({ obj, x: 0, y: 0, z: -1e9, phase: i * 1.9 });
    }
    this.police = this.lib.policeBoat();
    this.police.group.visible = false;
    this.scene.add(this.police.group);

    // Popups and speed lines stay crisp 2D on top.
    this.overlay = document.createElement("canvas");
    this.overlay.className = "overlay";
    canvas.after(this.overlay);
    this.octx = this.overlay.getContext("2d")!;

    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.prewarm();
  }

  /**
   * Builds a few of everything up front and draws it once, off screen, so no
   * shader is compiled and no model is built in the middle of a run (the hitch
   * when a new kind of obstacle first appears).
   */
  private prewarm() {
    const stock: [string, () => THREE.Object3D, number][] = [
      ...[0, 1, 2, 3].map((v): [string, () => THREE.Object3D, number] => [`boat:${v}`, () => this.lib.boat(v), 3]),
      ...[0, 1, 2, 3].map((v): [string, () => THREE.Object3D, number] => [`rock:${v}`, () => this.lib.rock(v), 2]),
      ["log", () => this.lib.log(), 3],
      ["net", () => this.lib.net(), 3],
      ...[0, 1, 2, 3, 4].map((v): [string, () => THREE.Object3D, number] => [`rope:${v}`, () => this.lib.flags(v), 1]),
      ...[-1, 0, 1].map((v): [string, () => THREE.Object3D, number] => [`deck:${v}`, () => this.lib.deck(v), 2]),
      ["pillar", () => this.lib.pillars(), 2],
      ["ramp", () => this.lib.ramp(), 2],
      ["banana", () => this.lib.banana(), 1],
      ...NPC_SKINS.map((skin, v): [string, () => THREE.Object3D, number] => [
        `npc:${v}`,
        () => {
          const r = this.lib.jetski(skin);
          r.root.userData.rider = r;
          return r.root;
        },
        2,
      ]),
      ...[0, 1, 2].map((v): [string, () => THREE.Object3D, number] => [`palm:${v}`, () => this.lib.palm(v), 8]),
      ...UMBRELLAS.map((c, v): [string, () => THREE.Object3D, number] => [`umbrella:${v}`, () => this.lib.umbrella(c), 3]),
      ["warung", () => this.lib.warung(), 3],
      ["boards", () => this.lib.surfboards(0), 3],
      ["sail", () => this.lib.sailboat(), 2],
      ["bush", () => this.lib.bush(0), 6],
      ["dolphin", () => this.lib.dolphin(), 3],
      ...(["magnet", "shield", "double", "nitro"] as const).map((k): [string, () => THREE.Object3D, number] => [`power:${k}`, () => this.lib.power(k), 2]),
    ];
    const shown: [string, THREE.Object3D][] = [];
    let i = 0;
    for (const [key, make, count] of stock) {
      for (let n = 0; n < count; n++) {
        const obj = make();
        obj.position.set(((i % 9) - 4) * 4, 0, -12 - Math.floor(i / 9) * 6);
        this.scene.add(obj);
        shown.push([key, obj]);
        i++;
      }
    }
    for (const skin of SKINS) this.lib.jetski(skin);
    this.police.group.visible = true;
    this.renderer.compile(this.scene, this.camera);
    this.composer.render();
    // The rear-view mirror draws straight to the screen, which needs its own shader variants.
    this.rearCamera.position.set(0, 3, 6);
    this.rearCamera.lookAt(0, 1, 40);
    this.renderer.render(this.scene, this.rearCamera);
    this.police.group.visible = false;
    for (const [key, obj] of shown) this.release(key, obj);
  }

  private setupSky() {
    const tune = (sky: Sky) => {
      const u = sky.material.uniforms;
      u.turbidity.value = 6.5;
      u.rayleigh.value = 3.2;
      u.mieCoefficient.value = 0.004;
      u.mieDirectionalG.value = 0.93;
      u.sunPosition.value.copy(this.sunDir);
    };
    this.sky.scale.setScalar(5000);
    tune(this.sky);
    this.scene.add(this.sky);
    // The same sky, baked once into an environment map: reflections on water, paint and chrome.
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(1000);
    tune(envSky);
    envScene.add(envSky);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(envScene, 0, 0.1, 2000).texture;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();
  }

  /**
   * Far scenery that travels with the camera: Gunung Agung, hazy ridges, the far
   * coast, and clouds lit by the low sun. Colours fade towards the haze with distance.
   */
  private addHorizon() {
    const far = new THREE.Group();
    const haze = new THREE.Color(0.86, 0.6, 0.55);
    const shaded = (base: THREE.Color, fog: number) =>
      new THREE.MeshBasicMaterial({ color: base.clone().lerp(haze, fog), fog: false, vertexColors: false });

    // Gunung Agung: concave slopes up to a broad summit.
    const profile: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      profile.push(new THREE.Vector2(140 + 1500 * Math.pow(1 - t, 1.8), t * 600));
    }
    const agungGeo = new THREE.LatheGeometry(profile, 64);
    const ap = agungGeo.getAttribute("position");
    for (let i = 0; i < ap.count; i++) {
      // Gullies down the flanks.
      const a = Math.atan2(ap.getZ(i), ap.getX(i));
      const k = 1 + Math.sin(a * 23) * 0.025 + Math.sin(a * 9) * 0.03;
      ap.setXYZ(i, ap.getX(i) * k, ap.getY(i), ap.getZ(i) * k);
    }
    agungGeo.computeVertexNormals();
    const agung = new THREE.Mesh(agungGeo, shaded(new THREE.Color(0.42, 0.33, 0.47), 0.35));
    agung.position.set(-2700, -10, -4300);
    far.add(agung);

    // Two ranges of hills, the further one paler.
    const ridge = (fromX: number, toX: number, z: number, height: number, colour: THREE.Color, fog: number, seed: number) => {
      const pts: number[] = [];
      const steps = 80;
      for (let i = 0; i <= steps; i++) {
        const x = fromX + ((toX - fromX) * i) / steps;
        const y = height * (0.45 + 0.35 * Math.sin(i * 0.31 + seed) + 0.2 * Math.sin(i * 0.97 + seed * 2));
        pts.push(x, -10, z, x, y, z);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const idx: number[] = [];
      for (let i = 0; i < steps; i++) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
      geo.setIndex(idx);
      const m = new THREE.Mesh(geo, shaded(colour, fog));
      (m.material as THREE.Material).side = THREE.DoubleSide;
      return m;
    };
    far.add(ridge(-6500, -800, -5200, 230, new THREE.Color(0.5, 0.4, 0.52), 0.55, 1));
    far.add(ridge(-4200, -300, -3600, 120, new THREE.Color(0.38, 0.3, 0.42), 0.4, 4));

    // The far coast on the right: wooded hills running off towards the horizon.
    const coast: number[] = [];
    const steps = 120;
    for (let i = 0; i <= steps; i++) {
      const z = -500 - i * 30;
      const x = 230 + i * 6;
      const y = 28 + 18 * Math.sin(i * 0.23) + 10 * Math.sin(i * 0.71) + 4 * Math.sin(i * 2.9);
      coast.push(x, -5, z, x, y, z);
    }
    const coastGeo = new THREE.BufferGeometry();
    coastGeo.setAttribute("position", new THREE.Float32BufferAttribute(coast, 3));
    const colours: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const c = new THREE.Color(0.16, 0.2, 0.2).lerp(haze, 0.15 + (i / steps) * 0.6);
      colours.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    coastGeo.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
    const cidx: number[] = [];
    for (let i = 0; i < steps; i++) cidx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    coastGeo.setIndex(cidx);
    far.add(new THREE.Mesh(coastGeo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide })));

    // Clouds: bright gold towards the sun, dusky violet away from it.
    const textures = [cloudTexture(1), cloudTexture(2), cloudTexture(3)];
    const sunFlat = new THREE.Vector2(this.sunDir.x, this.sunDir.z).normalize();
    for (let i = 0; i < 18; i++) {
      const a = THREE.MathUtils.degToRad(-88 + (i / 17) * 176 + Math.sin(i * 7.3) * 5);
      const d = 1700 + ((i * 397) % 1600);
      const elevation = THREE.MathUtils.degToRad(3 + ((i * 53) % 11));
      const width = 900 + ((i * 211) % 900);
      const toward = Math.max(0, new THREE.Vector2(Math.sin(a), -Math.cos(a)).dot(sunFlat));
      // Lit gold from below near the sun, rose further off, violet-grey behind.
      const lit = new THREE.Color(0.95, 0.72, 0.85).lerp(new THREE.Color(2.6, 1.5, 0.85), Math.pow(toward, 2.5));
      const cloud = new THREE.Mesh(
        new THREE.PlaneGeometry(width, width * 0.5),
        new THREE.MeshBasicMaterial({ map: textures[i % 3], color: lit, transparent: true, depthWrite: false, fog: false, opacity: 1 }),
      );
      cloud.position.set(Math.sin(a) * d, Math.tan(elevation) * d + width * 0.12, -Math.cos(a) * d);
      cloud.lookAt(0, cloud.position.y, 0);
      cloud.renderOrder = -1;
      far.add(cloud);
    }
    this.scene.add(far);
    this.horizonGroup = far;
  }

  resize() {
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.renderer.setSize(this.w, this.h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(this.w, this.h);
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
    this.mirror.w = Math.round(Math.min(320, this.w * 0.42));
    this.mirror.h = Math.round(this.mirror.w * 0.34);
    this.mirror.x = Math.round((this.w - this.mirror.w) / 2);
    this.mirror.y = this.w < 560 ? 92 : 16;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.overlay.width = Math.round(this.w * dpr);
    this.overlay.height = Math.round(this.h * dpr);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(game: Game, skin: Skin, dt: number) {
    this.time += dt;
    const p = game.player;
    const origin = p.z;
    this.trackPerformance(dt);
    // A new run: last run's spray and wake must not hang in the air ahead.
    if (origin < this.lastOrigin - 1) {
      this.spray.clear();
      this.debris.clear();
      this.wake.clear();
      for (const w of this.otherWakes) {
        w.wake.clear();
        w.id = -1;
      }
      for (const d of this.dolphins) this.release("dolphin", d.obj);
      this.dolphins.length = 0;
      this.drops.length = 0;
    }
    this.lastOrigin = origin;

    if (!this.player || this.playerSkin !== skin.id) this.buildPlayer(skin);
    this.ocean.update(origin, this.time);
    this.sandMap.offset.set(0, (origin / 6) % 1);
    this.placeCamera(game, dt);
    this.placePlayer(game, dt);
    this.syncObstacles(game, origin);
    this.syncCoins(game, origin);
    this.syncPowers(game, origin);
    this.syncDecor(origin);
    this.placePolice(game, origin);
    this.placeWildlife(game, origin, dt);
    this.emitWater(game, dt);
    this.spray.update(dt, origin);
    this.debris.update(dt, origin);
    this.wake.update(origin, this.time);
    for (const w of this.otherWakes) w.wake.update(origin, this.time);

    // Shadows only around the player, where they matter.
    this.sun.position.set(p.x, 0, -8).addScaledVector(this.sunDir, 90);
    this.sun.target.position.set(p.x, 0, -8);
    this.sky.position.copy(this.camera.position);
    this.horizonGroup?.position.set(this.camera.position.x * 0.9, 0, 0);

    this.composer.render();
    if (game.police.active && this.tier < 3) this.renderMirror(game);
    this.drawOverlay(game);
  }

  // --- The police ----------------------------------------------------------------

  private placePolice(game: Game, origin: number) {
    const cop = game.police;
    const caught = game.state !== "run" && game.cause === "Ditangkap Polairud!";
    const boat = this.police.group;
    boat.visible = cop.active || caught;
    if (!boat.visible) return;
    const p = game.player;
    // Caught: they pull up alongside, where the main camera sees them.
    const x = caught ? p.x + 3.2 : cop.x;
    const z = caught ? p.z - 1.5 : p.z - Math.max(cop.gap, 0);
    boat.position.set(x, waveHeight(x, z, this.time) * 0.8, -(z - origin));
    boat.rotation.set(0, Math.PI, 0);
    const s = waveSlope(x, z, this.time);
    boat.rotation.x = Math.atan(s.dz) * 0.4 - 0.05;
    // Red and blue in turn.
    const phase = Math.floor(this.time * 6) % 2;
    this.police.red.emissiveIntensity = phase ? 6 : 0.3;
    this.police.blue.emissiveIntensity = phase ? 0.3 : 6;
    if (cop.active && cop.gap < 80 && Math.random() < 0.7) {
      const r = (a: number, b: number) => a + Math.random() * (b - a);
      this.spray.emit(x + r(-0.3, 0.3), 0.3, z - 3, r(-0.8, 0.8), r(3.5, 6), p.speed * r(0.55, 0.7), r(0.6, 0.9), r(0.15, 0.25), r(0.5, 0.9), 0.7, this.white);
    }
  }

  /** A rear-view mirror at the top of the screen while the police are after you. */
  private renderMirror(game: Game) {
    const p = game.player;
    const m = this.mirror;
    const cam = this.rearCamera;
    cam.position.set(p.x, 3.2 + p.y * 0.5, 2.5);
    cam.lookAt(p.x, 0.8, 40);
    cam.aspect = m.w / m.h;
    cam.updateProjectionMatrix();
    const r = this.renderer;
    const shadows = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false; // reuse the main view's shadows
    r.setScissorTest(true);
    r.setScissor(m.x, this.h - m.y - m.h, m.w, m.h);
    r.setViewport(m.x, this.h - m.y - m.h, m.w, m.h);
    // Our own rooster tail would fill the mirror: leave the spray out of it.
    this.player!.root.visible = false;
    this.spray.points.visible = false;
    this.debris.points.visible = false;
    r.render(this.scene, cam);
    this.player!.root.visible = true;
    this.spray.points.visible = true;
    this.debris.points.visible = true;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.w, this.h);
    r.shadowMap.autoUpdate = shadows;
  }

  // --- Camera and player ---------------------------------------------------------

  private placeCamera(game: Game, dt: number) {
    const p = game.player;
    const portrait = this.h > this.w;
    const k = Math.min(1, dt * 5);
    this.camX += (p.x * 0.72 - this.camX) * k;
    const boost = p.boost > 0 ? 1 : 0;
    const back = (portrait ? 9.6 : 6.4) - boost * 0.8 + p.y * 0.9;
    // A spring, not a rod: the camera rises after a jump and sinks on landing.
    const height = (portrait ? 4.8 : 2.8) + p.y * 0.75 - this.landKick * 0.45;
    this.camY += (height - this.camY) * Math.min(1, dt * 7);
    const shake = game.shake * game.shake * 0.25;
    const sx = (Math.random() * 2 - 1) * shake;
    const sy = (Math.random() * 2 - 1) * shake;
    this.camera.position.set(this.camX + sx, this.camY + sy, back);
    const lk = Math.min(1, dt * 6);
    this.look.x += (p.x * 0.8 - this.look.x) * lk;
    this.look.y += (1.2 + p.y * 0.6 - this.look.y) * lk;
    this.camera.lookAt(this.look.x, this.look.y, -14);
    this.roll += (-p.bank * 0.05 - this.roll) * Math.min(1, dt * 8);
    this.camera.rotateZ(this.roll);
    const fov = (portrait ? 72 : 60) + boost * 10 + Math.max(0, p.speed - 20) * 0.22;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4);
      this.camera.updateProjectionMatrix();
    }
    // Particle sizes are in metres: pixels per metre at 1 m from the lens.
    const scale = (this.h * this.renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.spray.setScale(scale);
    this.debris.setScale(scale);
  }

  private buildPlayer(skin: Skin) {
    if (this.player) this.scene.remove(this.player.root);
    this.player = this.lib.jetski(skin);
    this.player.root.rotation.y = Math.PI;
    this.scene.add(this.player.root);
    this.playerSkin = skin.id;
  }

  private placePlayer(game: Game, dt: number) {
    const rider = this.player!;
    const p = game.player;
    const onWater = p.air === "none";
    // Landing: the hull digs in and the rider's knees take it.
    if (onWater && this.wasAirForKick) this.landKick = Math.min(1, Math.abs(this.lastVy) / 14);
    this.wasAirForKick = !onWater;
    this.lastVy = p.vy;
    this.landKick = Math.max(0, this.landKick - dt * 3.5);
    const swell = waveHeight(p.x, p.z, this.time);
    rider.root.position.set(p.x, p.y + (onWater ? swell * 0.85 : 0) - this.landKick * 0.22, 0);
    // The nose turns into a lane change, like a carve.
    const vx = dt > 0 ? (p.x - this.prevX) / dt : 0;
    this.prevX = p.x;
    this.yaw += (THREE.MathUtils.clamp(-vx * 0.022, -0.3, 0.3) - this.yaw) * Math.min(1, dt * 12);
    rider.root.rotation.y = Math.PI + this.yaw;
    const slope = waveSlope(p.x, p.z, this.time);
    // Bow up at speed, nose down for a moment on landing.
    const planing = 0.03 + p.speed * 0.0014;
    let pitch = onWater
      ? -Math.atan(slope.dz) * 0.7 - planing + this.landKick * 0.16
      : -THREE.MathUtils.clamp(p.vy * 0.035, -0.35, 0.3);
    let roll = p.bank * 0.5 + (onWater ? Math.atan(slope.dx) * 0.6 : 0);
    if (p.spinning || p.spin > 0) pitch -= p.spin * TAU; // a backflip
    if (game.state !== "run") {
      pitch -= p.tumble * 1.3;
      roll += Math.sin(p.tumble) * 0.8;
    }
    rider.body.rotation.order = "YXZ";
    rider.body.rotation.set(pitch, 0, roll);
    this.duck += (Math.max(p.duck > 0 && onWater ? 1 : 0, this.landKick * 0.6) - this.duck) * Math.min(1, dt * 14);
    rider.pose({ duck: this.duck, lean: THREE.MathUtils.clamp(p.bank, -1, 1) });
    rider.flame.visible = p.boost > 0;
    if (p.boost > 0) rider.flame.scale.set(1 + Math.random() * 0.3, 1 + Math.random() * 0.3, 0.8 + Math.random() * 0.6);
    rider.shield.visible = p.shield > 0 || (p.invulnerable > 0 && Math.floor(this.time * 12) % 2 === 0);
  }

  // --- The world ----------------------------------------------------------------

  private take(key: string, make: () => THREE.Object3D) {
    const pool = this.spare.get(key);
    const obj = pool?.pop() ?? make();
    this.scene.add(obj);
    return obj;
  }

  private release(key: string, obj: THREE.Object3D) {
    this.scene.remove(obj);
    if (!this.spare.has(key)) this.spare.set(key, []);
    this.spare.get(key)!.push(obj);
  }

  private makeObstacle(o: Obstacle): { obj: THREE.Object3D; key: string } {
    switch (o.kind) {
      case "boat":
        return { key: `boat:${o.id % 4}`, obj: this.take(`boat:${o.id % 4}`, () => this.lib.boat(o.id)) };
      case "rock":
        return { key: `rock:${o.id % 4}`, obj: this.take(`rock:${o.id % 4}`, () => this.lib.rock(o.id)) };
      case "log":
        return { key: "log", obj: this.take("log", () => this.lib.log()) };
      case "net":
        return { key: "net", obj: this.take("net", () => this.lib.net()) };
      case "rope":
        return { key: `rope:${o.id % 5}`, obj: this.take(`rope:${o.id % 5}`, () => this.lib.flags(o.id)) };
      case "deck": {
        // Models face +z and are turned round, so their left is the world's right.
        const outer = o.x < -1 ? 1 : o.x > 1 ? -1 : 0;
        return { key: `deck:${outer}`, obj: this.take(`deck:${outer}`, () => this.lib.deck(outer)) };
      }
      case "pillar":
        return { key: "pillar", obj: this.take("pillar", () => this.lib.pillars()) };
      case "ramp":
        return { key: "ramp", obj: this.take("ramp", () => this.lib.ramp()) };
      case "banana":
        return { key: "banana", obj: this.take("banana", () => this.lib.banana()) };
      case "jetski": {
        const key = `npc:${o.id % NPC_SKINS.length}`;
        const obj = this.take(key, () => {
          const r = this.lib.jetski(NPC_SKINS[o.id % NPC_SKINS.length]);
          r.root.userData.rider = r;
          return r.root;
        });
        this.npcRiders.set(o.id, obj.userData.rider as Rider);
        return { key, obj };
      }
    }
  }

  private syncObstacles(game: Game, origin: number) {
    const seen = this.seenIds;
    seen.clear();
    for (const o of game.obstacles) {
      if (o.waiting) continue;
      const spec = SPECS[o.kind];
      // Once passed, overhead things (flags, a pier) would sit between camera and
      // rider and fill the screen: drop them as soon as the rider is through.
      const overhead = o.kind === "rope" || o.kind === "deck" || o.kind === "pillar";
      if (o.z > origin + AHEAD || o.z + spec.length < origin - (overhead ? 0.5 : 6)) continue;
      if (o.smashed > 0.5) continue;
      seen.add(o.id);
      let entry = this.objects.get(o.id);
      if (!entry) {
        entry = this.makeObstacle(o);
        this.objects.set(o.id, entry);
      }
      const obj = entry.obj;
      const z = o.z + ANCHOR[o.kind];
      const bob = FLOATS.has(o.kind) ? waveHeight(o.x, z, this.time) * 0.8 : 0;
      obj.position.set(o.x, bob, -(z - origin));
      obj.rotation.set(0, o.kind === "banana" ? (o.vx >= 0 ? 0 : Math.PI) : Math.PI, 0);
      if (FLOATS.has(o.kind) && o.kind !== "banana") {
        const s = waveSlope(o.x, z, this.time);
        obj.rotation.x = Math.atan(s.dz) * 0.6;
        obj.rotation.z = -Math.atan(s.dx) * 0.6;
      }
      if (o.kind === "ramp") {
        // The gate drops out just before the camera would pass through it.
        const camera = origin - this.camera.position.z;
        for (const part of obj.children) if ((part as THREE.Mesh).material === this.lib.mats.arch) part.visible = o.z > camera + 1.5;
      }
      if (o.kind === "jetski") {
        this.npcRiders.get(o.id)?.pose({ duck: 0.2, lean: Math.sin(this.time + o.id) * 0.2 });
        this.npcSpray(o);
      }
      if ((o.kind === "jetski" || o.kind === "banana") && o.smashed < 0) {
        let w = this.otherWakes.find((x) => x.id === o.id) ?? this.otherWakes.find((x) => x.id === -1 || !this.objects.has(x.id));
        if (w) {
          if (w.id !== o.id) {
            w.wake.clear();
            w.id = o.id;
          }
          if (this.time - w.last > 0.035) {
            w.last = this.time;
            const tailX = o.kind === "banana" ? o.x - Math.sign(o.vx || 1) * 2.6 : o.x;
            w.wake.add(tailX, o.kind === "banana" ? o.z + 0.65 : o.z, this.time, o.kind === "banana" ? 0.55 : 0.75);
          }
        }
      }
      if (o.kind === "rope") {
        for (const child of obj.children) {
          const flutter = child.userData.flutter as number | undefined;
          if (flutter !== undefined) child.rotation.x = Math.sin(this.time * 3.2 + flutter) * 0.28 + 0.15;
        }
      }
      if (o.smashed >= 0) {
        if (!this.smashed.has(o.id)) {
          this.smashed.add(o.id);
          this.burst(o.x, 0.4, o.z + ANCHOR[o.kind], 70, 1.2);
        }
        const s = Math.max(0.01, 1 - o.smashed * 2);
        obj.scale.setScalar(s);
        obj.position.y += o.smashed * 4;
        obj.rotation.z += o.smashed * 6;
      } else {
        obj.scale.setScalar(1);
      }
    }
    for (const [id, entry] of this.objects) {
      if (seen.has(id)) continue;
      entry.obj.scale.setScalar(1);
      this.release(entry.key, entry.obj);
      this.objects.delete(id);
      this.npcRiders.delete(id);
    }
  }

  private syncCoins(game: Game, origin: number) {
    let n = 0;
    const d = this.dummy;
    for (const c of game.coins) {
      if (c.taken || c.z < origin - 2 || c.z > origin + AHEAD || n >= 400) continue;
      d.position.set(c.x, c.y + Math.sin(this.time * 3 + c.z) * 0.06, -(c.z - origin));
      d.rotation.set(0, this.time * 3.2 + c.z * 0.3, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      this.coins.setMatrixAt(n++, d.matrix);
    }
    this.coins.count = n;
    this.coins.instanceMatrix.needsUpdate = true;
  }

  private syncPowers(game: Game, origin: number) {
    const seen = this.seenPowers;
    seen.clear();
    for (const pw of game.powers) {
      if (pw.taken || pw.z < origin - 2 || pw.z > origin + AHEAD) continue;
      seen.add(pw);
      let obj = this.powers.get(pw);
      if (!obj) {
        obj = this.take(`power:${pw.kind}`, () => this.lib.power(pw.kind));
        obj.userData.pool = `power:${pw.kind}`;
        this.powers.set(pw, obj);
      }
      obj.position.set(pw.x, 1.2 + Math.sin(this.time * 2.5 + pw.z) * 0.15, -(pw.z - origin));
      obj.rotation.y = this.time * 1.5;
    }
    for (const [pw, obj] of this.powers) {
      if (seen.has(pw)) continue;
      this.release(obj.userData.pool as string, obj);
      this.powers.delete(pw);
    }
  }

  /** The beach comes from a hash of the segment number: the same palm stands in the same place. */
  private syncDecor(origin: number) {
    const seen = this.seenDecor;
    seen.clear();
    const place = (key: string, pool: string, make: () => THREE.Object3D, x: number, z: number, rot: number, y = sandHeight(x)) => {
      seen.add(key);
      let obj = this.decor.get(key);
      if (!obj) {
        obj = this.take(pool, make);
        obj.userData.pool = pool;
        this.decor.set(key, obj);
      }
      obj.position.set(x, y, -(z - origin));
      obj.rotation.y = rot;
    };
    const first = Math.floor((origin - 20) / DECOR_STEP);
    const last = Math.ceil((origin + AHEAD) / DECOR_STEP);
    for (let k = first; k <= last; k++) {
      const z = k * DECOR_STEP;
      const r = hash(k, 1);
      if (r < 0.42) {
        const v = Math.floor(hash(k, 3) * 3);
        place(`palm:${k}`, `palm:${v}`, () => this.lib.palm(v), 10.5 + hash(k, 2) * 9, z, hash(k, 4) * TAU);
      } else if (r < 0.64) {
        const c = Math.floor(hash(k, 5) * UMBRELLAS.length);
        place(`umb:${k}`, `umbrella:${c}`, () => this.lib.umbrella(UMBRELLAS[c]), 11 + hash(k, 2) * 3, z, hash(k, 4) * 0.6 - 0.3);
      } else if (r < 0.72) {
        place(`warung:${k}`, "warung", () => this.lib.warung(), 18 + hash(k, 2) * 3, z, Math.PI / 2 + (hash(k, 4) - 0.5) * 0.4);
      } else if (r < 0.78) {
        place(`boards:${k}`, "boards", () => this.lib.surfboards(k), 10 + hash(k, 2) * 1.5, z, -Math.PI / 2 + (hash(k, 4) - 0.5));
      }
      if (hash(k, 8) < 0.6) {
        const v = Math.floor(hash(k, 9) * 3);
        place(`back:${k}`, `palm:${v}`, () => this.lib.palm(v), 22 + hash(k, 10) * 14, z + hash(k, 11) * DECOR_STEP, hash(k, 12) * TAU);
      }
      if (hash(k, 15) < 0.75) {
        place(`bush:${k}`, "bush", () => this.lib.bush(k % 5), 40 + hash(k, 16) * 14, z + hash(k, 17) * DECOR_STEP, hash(k, 18) * TAU);
      }
      if (hash(k, 13) < 0.06) {
        place(`sail:${k}`, "sail", () => this.lib.sailboat(), -45 - hash(k, 14) * 40, z, Math.PI, waveHeight(-50, z, this.time) * 0.5);
      }
    }
    for (const [key, obj] of this.decor) {
      if (seen.has(key)) continue;
      this.release(obj.userData.pool as string, obj);
      this.decor.delete(key);
    }

    // Lane buoys every 30 m, bobbing on the swell.
    let n = 0;
    const d = this.dummy;
    for (let k = Math.ceil((origin + 4) / 40); k * 40 < origin + AHEAD && n < 40; k++) {
      for (const x of [-1.2, 1.2]) {
        const z = k * 40;
        d.position.set(x, waveHeight(x, z, this.time) * 0.9 + 0.05, -(z - origin));
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        this.buoys.setMatrixAt(n++, d.matrix);
      }
    }
    this.buoys.count = n;
    this.buoys.instanceMatrix.needsUpdate = true;
  }

  // --- Water ---------------------------------------------------------------------

  private emitWater(game: Game, dt: number) {
    const p = game.player;
    const running = game.state === "run";
    const onWater = p.air === "none";
    const speed = p.speed;
    const r = (a: number, b: number) => a + Math.random() * (b - a);

    if (running && onWater) {
      const boost = p.boost > 0 ? 1.35 : 1;
      this.sprayTimer += dt * (110 + speed * 2.5) * boost;
      while (this.sprayTimer >= 1) {
        this.sprayTimer -= 1;
        // The rooster tail: thrown high behind the jet, lagging behind as we race on.
        this.spray.emit(p.x + r(-0.12, 0.12), 0.35, p.z - 1.6, r(-0.8, 0.8), r(4.5, 7.5) * boost, speed * r(0.55, 0.7), r(0.7, 1.1), r(0.1, 0.18), r(0.4, 0.75), 0.55, this.white);
        // Spray peeling off both sides of the bow.
        if (Math.random() < 0.7) {
          const side = Math.random() < 0.5 ? -1 : 1;
          this.spray.emit(p.x + side * 0.5, 0.15, p.z + 0.8, side * r(2, 3.8), r(1.2, 2.8), speed * r(0.85, 0.95), r(0.35, 0.6), r(0.05, 0.09), r(0.16, 0.3), 0.85, this.white);
        }
        // A fine mist hanging in the air behind.
        if (Math.random() < 0.06) {
          this.spray.emit(p.x + r(-0.3, 0.3), 0.8, p.z - 2, r(-0.4, 0.4), r(1.5, 2.6), speed * r(0.85, 0.95), r(0.8, 1.2), r(0.5, 0.8), r(1.4, 2.2), 0.06, this.mist, 2, 0.4);
        }
      }
    }

    // Leaving and meeting the water.
    if (running && !onWater && !this.wasAir) this.burst(p.x, 0.2, p.z - 0.5, 50, 0.7);
    if (onWater && this.wasAir) {
      this.burst(p.x, 0.15, p.z - 0.3, 110 + Math.min(120, Math.abs(p.vy) * 4), 1);
      if (Math.abs(this.lastVy) > 9) this.splashLens(6 + Math.round(Math.abs(this.lastVy) * 0.5));
    }
    this.wasAir = !onWater;

    // A sideways sheet of water when carving into another lane.
    if (p.lastSwitch !== this.lastSwitch) {
      if (onWater && running) {
        const dir = Math.sign(p.x - (p.lane === 0 ? -2.4 : p.lane === 2 ? 2.4 : 0)) || (Math.random() < 0.5 ? -1 : 1);
        for (let i = 0; i < 45; i++) {
          this.spray.emit(p.x, 0.2, p.z + r(-1, 0.8), dir * r(2.5, 6), r(1.5, 4), speed * r(0.8, 0.95), r(0.4, 0.7), r(0.06, 0.12), r(0.2, 0.45), 0.85, this.white);
        }
      }
      this.lastSwitch = p.lastSwitch;
    }

    if (game.state === "crash" && this.wasState === "run") {
      this.burst(p.x, 0.5, p.z, 260, 1.8);
      this.splashLens(28);
    }
    this.wasState = game.state;

    // The wake: a point of foam every few centimetres while on the water.
    this.wakeTimer -= dt;
    if (this.wakeTimer <= 0) {
      this.wakeTimer = 0.03;
      this.wake.add(p.x, p.z - 1.3, this.time, onWater && running ? (p.boost > 0 ? 1 : 0.85) : 0);
    }

    // Splinters and coin sparkles from the simulation.
    for (const q of game.particles) {
      if ((q.kind !== "debris" && q.kind !== "spark") || this.copied.has(q)) continue;
      this.copied.add(q);
      const colour = q.kind === "debris" ? this.brown : this.gold;
      this.debris.emit(q.x, q.y, q.z, q.vx, q.vy, q.vz, q.max, q.size, q.size * 0.6, 1, colour, 9.8, 0.4);
    }
  }

  /** Gulls drifting overhead, and now and then a pod of dolphins leaping out at sea. */
  private placeWildlife(game: Game, origin: number, dt: number) {
    const p = game.player;
    for (const g of this.gulls) {
      if (g.z < origin - 15 || g.z > origin + 260) {
        g.z = origin + 90 + Math.random() * 150;
        g.x = -12 + Math.random() * 32;
        g.y = 11 + Math.random() * 12;
      }
      g.z += 7 * dt;
      g.x += Math.sin(this.time * 0.3 + g.phase) * 1.2 * dt;
      g.obj.visible = true;
      g.obj.position.set(g.x, g.y + Math.sin(this.time * 0.8 + g.phase) * 0.6, -(g.z - origin));
      g.obj.rotation.set(0, Math.PI + Math.sin(this.time * 0.3 + g.phase) * 0.3, Math.sin(this.time * 0.5 + g.phase) * 0.15);
      // Flap in bursts, glide in between.
      const flapping = Math.sin(this.time * 0.6 + g.phase) > -0.2;
      const beat = flapping ? Math.sin(this.time * 9 + g.phase) * 0.55 : 0.08;
      for (const wing of g.obj.children) {
        const side = wing.userData.side as number | undefined;
        if (side !== undefined) wing.rotation.z = side * beat;
      }
    }

    this.nextPod -= dt;
    if (this.nextPod <= 0 && game.state === "run") {
      this.nextPod = 14 + Math.random() * 16;
      // Close to the lanes on the open-sea side, keeping pace for a while so they can be watched.
      const x = -8.5 - Math.random() * 4;
      const z = p.z + 28 + Math.random() * 14;
      const count = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) {
        const obj = this.take("dolphin", () => this.lib.dolphin());
        obj.scale.setScalar(1.3);
        this.dolphins.push({ obj, x: x - i * 1.6, z: z + i * 2.5, vz: p.speed * 0.8, t: -i * 0.35, jumps: 3 + Math.floor(Math.random() * 2), surfaced: false });
      }
    }
    // Each leap: out of the water, a 1.6 m arc over 1.1 s, back in, swim on under water.
    for (let i = this.dolphins.length - 1; i >= 0; i--) {
      const d = this.dolphins[i];
      d.t += dt;
      d.z += d.vz * dt;
      const cycle = 1.9;
      const phase = ((d.t % cycle) + cycle) % cycle;
      const leap = Math.min(1, phase / 1.1);
      const inAir = d.t >= 0 && phase < 1.1;
      const y = inAir ? -0.4 + 2.0 * 4 * leap * (1 - leap) : -1.5;
      d.obj.visible = inAir;
      d.obj.position.set(d.x, y, -(d.z - origin));
      d.obj.rotation.set(-(1 - 2 * leap) * 0.75, Math.PI, 0);
      if (inAir !== d.surfaced) {
        d.surfaced = inAir;
        this.burst(d.x, 0.1, d.z, 25, 0.6);
        if (!inAir) d.jumps--;
      }
      if (d.jumps <= 0 || d.z < origin - 20) {
        this.release("dolphin", d.obj);
        this.dolphins.splice(i, 1);
      }
    }
  }

  /** Water on the lens after a big splash. */
  private splashLens(count: number) {
    const unit = Math.min(this.w, this.h) / 800;
    for (let i = 0; i < count; i++) {
      const life = 1.2 + Math.random() * 1.6;
      this.drops.push({
        x: Math.random() * this.w,
        y: this.h * (0.25 + Math.random() * 0.75),
        r: (6 + Math.random() * 18) * unit * 1.4,
        life,
        max: life,
        vy: 6 + Math.random() * 30,
      });
    }
  }

  /** A splash: a crown of droplets, then mist. */
  private burst(x: number, y: number, z: number, count: number, power: number) {
    const r = (a: number, b: number) => a + Math.random() * (b - a);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const out = r(1.5, 5.5) * power;
      this.spray.emit(x + Math.cos(a) * 0.4, y, z + Math.sin(a) * 0.4, Math.cos(a) * out, r(2.5, 7) * power, Math.sin(a) * out, r(0.6, 1.1), r(0.08, 0.16), r(0.25, 0.6), 0.9, this.white);
    }
    for (let i = 0; i < count / 8; i++) {
      this.spray.emit(x + r(-1, 1), y + 0.4, z + r(-1, 1), r(-1, 1), r(1, 2.5) * power, r(-1, 1), r(1.2, 1.8), r(1, 1.6), r(2.5, 4) * power, 0.15, this.mist, 2, 0.4);
    }
  }

  private npcSpray(o: Obstacle) {
    if (Math.random() > 0.6) return;
    const r = (a: number, b: number) => a + Math.random() * (b - a);
    this.spray.emit(o.x + r(-0.1, 0.1), 0.25, o.z, r(-0.5, 0.5), r(3.5, 5.5), o.vz * r(0.4, 0.6), r(0.6, 0.9), r(0.1, 0.18), r(0.35, 0.6), 0.7, this.white);
  }

  // --- Overlay ---------------------------------------------------------------------

  private drawOverlay(game: Game) {
    const { octx: ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const p = game.player;
    if (p.boost > 0 || p.speed > 36) {
      const strength = p.boost > 0 ? 1 : (p.speed - 36) / 10;
      ctx.strokeStyle = `rgba(255,255,255,${0.22 * Math.min(1, strength)})`;
      ctx.lineWidth = 2;
      for (let i = 0; i < 16; i++) {
        const angle = Math.random() * TAU;
        const r0 = Math.max(w, h) * (0.38 + Math.random() * 0.2);
        const r1 = r0 + Math.max(w, h) * (0.1 + Math.random() * 0.15);
        ctx.beginPath();
        ctx.moveTo(w / 2 + Math.cos(angle) * r0, h * 0.45 + Math.sin(angle) * r0);
        ctx.lineTo(w / 2 + Math.cos(angle) * r1, h * 0.45 + Math.sin(angle) * r1);
        ctx.stroke();
      }
    }
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.life -= 1 / 60;
      d.y += d.vy / 60;
      if (d.life <= 0) {
        this.drops.splice(i, 1);
        continue;
      }
      // A lens-like bead: bright highlight, faint body, darker rim.
      const a = Math.min(1, d.life / 0.6);
      const g = ctx.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.35, d.r * 0.08, d.x, d.y, d.r);
      g.addColorStop(0, `rgba(255,255,255,${0.55 * a})`);
      g.addColorStop(0.35, `rgba(220,235,245,${0.12 * a})`);
      g.addColorStop(0.85, `rgba(30,50,70,${0.16 * a})`);
      g.addColorStop(1, `rgba(255,255,255,${0.22 * a})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, d.r, d.r * 1.08, 0, 0, TAU);
      ctx.fill();
    }
    const cop = game.police;
    if (cop.active) {
      // Red and blue washing in from the edges, stronger as they close in.
      const close = THREE.MathUtils.clamp(1 - (cop.gap - 5) / 40, 0, 1);
      const phase = Math.floor(this.time * 6) % 2;
      for (const [side, colour] of [
        [0, phase ? "255,40,40" : "40,80,255"],
        [1, phase ? "40,80,255" : "255,40,40"],
      ] as const) {
        const x = side ? w : 0;
        const g = ctx.createLinearGradient(x, 0, side ? w - w * 0.18 : w * 0.18, 0);
        g.addColorStop(0, `rgba(${colour},${0.1 + 0.35 * close})`);
        g.addColorStop(1, `rgba(${colour},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(side ? w - w * 0.18 : 0, 0, w * 0.18, h);
      }
      if (this.tier < 3) {
        const m = this.mirror;
        ctx.strokeStyle = "rgba(20,20,28,0.9)";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.roundRect(m.x - 3, m.y - 3, m.w + 6, m.h + 6, 12);
        ctx.stroke();
      }
      const m = this.mirror;
      const label = `POLAIRUD  ${Math.max(0, Math.round(cop.gap))} m`;
      ctx.font = `900 ${Math.round(Math.max(14, Math.min(18, w * 0.035)))}px "Lilita One", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(20,10,40,0.85)";
      const ly = this.tier < 3 ? m.y + m.h + 8 : m.y;
      ctx.strokeText(label, w / 2, ly);
      ctx.fillStyle = close > 0.6 ? "#ff6b6b" : "#ffffff";
      ctx.fillText(label, w / 2, ly);
    }
    if (this.showFps && this.fpsText) {
      ctx.font = "600 12px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(8, h - 30, ctx.measureText(this.fpsText).width + 12, 22);
      ctx.fillStyle = "#9ff59f";
      ctx.fillText(this.fpsText, 14, h - 13);
    }
    const colours = { good: "#ffffff", great: "#ffe066", bad: "#ff6b6b", gold: "#ffd23f" };
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const size = Math.max(20, Math.min(34, w * 0.06));
    game.popups.forEach((pop, i) => {
      const age = pop.t / POPUP_SECONDS;
      const grow = Math.min(1, pop.t / 0.12);
      const y = h * 0.42 - (game.popups.length - 1 - i) * size * 1.2 - age * 26;
      ctx.globalAlpha = 1 - age * age;
      ctx.font = `900 ${Math.round(size * (0.7 + 0.3 * grow))}px "Lilita One", ui-rounded, system-ui, sans-serif`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(30,20,60,0.75)";
      ctx.strokeText(pop.text, w / 2, y);
      ctx.fillStyle = colours[pop.tone];
      ctx.fillText(pop.text, w / 2, y);
    });
    ctx.globalAlpha = 1;
  }

  /**
   * If frames run long, step quality down until they do not: fewer pixels first,
   * then no shadows, then no bloom or mirror. Smooth beats sharp.
   */
  private trackPerformance(dt: number) {
    if (dt <= 0) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 120) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const typical = sorted[Math.floor(sorted.length * 0.9)];
    const median = sorted[Math.floor(sorted.length / 2)];
    this.frameTimes = [];
    this.fpsText = `${Math.round(1 / median)} fps · ${(median * 1000).toFixed(1)} ms (p90 ${(typical * 1000).toFixed(1)}) · x${this.renderer.getPixelRatio()} · tier ${this.tier}`;
    if (typical <= 1 / 52) return;
    const ratio = this.renderer.getPixelRatio();
    if (ratio > 1) {
      this.renderer.setPixelRatio(Math.max(1, ratio - 0.25));
      this.resize();
    } else if (this.tier === 0) {
      this.tier = 1;
      this.renderer.shadowMap.enabled = false;
      this.sun.castShadow = false;
    } else if (this.tier === 1) {
      this.tier = 2;
      this.bloom.enabled = false;
    } else if (this.tier === 2) {
      this.tier = 3; // no rear-view mirror
    }
  }
}
