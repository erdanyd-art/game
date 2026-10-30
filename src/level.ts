import type { Night } from "./nights.ts";
import { between, createRng } from "./rng.ts";

export type Cluster = { x: number; y: number; count: number };
export type Pad = { x: number; y: number; r: number; notch: number; flower: boolean; bob: number };
export type Root = { x: number; side: -1 | 1; reach: number; width: number };
export type Canopy = { x: number; side: -1 | 1; depth: number; r: number; shade: number };
export type Ripple = { x: number; y: number; len: number; phase: number };
export type Blob = { dx: number; dy: number; r: number; shade: number };
/** Land closing off the river behind the start and beyond the tree. */
export type Cap = { x: number; dir: -1 | 1; blobs: { y: number; depth: number; r: number; shade: number }[] };

export type Level = {
  night: Night;
  /** Where the winding river opens into the tree's lagoon. */
  end: number;
  tree: { x: number; y: number };
  /** Middle of the river at x. */
  center: (x: number) => number;
  /** Half the river's width at x. */
  half: (x: number) => number;
  clusters: Cluster[];
  frogs: { x: number; y: number }[];
  pads: Pad[];
  roots: Root[];
  canopy: Canopy[];
  ripples: Ripple[];
  treeCanopy: Blob[];
  caps: Cap[];
  /** Every firefly of the night: the starting swarm plus all the wild ones. */
  total: number;
};

const TAU = Math.PI * 2;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export const START_X = 200;

export function createLevel(night: Night): Level {
  const rng = createRng(night.seed);
  const p1 = rng() * TAU;
  const p2 = rng() * TAU;
  const p3 = rng() * TAU;
  const end = night.length;

  // Open, calm water where the night starts and around the tree; winding between.
  const center = (x: number) => {
    const wind = smoothstep(0, 700, x) * (1 - smoothstep(end - 900, end - 200, x));
    return wind * (170 * Math.sin(x * 0.0011 + p1) + 80 * Math.sin(x * 0.0029 + p2));
  };
  const half = (x: number) => {
    const narrow = (310 + 70 * Math.sin(x * 0.0017 + p3)) * night.width;
    const open = Math.max(1 - smoothstep(0, 600, x), smoothstep(end - 700, end - 150, x));
    return narrow + (440 - narrow) * open;
  };
  const inRiver = (x: number, spread: number) => center(x) + between(rng, -spread, spread) * half(x);

  const clusters: Cluster[] = [];
  for (let i = 0; i < night.clusters; i++) {
    const x = 650 + ((end - 1100) * (i + 0.2 + rng() * 0.6)) / night.clusters;
    clusters.push({ x, y: inRiver(x, 0.6), count: Math.round(between(rng, 4, 7 + night.number)) });
  }

  const pad = (x: number, y: number, r: number): Pad => ({
    x,
    y,
    r,
    notch: rng() * TAU,
    flower: rng() < 0.18,
    bob: rng() * TAU,
  });
  const pads: Pad[] = [];
  for (let x = 120; x < end + 500; x += between(rng, 50, 110)) {
    if (rng() < 0.55) pads.push(pad(x, inRiver(x, 0.85), between(rng, 11, 26)));
  }

  // Frogs guard the clusters from big pads nearby, so lingering to recruit is a risk.
  // None in the opening stretch of the first night.
  const frogs: { x: number; y: number }[] = [];
  const firstFrog = night.number === 1 ? 1500 : 1000;
  const guarded = clusters.filter((c) => c.x >= firstFrog + 230);
  for (let i = 0; i < night.frogs && guarded.length; i++) {
    const c = guarded[Math.floor(((i + 0.5) * guarded.length) / night.frogs)];
    const angle = rng() * TAU;
    const distance = between(rng, 170, 230);
    const x = c.x + Math.cos(angle) * distance;
    const limit = half(x) * 0.8;
    const y = Math.min(center(x) + limit, Math.max(center(x) - limit, c.y + Math.sin(angle) * distance));
    frogs.push({ x, y });
    pads.push({ ...pad(x, y, 30), flower: false });
  }

  const roots: Root[] = [];
  const canopy: Canopy[] = [];
  for (const side of [-1, 1] as const) {
    for (let x = -400; x < end + 1400; x += between(rng, 18, 34)) {
      roots.push({ x, side, reach: between(rng, 14, 46), width: between(rng, 14, 30) });
    }
    for (let x = -400; x < end + 1400; x += between(rng, 40, 75)) {
      canopy.push({ x, side, depth: between(rng, 25, 90), r: between(rng, 40, 95), shade: rng() });
    }
  }

  const ripples: Ripple[] = [];
  const rippleCount = Math.round((end / 1000) * 70);
  for (let i = 0; i < rippleCount; i++) {
    const x = between(rng, 0, end + 600);
    ripples.push({ x, y: inRiver(x, 0.92), len: between(rng, 12, 44), phase: rng() * TAU });
  }

  const tree = { x: end + 140, y: center(end + 140) };
  const treeCanopy: Blob[] = [{ dx: 0, dy: 0, r: 110, shade: 0.5 }];
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * TAU + rng() * 0.3;
    const distance = between(rng, 40, 150);
    treeCanopy.push({
      dx: Math.cos(angle) * distance,
      dy: Math.sin(angle) * distance * 0.85,
      r: between(rng, 55, 105),
      shade: rng(),
    });
  }

  const cap = (x: number, dir: -1 | 1): Cap => {
    const blobs = [];
    for (let y = -1100; y < 1100; y += between(rng, 45, 80)) {
      blobs.push({ y, depth: between(rng, 20, 90), r: between(rng, 45, 100), shade: rng() });
    }
    return { x, dir, blobs };
  };
  const caps = [cap(-160, -1), cap(end + 640, 1)];

  const total = night.startSwarm + clusters.reduce((sum, c) => sum + c.count, 0);
  return { night, end, tree, center, half, clusters, frogs, pads, roots, canopy, ripples, treeCanopy, caps, total };
}
