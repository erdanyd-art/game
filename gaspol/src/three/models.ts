import * as THREE from "three";
import { ParametricGeometry } from "three/examples/jsm/geometries/ParametricGeometry.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PowerKind } from "../course.ts";
import { createRng } from "../rng.ts";
import type { Skin } from "../save.ts";
import { barkTexture, chevronTexture, foamRingTexture, frondTexture, netTexture, plankTexture, signTexture, thatchTexture } from "./textures.ts";

// Every model is built from code. Models face +z (forward in the game) with the
// waterline at y = 0; the renderer turns them to three.js's -z.

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const Y = new THREE.Vector3(0, 1, 0);

/** Points a unit-height cylinder from a to b. */
export function limb(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const length = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(Y, dir.divideScalar(length || 1));
  mesh.scale.set(1, length, 1);
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], shadows = true) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  return m;
}

/**
 * Merges a static model's parts into one mesh per material: a palm drawn in 3
 * calls instead of 15. Anything that cannot be merged (multi-material meshes,
 * sprites) is kept as it is.
 */
export function bake(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const buckets = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; sample: THREE.Mesh }>();
  const kept: THREE.Object3D[] = [];
  const local = new THREE.Matrix4();
  root.traverse((o) => {
    if (o === root) return;
    local.multiplyMatrices(toRoot, o.matrixWorld);
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) {
      if (m.isMesh || (o as THREE.Sprite).isSprite) {
        const copy = o.clone(false);
        local.decompose(copy.position, copy.quaternion, copy.scale);
        kept.push(copy);
      }
      return;
    }
    let geo = m.geometry.clone().applyMatrix4(local);
    if (geo.index) geo = geo.toNonIndexed();
    const bucket = buckets.get(m.material) ?? { geos: [], sample: m };
    bucket.geos.push(geo);
    buckets.set(m.material, bucket);
  });
  const out = new THREE.Group();
  for (const [material, { geos, sample }] of buckets) {
    // Merging needs the same attributes everywhere: keep the ones all parts share.
    const common = Object.keys(geos[0].attributes).filter((name) => geos.every((g) => g.getAttribute(name)));
    for (const g of geos) for (const name of Object.keys(g.attributes)) if (!common.includes(name)) g.deleteAttribute(name);
    const merged = mergeGeometries(geos);
    if (!merged) continue;
    const baked = new THREE.Mesh(merged, material);
    baked.castShadow = sample.castShadow;
    baked.receiveShadow = sample.receiveShadow;
    baked.renderOrder = sample.renderOrder;
    out.add(baked);
  }
  for (const k of kept) out.add(k);
  return out;
}

/** Paints vertices by a function of their position (hull stripes, wet bottoms). */
function paint(geometry: THREE.BufferGeometry, colour: (x: number, y: number, z: number) => THREE.Color) {
  const pos = geometry.getAttribute("position");
  const colours = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = colour(pos.getX(i), pos.getY(i), pos.getZ(i));
    colours.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  return geometry;
}

// --- The jetski ----------------------------------------------------------------

const SKI_LENGTH = 2.9;
const skiHalfWidth = (u: number) =>
  u < 0.1 ? 0.5 + 0.1 * smooth(0, 0.1, u) : 0.6 * (1 - Math.pow(Math.max(0, (u - 0.38) / 0.62), 2.3));
export const skiDeck = (u: number) => 0.5 + 0.2 * smooth(0.55, 1, u);
const skiKeel = (u: number) => -0.2 + 0.42 * Math.pow(smooth(0.45, 1, u), 1.6);

/** A deep-V hull: from one deck edge down to the keel and up to the other. */
function hullSurface(halfWidth: (u: number) => number, top: (u: number) => number, keel: (u: number) => number, length: number) {
  return (u: number, v: number, target: THREE.Vector3) => {
    const theta = v * Math.PI;
    const s = Math.sin(theta);
    const w = halfWidth(u);
    const t = top(u);
    target.set(-Math.cos(theta) * w * (1 - 0.3 * s * s * s), t - (t - keel(u)) * Math.pow(s, 0.75), -length / 2 + u * length);
  };
}

export type RiderPose = { duck: number; lean: number };
export type Rider = {
  root: THREE.Group;
  /** Tilts with the waves and leans into turns; flips as one. */
  body: THREE.Group;
  pose: (p: RiderPose) => void;
  flame: THREE.Mesh;
  shield: THREE.Mesh;
};

export class Library {
  private readonly cache = new Map<string, unknown>();
  readonly mats = {
    wetsuit: new THREE.MeshStandardMaterial({ color: 0x161b26, roughness: 0.55 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xa8714a, roughness: 0.6 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.7 }),
    visor: new THREE.MeshPhysicalMaterial({ color: 0x0c0d10, roughness: 0.05, metalness: 0.3, clearcoat: 1 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.45 }),
    grip: new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.85 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.3, metalness: 0.9 }),
    reflective: new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.3, emissive: 0x555555 }),
    bamboo: new THREE.MeshStandardMaterial({ color: 0xc9ad74, roughness: 0.7 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.85 }),
    darkWood: new THREE.MeshStandardMaterial({ color: 0x3d2b1c, roughness: 0.9 }),
    rope: new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.9 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }),
    red: new THREE.MeshStandardMaterial({ color: 0xd62828, roughness: 0.4 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xff6d00, roughness: 0.45 }),
    rock: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }),
    banana: new THREE.MeshPhysicalMaterial({ color: 0xffcc1a, roughness: 0.35, clearcoat: 0.6 }),
    bananaDark: new THREE.MeshStandardMaterial({ color: 0xd9a400, roughness: 0.5 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xffc23d, metalness: 1, roughness: 0.22, emissive: 0x6a4100, emissiveIntensity: 0.7 }),
    flame: new THREE.MeshBasicMaterial({ color: 0x8fd1ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
    shield: new THREE.MeshStandardMaterial({ color: 0x9fe8ff, emissive: 0x3fb8e0, emissiveIntensity: 0.6, transparent: true, opacity: 0.18, depthWrite: false, roughness: 0.1 }),
    bark: new THREE.MeshStandardMaterial({ map: barkTexture(), roughness: 0.95 }),
    frond: new THREE.MeshStandardMaterial({ map: frondTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.8, color: 0xc8e0a0 }),
    planks: new THREE.MeshStandardMaterial({ map: plankTexture(), roughness: 0.9 }),
    thatch: new THREE.MeshStandardMaterial({ map: thatchTexture(), roughness: 1 }),
    net: new THREE.MeshStandardMaterial({ map: netTexture(), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.9 }),
    chevron: new THREE.MeshStandardMaterial({ map: chevronTexture(), roughness: 0.55 }),
    rampSide: new THREE.MeshStandardMaterial({ color: 0xc25e00, roughness: 0.6 }),
    // Lit from inside a little, so it reads against the low sun from far off.
    arch: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, emissive: 0x5a2400, emissiveIntensity: 1 }),
    coconut: new THREE.MeshStandardMaterial({ color: 0x5a3d1e, roughness: 0.8 }),
    sand: new THREE.MeshStandardMaterial({ color: 0xcdb08a, roughness: 1 }),
    foam: new THREE.MeshBasicMaterial({ map: foamRingTexture(), transparent: true, depthWrite: false, color: 0xf2f6f8 }),
    jungle: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
    dolphin: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.25, clearcoat: 0.8 }),
    gull: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }),
  };

  /** Foam where the water meets something: a flat ring at the waterline. */
  foamRing(rx: number, rz: number, z = 0) {
    const ring = new THREE.Mesh(this.memo("foamPlane", () => new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2)), this.mats.foam);
    ring.scale.set(rx, 1, rz);
    ring.position.set(0, 0.07, z);
    ring.renderOrder = 2;
    return ring;
  }

  constructor() {
    const planks = this.mats.planks.map!;
    planks.repeat.set(1, 3);
    const bark = this.mats.bark.map!;
    bark.repeat.set(1, 4);
  }

  private memo<T>(key: string, make: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key) as T;
  }

  // The jetski with its rider, in a skin's colours.
  jetski(skin: Skin): Rider {
    const hull = new THREE.Color(skin.hull);
    const stripe = new THREE.Color(skin.stripe);
    const hullGeo = this.memo(`hull:${skin.hull}:${skin.stripe}`, () =>
      paint(new ParametricGeometry(hullSurface(skiHalfWidth, skiDeck, skiKeel, SKI_LENGTH), 44, 18), (_x, y, z) => {
        const u = (z + SKI_LENGTH / 2) / SKI_LENGTH;
        const top = skiDeck(u);
        if (y < 0.0) return hull.clone().multiplyScalar(0.55);
        if (y > top - 0.2 && y < top - 0.09) return stripe;
        return hull;
      }),
    );
    const hullMat = this.memo(`hullMat`, () => new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06, side: THREE.DoubleSide }));
    const paintMat = this.memo(`paint:${skin.hull}`, () => new THREE.MeshPhysicalMaterial({ color: hull, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.05 }));
    const vestMat = this.memo(`vest:${skin.vest}`, () => new THREE.MeshStandardMaterial({ color: skin.vest, roughness: 0.75 }));
    const helmetMat = this.memo(`helmet:${skin.helmet}`, () => new THREE.MeshPhysicalMaterial({ color: skin.helmet, roughness: 0.25, clearcoat: 1 }));
    const m = this.mats;

    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    body.add(mesh(hullGeo, hullMat));
    // Rear deck (non-slip) and the glossy hood.
    const deckGeo = (from: number, to: number) =>
      new ParametricGeometry((u, s, t) => {
        const uu = from + u * (to - from);
        const ss = s * 2 - 1;
        t.set(ss * skiHalfWidth(uu) * 0.985, skiDeck(uu) + 0.035 * (1 - ss * ss), -SKI_LENGTH / 2 + uu * SKI_LENGTH);
      }, 20, 6);
    const rear = mesh(this.memo("deckRear", () => deckGeo(0, 0.56)), paintMat);
    for (const side of [-1, 1]) {
      const pad = mesh(this.memo("gripPad", () => new RoundedBoxGeometry(0.2, 0.03, 1.2, 2, 0.01)), m.grip);
      pad.position.set(side * 0.38, skiDeck(0.3) + 0.04, -0.3);
      body.add(pad);
    }
    const hood = mesh(this.memo("deckHood", () => deckGeo(0.55, 1)), paintMat);
    body.add(rear, hood);
    // The transom: the flat stern.
    const transom = mesh(
      this.memo("transom", () => {
        const pts: THREE.Vector2[] = [];
        const f = hullSurface(skiHalfWidth, skiDeck, skiKeel, SKI_LENGTH);
        const v = new THREE.Vector3();
        for (let i = 0; i <= 16; i++) {
          f(0, i / 16, v);
          pts.push(new THREE.Vector2(v.x, v.y));
        }
        const g = new THREE.ShapeGeometry(new THREE.Shape(pts));
        g.translate(0, 0, -SKI_LENGTH / 2);
        return g;
      }),
      paintMat,
    );
    (transom.material as THREE.Material).side = THREE.DoubleSide;
    body.add(transom);

    const seat = mesh(this.memo("seat", () => new RoundedBoxGeometry(0.46, 0.17, 1.1, 3, 0.07)), m.seat);
    seat.position.set(0, skiDeck(0.3) + 0.1, -0.35);
    const column = mesh(this.memo("column", () => new RoundedBoxGeometry(0.24, 0.44, 0.28, 3, 0.05)), m.seat);
    column.position.set(0, skiDeck(0.62) + 0.17, 0.36);
    column.rotation.x = -0.4;
    const bar = mesh(this.memo("bar", () => new THREE.CylinderGeometry(0.022, 0.022, 0.82, 10).rotateZ(Math.PI / 2)), m.metal);
    bar.position.set(0, 1.03, 0.36);
    body.add(seat, column, bar);
    for (const side of [-1, 1]) {
      const grip = mesh(this.memo("gripGeo", () => new THREE.CylinderGeometry(0.036, 0.036, 0.15, 10).rotateZ(Math.PI / 2)), m.glove);
      grip.position.set(side * 0.36, 1.03, 0.36);
      const mirror = mesh(this.memo("mirror", () => new RoundedBoxGeometry(0.13, 0.08, 0.03, 2, 0.015)), m.seat);
      mirror.position.set(side * 0.3, 1.24, 0.42);
      body.add(grip, mirror);
    }
    const nozzle = mesh(this.memo("nozzle", () => new THREE.CylinderGeometry(0.075, 0.09, 0.22, 14).rotateX(Math.PI / 2)), m.metal);
    nozzle.position.set(0, 0.02, -SKI_LENGTH / 2 - 0.08);
    body.add(nozzle);

    // The rider.
    const rider = new THREE.Group();
    body.add(rider);
    const cyl = this.memo("limbGeo", () => new THREE.CylinderGeometry(1, 1, 1, 10));
    const ball = this.memo("ballGeo", () => new THREE.SphereGeometry(1, 14, 10));
    const part = (geo: THREE.BufferGeometry, mat: THREE.Material, r: number) => {
      const p = mesh(geo, mat);
      p.userData.r = r;
      rider.add(p);
      return p;
    };
    const torso = mesh(this.memo("torso", () => new THREE.CapsuleGeometry(0.17, 0.34, 6, 14)), vestMat);
    torso.scale.set(1.18, 1, 0.88);
    const strip = mesh(this.memo("strip", () => new THREE.BoxGeometry(0.3, 0.045, 0.02)), m.reflective);
    torso.add(strip);
    strip.position.set(0, 0.12, -0.16);
    const hips = part(ball, m.wetsuit, 0.17);
    const head = new THREE.Group();
    const helmet = mesh(ball, helmetMat);
    helmet.scale.setScalar(0.16);
    // A band across the front of the helmet (phi = pi/2 faces +z, forward).
    const visor = mesh(this.memo("visor", () => new THREE.SphereGeometry(0.163, 20, 12, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.32, Math.PI * 0.3)), m.visor);
    head.add(helmet, visor);
    rider.add(torso, head);
    const neck = part(cyl, m.wetsuit, 0.06);
    const upperL = part(cyl, m.wetsuit, 0.055);
    const upperR = part(cyl, m.wetsuit, 0.055);
    const lowerL = part(cyl, m.wetsuit, 0.048);
    const lowerR = part(cyl, m.wetsuit, 0.048);
    const thighL = part(cyl, m.wetsuit, 0.08);
    const thighR = part(cyl, m.wetsuit, 0.08);
    const shinL = part(cyl, m.wetsuit, 0.065);
    const shinR = part(cyl, m.wetsuit, 0.065);
    const joints = Array.from({ length: 8 }, () => part(ball, m.wetsuit, 0.06));
    const hands = [part(ball, m.glove, 0.05), part(ball, m.glove, 0.05)];
    const boots = [0, 1].map(() => {
      const b = mesh(this.memo("boot", () => new RoundedBoxGeometry(0.13, 0.1, 0.28, 2, 0.04)), m.glove);
      rider.add(b);
      return b;
    });

    const v = () => new THREE.Vector3();
    const [H, S, sL, sR, eL, eR, gL, gR, hL, hR, kL, kR, fL, fR, dir, off] = Array.from({ length: 16 }, v);
    const footY = skiDeck(0.35) + 0.06;
    const pose = ({ duck, lean }: RiderPose) => {
      H.set(lean * 0.12, 1.05 - 0.17 * duck, -0.42 + 0.1 * duck);
      const pitch = 0.3 + 0.7 * duck;
      dir.set(lean * 0.25, Math.cos(pitch), Math.sin(pitch)).normalize();
      S.copy(H).addScaledVector(dir, 0.52);
      torso.position.copy(H).addScaledVector(dir, 0.26);
      torso.quaternion.setFromUnitVectors(Y, dir);
      head.position.copy(S).add(off.set(0, 0.2 - 0.05 * duck, 0.04 + 0.08 * duck));
      limb(neck, S, head.position);
      sL.set(S.x - 0.2, S.y - 0.04, S.z);
      sR.set(S.x + 0.2, S.y - 0.04, S.z);
      gL.set(-0.36, 1.03, 0.36);
      gR.set(0.36, 1.03, 0.36);
      eL.addVectors(sL, gL).multiplyScalar(0.5).add(off.set(-0.12, -0.07, -0.02));
      eR.addVectors(sR, gR).multiplyScalar(0.5).add(off.set(0.12, -0.07, -0.02));
      limb(upperL, sL, eL);
      limb(upperR, sR, eR);
      limb(lowerL, eL, gL);
      limb(lowerR, eR, gR);
      hL.set(H.x - 0.12, H.y - 0.02, H.z);
      hR.set(H.x + 0.12, H.y - 0.02, H.z);
      fL.set(-0.24, footY, -0.08);
      fR.set(0.24, footY, -0.08);
      kL.addVectors(hL, fL).multiplyScalar(0.5).add(off.set(-0.04, 0.04 - 0.05 * duck, 0.2 + 0.08 * duck));
      kR.addVectors(hR, fR).multiplyScalar(0.5).add(off.set(0.04, 0.04 - 0.05 * duck, 0.2 + 0.08 * duck));
      limb(thighL, hL, kL);
      limb(thighR, hR, kR);
      limb(shinL, kL, fL);
      limb(shinR, kR, fR);
      hips.position.copy(H);
      [sL, sR, eL, eR, kL, kR, hL, hR].forEach((p, i) => joints[i].position.copy(p));
      hands[0].position.copy(gL);
      hands[1].position.copy(gR);
      boots[0].position.copy(fL).add(off.set(0, 0, 0.06));
      boots[1].position.copy(fR).add(off.set(0, 0, 0.06));
      // Limb radii are set by scale; limb() wrote the length into scale.y.
      for (const p of rider.children) {
        const r = p.userData.r as number | undefined;
        if (r === undefined) continue;
        if ((p as THREE.Mesh).geometry === ball) p.scale.setScalar(r);
        else p.scale.set(r, p.scale.y, r);
      }
    };
    pose({ duck: 0, lean: 0 });

    const flame = new THREE.Mesh(this.memo("flame", () => new THREE.ConeGeometry(0.16, 1.1, 14, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.55)), m.flame);
    flame.position.set(0, 0.04, -SKI_LENGTH / 2 - 0.15);
    flame.visible = false;
    const shield = new THREE.Mesh(this.memo("shieldGeo", () => new THREE.SphereGeometry(1.35, 24, 16)), m.shield);
    shield.position.set(0, 0.85, 0);
    shield.visible = false;
    body.add(flame, shield);
    return { root, body, pose, flame, shield };
  }

  // --- Obstacles -----------------------------------------------------------------

  /** A Balinese jukung: narrow hull, upturned ends, bamboo outriggers, lateen sail. */
  boat(id: number): THREE.Group {
    const palettes = [
      ["#ffffff", "#d62828", "#ffb703"],
      ["#fff3d6", "#1d4ed8", "#ef4444"],
      ["#e0f2fe", "#0f766e", "#facc15"],
      ["#ffffff", "#7c3aed", "#22c55e"],
    ];
    const [base, band, band2] = palettes[id % palettes.length].map((c) => new THREE.Color(c));
    const length = 4.6;
    const hw = (u: number) => 0.44 * Math.pow(Math.sin(Math.PI * u), 0.6);
    const top = (u: number) => 0.62 + 0.38 * smooth(0.72, 1, u) + 0.22 * (1 - smooth(0, 0.18, u));
    const keel = (u: number) => -0.22 + 0.16 * Math.pow(Math.abs(2 * u - 1), 3);
    const g = new THREE.Group();
    const hullGeo = this.memo(`jukung:${id % palettes.length}`, () =>
      paint(new ParametricGeometry(hullSurface(hw, top, keel, length), 40, 14), (_x, y, z) => {
        const u = (z + length / 2) / length;
        const t = top(u);
        if (y < 0.06) return new THREE.Color("#1e3a5f");
        if (y > t - 0.15 && y < t - 0.06) return band;
        if (y > t - 0.24 && y < t - 0.19) return band2;
        return base;
      }),
    );
    const hullMat = this.memo("jukungMat", () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }));
    g.add(mesh(hullGeo, hullMat));
    const m = this.mats;
    // The bow's tall prow.
    const prow = mesh(this.memo("prow", () => new THREE.ConeGeometry(0.06, 0.7, 8)), m.wood);
    prow.position.set(0, top(1) + 0.05, length / 2 - 0.05);
    prow.rotation.x = 0.85;
    g.add(prow);
    // Outriggers: two curved booms per side reaching out to a bamboo float.
    const boom = (side: number, z: number) =>
      this.memo(`boom:${side}:${z}`, () => {
        const curve = new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(0, 0.66, z),
          new THREE.Vector3(side * 0.75, 1.0, z),
          new THREE.Vector3(side * 1.15, 0.18, z),
        );
        return new THREE.TubeGeometry(curve, 12, 0.035, 6);
      });
    for (const side of [-1, 1]) {
      for (const z of [-1.0, 1.1]) g.add(mesh(boom(side, z), m.bamboo));
      const float = mesh(this.memo("float", () => new THREE.CylinderGeometry(0.075, 0.075, 3.8, 8).rotateX(Math.PI / 2)), m.bamboo);
      float.position.set(side * 1.15, 0.1, 0.05);
      g.add(float);
    }
    const mast = mesh(this.memo("mast", () => new THREE.CylinderGeometry(0.035, 0.05, 3.2, 8)), m.darkWood);
    mast.position.set(0, 2.05, 0.6);
    g.add(mast);
    const sailColors = ["#e63946", "#ffb703", "#f8f9fa", "#2a9d8f", "#ff7b00"];
    const sail = mesh(
      this.memo("sailGeo", () => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0.95, 0.62, 0, 3.7, 0.72, 0, 1.0, -1.8], 3));
        geo.computeVertexNormals();
        return geo;
      }),
      this.memo(`sail:${id % sailColors.length}`, () => new THREE.MeshStandardMaterial({ color: sailColors[id % sailColors.length], side: THREE.DoubleSide, roughness: 0.8 })),
    );
    sail.rotation.y = 0.35;
    g.add(this.foamRing(0.9, 2.9));
    const spar = mesh(this.memo("spar", () => new THREE.CylinderGeometry(0.025, 0.025, 1, 6)), m.darkWood);
    limb(spar, new THREE.Vector3(0.0, 3.72, 0.7), new THREE.Vector3(0.6, 0.98, -1.75));
    g.add(sail, spar);
    return bake(g);
  }

  rock(id: number): THREE.Group {
    const g = new THREE.Group();
    const geo = this.memo(`rock:${id % 4}`, () => {
      const rng = createRng(100 + (id % 4));
      const g = new THREE.IcosahedronGeometry(1, 4);
      const pos = g.getAttribute("position");
      const waves = Array.from({ length: 6 }, () => ({ k: new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize().multiplyScalar(1.5 + rng() * 3), p: rng() * 6.28, a: 0.06 + rng() * 0.08 }));
      const p = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i);
        let r = 1;
        for (const w of waves) r += Math.sin(p.dot(w.k) + w.p) * w.a;
        p.multiplyScalar(r);
        pos.setXYZ(i, p.x * 1.05, p.y * 0.95, p.z * 1.15);
      }
      g.computeVertexNormals();
      return paint(g, (x, y, z) => {
        const n = Math.sin(x * 7 + z * 5) * 0.5 + 0.5;
        if (y < -0.25) return new THREE.Color(0.12, 0.13, 0.12); // wet, under the swell
        if (y > 0.55 && n > 0.75) return new THREE.Color(0.32, 0.4, 0.22); // moss
        const g2 = 0.33 + n * 0.12 + y * 0.06;
        return new THREE.Color(g2, g2 * 0.96, g2 * 0.92);
      });
    });
    g.add(mesh(geo, this.mats.rock), this.foamRing(1.75, 1.95));
    return bake(g);
  }

  log(): THREE.Group {
    const g = new THREE.Group();
    const cap = this.memo("logCap", () => {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const x = c.getContext("2d")!;
      x.fillStyle = "#c79a68";
      x.fillRect(0, 0, 64, 64);
      x.strokeStyle = "rgba(110,70,35,0.6)";
      for (let r = 4; r < 32; r += 4) {
        x.beginPath();
        x.arc(32, 32, r, 0, Math.PI * 2);
        x.stroke();
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
    });
    const trunk = mesh(this.memo("logGeo", () => new THREE.CylinderGeometry(0.3, 0.3, 2.3, 18).rotateZ(Math.PI / 2)), [this.mats.bark, cap, cap]);
    trunk.position.y = 0.28;
    g.add(trunk, this.foamRing(1.45, 0.6));
    return g;
  }

  net(): THREE.Group {
    const g = new THREE.Group();
    const m = this.mats;
    const line = mesh(this.memo("netLine", () => new THREE.CylinderGeometry(0.015, 0.015, 2.5, 6).rotateZ(Math.PI / 2)), m.rope);
    line.position.y = 0.6;
    g.add(line);
    for (let i = 0; i < 6; i++) {
      const b = mesh(this.memo("netBuoy", () => new THREE.SphereGeometry(0.14, 14, 10)), i % 2 ? m.white : m.red);
      b.position.set(-1.1 + i * 0.44, 0.6, 0);
      g.add(b);
    }
    const sheet = mesh(this.memo("netSheet", () => new THREE.PlaneGeometry(2.4, 1.2)), m.net, false);
    const map = m.net.map!;
    map.repeat.set(6, 3);
    sheet.position.y = 0.02;
    g.add(sheet, this.foamRing(1.45, 0.45));
    return bake(g);
  }

  /** Bunting on a rope between two poles: duck under it. */
  flags(id: number): THREE.Group {
    const g = new THREE.Group();
    const m = this.mats;
    for (const side of [-1, 1]) {
      const pole = mesh(this.memo("pole", () => new THREE.CylinderGeometry(0.05, 0.065, 3.2, 8)), m.wood);
      pole.position.set(side * 1.32, 1.2, 0);
      g.add(pole);
    }
    const sag = (x: number) => 2.62 - 0.28 * (1 - (x / 1.32) ** 2);
    const rope = mesh(this.memo("ropeGeo", () => new THREE.TubeGeometry(new THREE.CatmullRomCurve3([-1.32, -0.66, 0, 0.66, 1.32].map((x) => new THREE.Vector3(x, sag(x), 0))), 16, 0.012, 5)), m.rope);
    g.add(rope);
    const colours = ["#e63946", "#ffd166", "#06d6a0", "#118ab2", "#f78c6b"];
    const tri = this.memo("flagGeo", () => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute([-0.15, 0, 0, 0.15, 0, 0, 0, -1.4, 0], 3));
      geo.computeVertexNormals();
      return geo;
    });
    for (let i = 0; i < 7; i++) {
      const x = -1.08 + i * 0.36;
      const colour = colours[(i + id) % colours.length];
      const flag = mesh(tri, this.memo(`flag:${colour}`, () => new THREE.MeshStandardMaterial({ color: colour, side: THREE.DoubleSide, roughness: 0.8 })), false);
      flag.position.set(x, sag(x), 0);
      flag.userData.flutter = i * 0.7 + id;
      g.add(flag);
    }
    return g;
  }

  /** One lane's section of a pier: 2.4 m wide, 7 m long, deck from 0.95 m to 2.05 m. */
  deck(outerSide: number): THREE.Group {
    const g = new THREE.Group();
    const m = this.mats;
    const top = mesh(this.memo("deckTop", () => new THREE.BoxGeometry(2.4, 0.16, 7).translate(0, 0, 3.5)), m.planks);
    top.position.y = 1.97;
    const beam = (z: number) => {
      const b = mesh(this.memo("deckBeam", () => new THREE.BoxGeometry(2.4, 0.3, 0.26)), m.darkWood);
      b.position.set(0, 1.1, z);
      return b;
    };
    g.add(top, beam(0.13), beam(6.87));
    for (const x of [-1.05, 1.05]) {
      const joist = mesh(this.memo("joist", () => new THREE.BoxGeometry(0.18, 0.62, 7).translate(0, 0, 3.5)), m.darkWood);
      joist.position.set(x, 1.58, 0);
      g.add(joist);
      for (const z of [0.2, 6.8]) {
        const post = mesh(this.memo("pierPost", () => new THREE.CylinderGeometry(0.13, 0.15, 3.2, 10)), m.darkWood);
        post.position.set(x, 0.4, z);
        const foam = this.foamRing(0.35, 0.35, z);
        foam.position.x = x;
        g.add(post, foam);
      }
    }
    if (outerSide !== 0) {
      // Railing along the open side of the pier.
      const x = outerSide * 1.12;
      for (let z = 0.2; z <= 7; z += 1.7) {
        const p = mesh(this.memo("railPost", () => new THREE.BoxGeometry(0.08, 0.9, 0.08)), m.wood);
        p.position.set(x, 2.5, z);
        g.add(p);
      }
      const rail = mesh(this.memo("rail", () => new THREE.BoxGeometry(0.1, 0.08, 7).translate(0, 0, 3.5)), m.wood);
      rail.position.set(x, 2.92, 0);
      g.add(rail);
    }
    return bake(g);
  }

  /** Pillars under a pier: a wall of posts and braces, no way through. */
  pillars(): THREE.Group {
    const g = new THREE.Group();
    const m = this.mats;
    for (const z of [0.3, 3.5, 6.7]) {
      g.add(this.foamRing(1.1, 0.45, z));
      for (const x of [-0.65, 0, 0.65]) {
        const post = mesh(this.memo("pillarPost", () => new THREE.CylinderGeometry(0.15, 0.17, 3.1, 10)), m.darkWood);
        post.position.set(x, 0.45, z);
        g.add(post);
      }
      for (const s of [-1, 1]) {
        const brace = mesh(this.memo("brace", () => new THREE.BoxGeometry(0.08, 1, 0.1)), m.wood);
        limb(brace, new THREE.Vector3(-0.7 * s, 0.05, z), new THREE.Vector3(0.7 * s, 0.9, z));
        g.add(brace);
      }
    }
    return bake(g);
  }

  /** A floating wedge: 1 m high at its far edge. */
  ramp(): THREE.Group {
    const g = new THREE.Group();
    const geo = this.memo("rampGeo", () => {
      const w = 1.1;
      const geoTop = new THREE.BufferGeometry();
      geoTop.setAttribute("position", new THREE.Float32BufferAttribute([-w, 0, 0, w, 0, 0, w, 1, 3, -w, 1, 3], 3));
      geoTop.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      geoTop.setIndex([0, 2, 1, 0, 3, 2]);
      geoTop.computeVertexNormals();
      return geoTop;
    });
    const sides = this.memo("rampSides", () => {
      const w = 1.1;
      const s = new THREE.BufferGeometry();
      s.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([-w, 0, 0, -w, 1, 3, -w, 0, 3, w, 0, 0, w, 0, 3, w, 1, 3, -w, 0, 3, -w, 1, 3, w, 1, 3, -w, 0, 3, w, 1, 3, w, 0, 3], 3),
      );
      s.computeVertexNormals();
      return s;
    });
    const top = mesh(geo, this.mats.chevron);
    const side = mesh(sides, this.mats.rampSide);
    (side.material as THREE.Material).side = THREE.DoubleSide;
    g.add(top, side);
    for (const x of [-1.0, 1.0]) {
      const pontoon = mesh(this.memo("pontoon", () => new THREE.CylinderGeometry(0.16, 0.16, 3.2, 10).rotateX(Math.PI / 2)), this.mats.white);
      pontoon.position.set(x, 0.05, 1.5);
      g.add(pontoon);
    }
    g.add(this.foamRing(1.35, 1.9, 1.5));
    g.add(this.rampArch());
    for (const x of [-1.45, 1.45]) {
      const foot = this.foamRing(0.5, 0.5);
      foot.position.x = x;
      g.add(foot);
    }
    return bake(g);
  }

  /**
   * A striped inflatable gate over the ramp's mouth: seen from far off, where a
   * low wedge on the water is not. High enough to ride under, even mid-hop.
   */
  private rampArch(): THREE.Mesh {
    const geo = this.memo("rampArch", () => {
      const [w, h] = [1.45, 3.4];
      const curve = new THREE.CatmullRomCurve3(
        Array.from({ length: 25 }, (_, i) => {
          const t = -0.12 + (i / 24) * (Math.PI + 0.24);
          return new THREE.Vector3(Math.cos(t) * w, Math.sin(t) * h, 0);
        }),
      );
      const segments = 48;
      const radial = 12;
      const tube = new THREE.TubeGeometry(curve, segments, 0.22, radial, false);
      const colors: number[] = [];
      const [hot, cream] = [new THREE.Color(0xff5214), new THREE.Color(0xfff1d6)];
      for (let i = 0; i <= segments; i++) {
        const c = Math.floor((i / segments) * 9) % 2 ? cream : hot;
        for (let j = 0; j <= radial; j++) colors.push(c.r, c.g, c.b);
      }
      tube.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      return tube;
    });
    const arch = mesh(geo, this.mats.arch);
    arch.name = "arch";
    return arch;
  }

  /** A banana boat full of riders, towed sideways across the lanes. Long along x. */
  banana(): THREE.Group {
    const g = new THREE.Group();
    const m = this.mats;
    const tube = mesh(this.memo("bananaTube", () => new THREE.CapsuleGeometry(0.34, 4.4, 8, 18).rotateZ(Math.PI / 2)), m.banana);
    tube.position.y = 0.38;
    g.add(tube);
    for (const z of [-0.36, 0.36]) {
      const pontoon = mesh(this.memo("bananaPontoon", () => new THREE.CapsuleGeometry(0.17, 3.8, 6, 12).rotateZ(Math.PI / 2)), m.bananaDark);
      pontoon.position.set(-0.2, 0.12, z);
      g.add(pontoon);
    }
    const nose = mesh(this.memo("bananaNose", () => new THREE.ConeGeometry(0.3, 0.8, 16).rotateZ(-Math.PI / 2)), m.banana);
    nose.position.set(2.95, 0.5, 0);
    nose.rotation.z = 0.25;
    g.add(nose);
    const vests = ["#ef476f", "#118ab2", "#06d6a0", "#f78c6b"];
    vests.forEach((c, i) => {
      const x = -1.7 + i * 1.15;
      const torso = mesh(this.memo("bananaTorso", () => new THREE.CapsuleGeometry(0.16, 0.3, 4, 10)), this.memo(`vest:${c}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75 })));
      torso.position.set(x, 0.98, 0);
      torso.rotation.z = -0.15;
      const head = mesh(this.memo("bananaHead", () => new THREE.SphereGeometry(0.13, 14, 10)), m.skin);
      head.position.set(x + 0.06, 1.38, 0);
      const hair = mesh(this.memo("hair", () => new THREE.SphereGeometry(0.135, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2)), m.wetsuit);
      hair.position.copy(head.position);
      g.add(torso, head, hair);
    });
    const tow = mesh(this.memo("tow", () => new THREE.CylinderGeometry(0.012, 0.012, 7, 4).rotateZ(Math.PI / 2).translate(3.5, 0, 0)), m.rope, false);
    tow.position.set(3.3, 0.55, 0);
    g.add(tow, this.foamRing(2.9, 0.75));
    return bake(g);
  }

  /** A police patrol boat with a light bar; the renderer flashes the lights. */
  policeBoat(): { group: THREE.Group; red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial } {
    const g = new THREE.Group();
    const length = 6.2;
    const hw = (u: number) => (u < 0.1 ? 1.0 + 0.12 * smooth(0, 0.1, u) : 1.12 * (1 - Math.pow(Math.max(0, (u - 0.45) / 0.55), 2.2)));
    const top = (u: number) => 0.85 + 0.35 * smooth(0.6, 1, u);
    const keel = (u: number) => -0.35 + 0.6 * Math.pow(smooth(0.5, 1, u), 1.6);
    const white = new THREE.Color("#f4f6f8");
    const blue = new THREE.Color("#0b3d91");
    const hull = mesh(
      paint(new ParametricGeometry(hullSurface(hw, top, keel, length), 40, 16), (_x, y, z) => {
        const u = (z + length / 2) / length;
        const t = top(u);
        if (y < 0.05) return new THREE.Color("#2b2f36");
        if (y > t - 0.42 && y < t - 0.12) return blue;
        return white;
      }),
      new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.35, clearcoat: 0.8, side: THREE.DoubleSide }),
    );
    g.add(hull);
    const deck = mesh(
      new ParametricGeometry((u, s, t) => {
        const ss = s * 2 - 1;
        t.set(ss * hw(u) * 0.98, top(u) + 0.04 * (1 - ss * ss), -length / 2 + u * length);
      }, 20, 6),
      new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.6 }),
    );
    g.add(deck);
    const cabin = mesh(new RoundedBoxGeometry(1.5, 1.0, 2.0, 3, 0.12), new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.4 }));
    cabin.position.set(0, 1.4, -0.2);
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0d1b2a, roughness: 0.05, metalness: 0.4, clearcoat: 1 });
    const front = mesh(new THREE.BoxGeometry(1.36, 0.45, 0.05), glass);
    front.position.set(0, 1.55, 0.82);
    front.rotation.x = -0.25;
    const back = mesh(new THREE.BoxGeometry(1.2, 0.4, 0.05), glass);
    back.position.set(0, 1.55, -1.22);
    for (const side of [-1, 1]) {
      const pane = mesh(new THREE.BoxGeometry(0.05, 0.4, 1.4), glass);
      pane.position.set(side * 0.76, 1.55, -0.2);
      g.add(pane);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.42), new THREE.MeshStandardMaterial({ map: signTexture("POLAIRUD", "#0b3d91", "#ffffff"), roughness: 0.5 }));
      label.position.set(side * 1.02, 0.55, -0.6);
      label.rotation.y = side * Math.PI / 2;
      g.add(label);
    }
    g.add(cabin, front, back);
    const bar = mesh(new RoundedBoxGeometry(1.1, 0.12, 0.3, 2, 0.04), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 }));
    bar.position.set(0, 1.98, -0.2);
    const red = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff1010, emissiveIntensity: 4, roughness: 0.3 });
    const blueLight = new THREE.MeshStandardMaterial({ color: 0x2050ff, emissive: 0x1040ff, emissiveIntensity: 4, roughness: 0.3 });
    const lr = mesh(new RoundedBoxGeometry(0.42, 0.14, 0.26, 2, 0.04), red, false);
    lr.position.set(-0.3, 2.08, -0.2);
    const lb = mesh(new RoundedBoxGeometry(0.42, 0.14, 0.26, 2, 0.04), blueLight, false);
    lb.position.set(0.3, 2.08, -0.2);
    const antenna = mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.2, 4), this.mats.metal, false);
    antenna.position.set(0.55, 2.5, -0.9);
    g.add(bar, lr, lb, antenna);
    return { group: g, red, blue: blueLight };
  }

  // --- Pickups -------------------------------------------------------------------

  coinGeometry() {
    return this.memo("coinGeo", () => new THREE.CylinderGeometry(0.32, 0.32, 0.07, 32).rotateX(Math.PI / 2));
  }

  power(kind: PowerKind): THREE.Group {
    const tint = { magnet: 0xff5a5a, shield: 0xffa53c, double: 0x6ee06e, nitro: 0x4fa8ff }[kind];
    const g = new THREE.Group();
    const bubble = new THREE.Mesh(
      this.memo("bubbleGeo", () => new THREE.SphereGeometry(0.6, 24, 16)),
      this.memo(`bubble:${kind}`, () => new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 0.5, transparent: true, opacity: 0.32, roughness: 0.1, depthWrite: false })),
    );
    g.add(bubble);
    const m = this.mats;
    if (kind === "magnet") {
      const u = mesh(this.memo("magnetGeo", () => new THREE.TorusGeometry(0.2, 0.07, 10, 20, Math.PI)), m.red);
      u.rotation.z = Math.PI;
      g.add(u);
      for (const x of [-0.2, 0.2]) {
        const tip = mesh(this.memo("magnetTip", () => new THREE.CylinderGeometry(0.07, 0.07, 0.12, 10)), m.metal);
        tip.position.set(x, 0.06, 0);
        g.add(tip);
      }
    } else if (kind === "shield") {
      for (let i = 0; i < 4; i++) {
        const seg = mesh(this.memo("ringSeg", () => new THREE.TorusGeometry(0.24, 0.08, 10, 8, Math.PI / 2)), i % 2 ? m.white : m.orange);
        seg.rotation.z = (i * Math.PI) / 2;
        g.add(seg);
      }
    } else if (kind === "double") {
      const label = new THREE.Sprite(this.memo("x2", () => new THREE.SpriteMaterial({ map: signTexture("×2", "rgba(0,0,0,0)", "#ffffff"), transparent: true })));
      label.scale.set(1.0, 0.25, 1);
      g.add(label);
    } else {
      const can = mesh(this.memo("canGeo", () => new THREE.CylinderGeometry(0.13, 0.13, 0.42, 14)), this.memo("canMat", () => new THREE.MeshStandardMaterial({ color: 0x3a86ff, metalness: 0.6, roughness: 0.3 })));
      const cap = mesh(this.memo("capGeo", () => new THREE.CylinderGeometry(0.06, 0.06, 0.1, 10)), m.metal);
      cap.position.y = 0.26;
      g.add(can, cap);
    }
    return g;
  }

  // --- The beach -------------------------------------------------------------------

  palm(variant: number): THREE.Group {
    return this.memo(`palm:${variant}`, () => {
      const rng = createRng(500 + variant);
      const g = new THREE.Group();
      const height = 6.5 + rng() * 3;
      const lean = 1 + rng() * 1.6;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, -0.3, 0),
        new THREE.Vector3(lean * 0.15, height * 0.4, 0),
        new THREE.Vector3(lean * 0.55, height * 0.78, 0),
        new THREE.Vector3(lean, height, 0),
      ]);
      const trunk = new THREE.TubeGeometry(curve, 24, 0.24, 10);
      // Taper towards the crown.
      const pos = trunk.getAttribute("position");
      const ring = 11;
      const c = new THREE.Vector3();
      const p = new THREE.Vector3();
      for (let i = 0; i <= 24; i++) {
        curve.getPointAt(i / 24, c);
        const k = 1 - 0.45 * (i / 24);
        for (let j = 0; j < ring; j++) {
          const idx = i * ring + j;
          p.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(k).add(c);
          pos.setXYZ(idx, p.x, p.y, p.z);
        }
      }
      trunk.computeVertexNormals();
      g.add(mesh(trunk, this.mats.bark));
      const crown = new THREE.Vector3(lean, height, 0);
      const leaf = this.memo("leafGeo", () => {
        const geo = new THREE.PlaneGeometry(3.6, 1.1, 10, 1).rotateX(-Math.PI / 2).translate(1.8, 0, 0);
        const lp = geo.getAttribute("position");
        for (let i = 0; i < lp.count; i++) {
          const x = lp.getX(i);
          lp.setY(i, 0.45 * x - 0.17 * x * x);
          lp.setZ(i, lp.getZ(i) * (1 - (x / 3.6) * 0.6));
        }
        geo.computeVertexNormals();
        return geo;
      });
      for (let i = 0; i < 10; i++) {
        const f = mesh(leaf, this.mats.frond, true);
        f.position.copy(crown);
        f.rotation.set(0, (i / 10) * Math.PI * 2 + rng() * 0.4, (rng() - 0.5) * 0.4);
        g.add(f);
      }
      for (let i = 0; i < 4; i++) {
        const nut = mesh(this.memo("nut", () => new THREE.SphereGeometry(0.16, 10, 8)), this.mats.coconut);
        nut.position.copy(crown).add(new THREE.Vector3(Math.cos(i * 1.7) * 0.22, -0.25, Math.sin(i * 1.7) * 0.22));
        g.add(nut);
      }
      return bake(g);
    }).clone();
  }

  umbrella(colours: [string, string]): THREE.Group {
    const g = new THREE.Group();
    const canopy = mesh(
      this.memo(`umbrella:${colours.join()}`, () => {
        const geo = new THREE.ConeGeometry(1.5, 0.5, 16, 1, true);
        const a = new THREE.Color(colours[0]);
        const b = new THREE.Color(colours[1]);
        return paint(geo, (x, _y, z) => (Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 16) % 2 ? a : b));
      }),
      this.memo("umbrellaMat", () => new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.75 })),
    );
    canopy.position.y = 2.3;
    const pole = mesh(this.memo("umbrellaPole", () => new THREE.CylinderGeometry(0.03, 0.03, 2.6, 6)), this.mats.white);
    pole.position.y = 1.2;
    g.add(canopy, pole);
    for (const x of [-0.7, 0.7]) {
      const lounger = mesh(this.memo("lounger", () => new RoundedBoxGeometry(0.6, 0.12, 1.8, 2, 0.04)), this.memo(`lounger:${colours[0]}`, () => new THREE.MeshStandardMaterial({ color: colours[0], roughness: 0.7 })));
      lounger.position.set(x, 0.32, 0.4);
      lounger.rotation.x = -0.12;
      g.add(lounger);
    }
    return bake(g);
  }

  warung(): THREE.Group {
    return this.memo("warung", () => {
      const g = new THREE.Group();
      const m = this.mats;
      for (const [x, z] of [[-1.6, -1.2], [1.6, -1.2], [-1.6, 1.2], [1.6, 1.2]]) {
        const post = mesh(new THREE.CylinderGeometry(0.08, 0.09, 2.6, 8), m.darkWood);
        post.position.set(x, 1.3, z);
        g.add(post);
      }
      const counter = mesh(new THREE.BoxGeometry(3.2, 1.0, 0.6), m.planks);
      counter.position.set(0, 0.55, -1.0);
      const roof = mesh(new THREE.ConeGeometry(3.0, 1.5, 4).rotateY(Math.PI / 4), m.thatch);
      roof.position.y = 3.25;
      roof.scale.set(1.1, 1, 0.9);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.45), new THREE.MeshStandardMaterial({ map: signTexture("ES KELAPA", "#d62828", "#ffffff"), roughness: 0.6 }));
      sign.position.set(0, 2.35, -1.25);
      sign.rotation.y = Math.PI;
      g.add(counter, roof, sign);
      for (let i = 0; i < 5; i++) {
        const nut = mesh(new THREE.SphereGeometry(0.17, 10, 8), m.coconut);
        nut.position.set(-1 + i * 0.5, 1.2, -1.0);
        g.add(nut);
      }
      return bake(g);
    }).clone();
  }

  surfboards(seed: number): THREE.Group {
    const g = new THREE.Group();
    const colours = ["#ff595e", "#ffca3a", "#1982c4", "#8ac926", "#ffffff"];
    for (let i = 0; i < 3; i++) {
      const c = colours[(i + seed) % colours.length];
      const board = mesh(this.memo("boardGeo", () => new THREE.SphereGeometry(1, 16, 10).scale(0.27, 1.05, 0.05)), this.memo(`board:${c}`, () => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.3, clearcoat: 1 })));
      board.position.set(i * 0.5 - 0.5, 0.9, 0);
      board.rotation.z = (i - 1) * 0.12;
      g.add(board);
    }
    return bake(g);
  }

  /** A bottlenose dolphin, 2.3 m, swimming along +z. */
  dolphin(): THREE.Group {
    return this.memo("dolphin", () => {
      const g = new THREE.Group();
      const length = 2.3;
      const radius = (u: number) => 0.27 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.08)), 0.75) * (u > 0.85 ? 1 - (u - 0.85) * 2.5 : 1);
      const body = new ParametricGeometry((u, v, t) => {
        const a = v * Math.PI * 2;
        const r = Math.max(0.015, radius(u));
        // A beak at the front, a slimmer tail stock behind.
        const beak = u > 0.9 ? 0.55 : 1;
        t.set(Math.cos(a) * r * 0.85 * beak, Math.sin(a) * r * beak + (u > 0.88 ? -0.04 : 0), -length / 2 + u * length);
      }, 36, 16);
      paint(body, (_x, y) => (y < -0.05 ? new THREE.Color(0.78, 0.8, 0.82) : new THREE.Color(0.33, 0.37, 0.42)));
      const m = this.mats.dolphin;
      g.add(mesh(body, m, false));
      const fin = (points: number[]) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
        geo.computeVertexNormals();
        paint(geo, () => new THREE.Color(0.3, 0.34, 0.39));
        const f = mesh(geo, m, false);
        (f.material as THREE.Material).side = THREE.DoubleSide;
        return f;
      };
      g.add(fin([0, 0.2, 0.15, 0, 0.5, -0.2, 0, 0.2, -0.35])); // dorsal
      g.add(fin([0, 0, -1.05, -0.38, 0.02, -1.32, 0, 0, -1.2, 0, 0, -1.05, 0.38, 0.02, -1.32, 0, 0, -1.2])); // flukes
      g.add(fin([0.18, -0.1, 0.35, 0.42, -0.2, 0.05, 0.2, -0.12, 0.15, -0.18, -0.1, 0.35, -0.42, -0.2, 0.05, -0.2, -0.12, 0.15])); // flippers
      return bake(g);
    }).clone();
  }

  /** A gull: white body, grey wings with dark tips; the wings are children so they can flap. */
  gull(): THREE.Group {
    const g = new THREE.Group();
    const body = mesh(this.memo("gullBody", () => paint(new THREE.SphereGeometry(1, 12, 8).scale(0.09, 0.08, 0.3), () => new THREE.Color(0.95, 0.95, 0.95))), this.mats.gull, false);
    g.add(body);
    for (const side of [-1, 1]) {
      const wing = new THREE.Group();
      const geo = this.memo(`gullWing:${side}`, () => {
        const w = new THREE.BufferGeometry();
        w.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0.1, side * 0.42, 0.04, 0.02, 0, 0, -0.12, side * 0.42, 0.04, 0.02, side * 0.75, -0.04, -0.12, 0, 0, -0.12], 3));
        w.computeVertexNormals();
        return paint(w, (x) => (Math.abs(x) > 0.55 ? new THREE.Color(0.12, 0.12, 0.14) : new THREE.Color(0.72, 0.74, 0.78)));
      });
      wing.add(mesh(geo, this.mats.gull, false));
      wing.userData.side = side;
      g.add(wing);
    }
    return g;
  }

  /** A clump of jungle behind the beach. */
  bush(seed: number): THREE.Group {
    const g = new THREE.Group();
    const rng = createRng(900 + seed);
    // Lumpy, sunlit on top, darker underneath: reads as foliage, not boulders.
    const geo = this.memo("bushBall", () => {
      const ball = new THREE.IcosahedronGeometry(1, 3);
      const pos = ball.getAttribute("position");
      const p = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i);
        p.multiplyScalar(1 + Math.sin(p.x * 7) * Math.sin(p.y * 6) * Math.sin(p.z * 8) * 0.12);
        pos.setXYZ(i, p.x, p.y, p.z);
      }
      ball.computeVertexNormals();
      return paint(ball, (x, y, z) => {
        const n = 0.5 + 0.5 * Math.sin(x * 9 + z * 7);
        return new THREE.Color(0.17 + 0.08 * n, 0.33 + 0.16 * Math.max(0, y) + 0.06 * n, 0.14 + 0.04 * n);
      });
    });
    for (let i = 0; i < 6; i++) {
      const b = mesh(geo, this.mats.jungle, false);
      const r = 1.6 + rng() * 2.2;
      b.scale.set(r, r * (0.75 + rng() * 0.5), r);
      b.position.set((rng() - 0.5) * 9, r * 0.5, (rng() - 0.5) * 9);
      g.add(b);
    }
    return bake(g);
  }

  sailboat(): THREE.Group {
    return this.memo("sailboat", () => {
      const g = new THREE.Group();
      const hull = mesh(new THREE.BoxGeometry(1.2, 0.5, 4), new THREE.MeshStandardMaterial({ color: 0x2b2140, roughness: 0.6 }), false);
      hull.position.y = 0.2;
      const sail = new THREE.Mesh(
        new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0.5, 1.2, 0, 5.5, 0.6, 0, 0.6, -1.6], 3)),
        new THREE.MeshStandardMaterial({ color: 0xfbe7d0, side: THREE.DoubleSide, roughness: 0.8 }),
      );
      sail.geometry.computeVertexNormals();
      g.add(hull, sail);
      return bake(g);
    }).clone();
  }
}
