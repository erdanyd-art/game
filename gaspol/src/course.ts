import {
  airtime,
  BANANA_SPEED,
  heightAt,
  JUMP_VY,
  LANE_SWITCH_TIME,
  LANE_X,
  overRampOffset,
  PLAYER,
  RAMP_VY,
  SPECS,
  speedAt,
  tierAt,
  TRAFFIC_SPEED,
  type ObstacleKind,
} from "./config.ts";
import { between, createRng, type Rng } from "./rng.ts";

// The course is built from hand-made patterns: rows of three lanes, spaced in
// seconds so they feel the same at any speed. Each cell is one of:
//   .  open water        B boat      R rock        T another jetski (moving)
//   L  log (jump)        N net (jump)
//   H  flag line (duck)  D pier deck (duck)        P pier pillar (blocked)
//   J  wave ramp: big air, high enough to clear a row of boats

export type Cell = "." | "B" | "R" | "L" | "N" | "H" | "D" | "P" | "J" | "T";

/** One row as the player meets it: `time` is seconds from the start at normal speed. */
export type Row = { z: number; time: number; cells: Cell[] };

export type ObstacleSpawn = {
  kind: ObstacleKind;
  x: number;
  z: number;
  /** Moving obstacles are placed so they reach (x, z) exactly when the player does. */
  vx?: number;
  vz?: number;
};
export type CoinSpawn = { x: number; y: number; z: number };
export type PowerKind = "magnet" | "shield" | "double" | "nitro";
export type PowerSpawn = { kind: PowerKind; x: number; z: number };
export type Batch = { obstacles: ObstacleSpawn[]; coins: CoinSpawn[]; powers: PowerSpawn[] };

type PatternRow = {
  /** Seconds after the previous row, before tier scaling. */
  gap: number;
  cells: string;
  /** Placed by the arc of the ramp in the previous row, not by `gap`: flown over. */
  overRamp?: boolean;
};
type Pattern = {
  name: string;
  tier: number;
  weight: number;
  rows: PatternRow[];
  /** The blocked lanes of the first row are a banana boat crossing, not boats. */
  banana?: boolean;
};

const row = (cells: string, gap = 0): PatternRow => ({ gap, cells });
/** A wall of boats right where a ramp jump clears it. */
const wall = (cells: string): PatternRow => ({ gap: 0, cells, overRamp: true });

const PATTERNS: Pattern[] = [
  // Tier 0: one idea at a time.
  { name: "boat", tier: 0, weight: 3, rows: [row("B..")] },
  { name: "rock", tier: 0, weight: 2, rows: [row(".R.")] },
  { name: "two boats", tier: 0, weight: 2, rows: [row("BB.")] },
  { name: "gate", tier: 0, weight: 2, rows: [row("R.B")] },
  { name: "logs", tier: 0, weight: 2, rows: [row("LLL")] },
  { name: "nets", tier: 0, weight: 1, rows: [row("NNN")] },
  { name: "flags", tier: 0, weight: 2, rows: [row("HHH")] },
  { name: "lone ramp", tier: 0, weight: 1, rows: [row(".J.")] },
  { name: "breather", tier: 0, weight: 1, rows: [row("...")] },
  // Tier 1: pairs.
  { name: "zigzag", tier: 1, weight: 3, rows: [row("BB."), row(".BB", 0.8)] },
  { name: "dodge then hop", tier: 1, weight: 2, rows: [row("B.R"), row("LLL", 0.85)] },
  { name: "duck then dodge", tier: 1, weight: 2, rows: [row("HHH"), row("B.B", 0.9)] },
  { name: "pier", tier: 1, weight: 2, rows: [row("PDD")] },
  { name: "over the wall", tier: 1, weight: 2, rows: [row("JBB"), wall("BBB")] },
  { name: "traffic", tier: 1, weight: 2, rows: [row("T..")] },
  { name: "hop or slip", tier: 1, weight: 2, rows: [row("L.B")] },
  { name: "rock garden", tier: 1, weight: 1, rows: [row("RLR")] },
  { name: "banana", tier: 1, weight: 2, banana: true, rows: [row("BB.")] },
  // Tier 2: short combinations.
  { name: "slalom", tier: 2, weight: 3, rows: [row("BB."), row(".BB", 0.7), row("BB.", 0.7)] },
  { name: "hop and duck", tier: 2, weight: 2, rows: [row("LLL"), row("HHH", 0.85)] },
  { name: "mixed bag", tier: 2, weight: 2, rows: [row("B.B"), row("HLH", 0.75)] },
  { name: "ramp run", tier: 2, weight: 2, rows: [row("J.B"), wall("BBB"), row("LLL", 1.0)] },
  { name: "convoy", tier: 2, weight: 1, rows: [row("TT.")] },
  { name: "long pier", tier: 2, weight: 2, rows: [row("PDD"), row("DDP", 0.9)] },
  { name: "banana and boat", tier: 2, weight: 2, banana: true, rows: [row("BB."), row(".BB", 0.8)] },
  // Tier 3: no rest.
  { name: "long slalom", tier: 3, weight: 3, rows: [row("BB."), row(".BB", 0.6), row("B.B", 0.6), row(".BB", 0.6)] },
  { name: "gauntlet", tier: 3, weight: 2, rows: [row("RLR"), row("HHH", 0.8), row("B.R", 0.8)] },
  { name: "traffic jam", tier: 3, weight: 1, rows: [row("T.T"), row(".B.", 0.9)] },
  { name: "wall and weave", tier: 3, weight: 2, rows: [row("JBB"), wall("BBB"), row("BB.", 1.0)] },
];

// Taught in order at the start of every run.
const INTRO = [
  { name: "intro: dodge", tier: 0, weight: 0, rows: [row(".B.")] },
  { name: "intro: jump", tier: 0, weight: 0, rows: [row("LLL")] },
  { name: "intro: duck", tier: 0, weight: 0, rows: [row("HHH")] },
  { name: "intro: ramp", tier: 0, weight: 0, rows: [row(".J.")] },
] satisfies Pattern[];

const GAP_SCALE = [1, 0.88, 0.78, 0.7];
const EXIT_GAP = [1.5, 1.2, 1.0, 0.85];
const MIN_GAP = 0.5;
/** After a hop or a duck there must be time to come back down and look again. */
const MIN_GAP_AFTER_ACTION = 0.85;
const RAMP_LANDING_MARGIN = 0.35;
/** Time a person needs to see the next row and start moving. */
const REACT = 0.3;

const ACTION = new Set(["L", "N", "H", "D", "P"]);
const BLOCKED = new Set(["B", "R", "T", "P"]);
const CELL_KIND: Partial<Record<Cell, ObstacleKind>> = {
  B: "boat",
  R: "rock",
  L: "log",
  N: "net",
  H: "rope",
  D: "deck",
  J: "ramp",
  T: "jetski",
};
const POWERS: [PowerKind, number][] = [
  ["magnet", 0.3],
  ["shield", 0.25],
  ["double", 0.25],
  ["nitro", 0.2],
];

/**
 * The least time between two rows for a person: whatever lane they used for the
 * first row, they must wait for its obstacles to slide past before moving over,
 * then cross to the nearest open lane of the next.
 */
export function crossingTime(prev: Cell[], next: Cell[], speed: number) {
  const open = (cells: Cell[]) => cells.flatMap((c, lane) => (BLOCKED.has(c) ? [] : [lane]));
  const from = open(prev);
  const to = open(next);
  if (from.length === 0 || to.length === 0) return 0; // a wall: flown over, not crossed
  const lanes = Math.max(...from.map((a) => Math.min(...to.map((b) => Math.abs(a - b)))));
  if (lanes === 0) return 0;
  const alongside = (rowLength({ z: 0, time: 0, cells: prev }) + PLAYER.front + PLAYER.back) / speed;
  return alongside + lanes * LANE_SWITCH_TIME + REACT;
}

/** How far a row's obstacles reach beyond its z. */
function rowLength(row: Row) {
  return Math.max(0, ...row.cells.map((c) => (c === "P" ? SPECS.pillar.length : CELL_KIND[c] ? SPECS[CELL_KIND[c]].length : 0)));
}

/** Seconds to travel from z1 to z2 at the normal speed curve. */
export function travelTime(z1: number, z2: number) {
  let t = 0;
  for (let z = z1; z < z2; z += 2) t += Math.min(2, z2 - z) / speedAt(z);
  return t;
}

export class Course {
  readonly rows: Row[] = [];
  private readonly rng: Rng;
  private nextZ: number;
  private lastCells: string = "...";
  /** When the player is back on the water after the latest ramp. */
  private landed = 0;
  private lastPowerZ = 0;
  private pathLane = 1;
  /** Where the last row's obstacles end: coin lines start after it. */
  private clearZ = 0;
  private readonly intro: Pattern[];

  constructor(seed: number, startZ = 70) {
    this.rng = createRng(seed);
    this.nextZ = startZ;
    this.intro = [...INTRO];
  }

  /** Generates everything up to `toZ` and returns what is new. */
  fill(toZ: number): Batch {
    const batch: Batch = { obstacles: [], coins: [], powers: [] };
    while (this.nextZ < toZ) this.place(this.intro.shift() ?? this.pick(tierAt(this.nextZ)), batch);
    return batch;
  }

  private pick(tier: number): Pattern {
    const options = PATTERNS.filter((p) => p.tier <= tier);
    // Newer patterns are favoured once unlocked, older ones stay in the mix.
    const weight = (p: Pattern) => p.weight * (p.tier === tier ? 1.6 : 1);
    let roll = this.rng() * options.reduce((sum, p) => sum + weight(p), 0);
    for (const p of options) {
      roll -= weight(p);
      if (roll <= 0) return p;
    }
    return options[options.length - 1];
  }

  private place(pattern: Pattern, batch: Batch) {
    const tier = tierAt(this.nextZ);
    const mirror = this.rng() < 0.5;
    const start = this.rows.at(-1);
    let z = this.nextZ;
    let time = start ? start.time + travelTime(start.z, z) : travelTime(0, z);

    // Leave room after the previous pattern, including the landing of a ramp jump.
    const firstCells = [...(mirror ? [...pattern.rows[0].cells].reverse().join("") : pattern.rows[0].cells)] as Cell[];
    const exit = Math.max(
      EXIT_GAP[tier],
      this.minAfter(this.lastCells),
      crossingTime([...this.lastCells] as Cell[], firstCells, speedAt(this.nextZ)),
    );
    if (start && time - start.time < exit) {
      z = start.z + exit * speedAt(start.z);
      time = start.time + travelTime(start.z, z);
    }
    if (time < this.landed) {
      z += (this.landed - time) * speedAt(z);
      time = this.landed;
    }

    let previous: Row | null = null;
    for (const [i, spec] of pattern.rows.entries()) {
      if (i > 0 && previous) {
        if (spec.overRamp) {
          z = previous.z + overRampOffset(speedAt(previous.z), "boat");
        } else {
          const cells = [...(mirror ? [...spec.cells].reverse().join("") : spec.cells)] as Cell[];
          const gap = Math.max(
            spec.gap * GAP_SCALE[tier],
            this.minAfter(this.lastCells),
            crossingTime(previous.cells, cells, speedAt(previous.z)),
          );
          z = previous.z + gap * speedAt(previous.z);
        }
        time = previous.time + travelTime(previous.z, z);
        if (!spec.overRamp && time < this.landed) {
          z += (this.landed - time) * speedAt(z);
          time = this.landed;
        }
      }
      const cells = [...(mirror ? [...spec.cells].reverse().join("") : spec.cells)] as Cell[];
      const current: Row = { z, time, cells };
      this.rows.push(current);
      this.spawnRow(current, pattern.banana === true && i === 0, mirror, batch);
      this.coinsFor(previous, current, batch);
      if (cells.includes("J")) this.landed = time + airtime(RAMP_VY) + RAMP_LANDING_MARGIN;
      this.lastCells = cells.join("");
      previous = current;
    }

    const last = this.rows[this.rows.length - 1];
    const following = last.z + Math.max(EXIT_GAP[tier], this.minAfter(this.lastCells)) * speedAt(last.z);
    this.maybePower(last.z, following, batch);
    this.nextZ = following;
  }

  private minAfter(cells: string) {
    return [...cells].some((c) => ACTION.has(c)) ? MIN_GAP_AFTER_ACTION : MIN_GAP;
  }

  private spawnRow(row: Row, banana: boolean, mirror: boolean, batch: Batch) {
    if (banana) {
      // A banana boat covers the two blocked lanes as the player arrives, drifting
      // towards the open lane: it is safe to stay there if you keep your speed.
      const dir = mirror ? -1 : 1;
      batch.obstacles.push({ kind: "banana", x: -2.2 * dir, z: row.z, vx: BANANA_SPEED * dir });
      return;
    }
    row.cells.forEach((cell, lane) => {
      const x = LANE_X[lane];
      if (cell === "P") {
        batch.obstacles.push({ kind: "pillar", x, z: row.z }, { kind: "deck", x, z: row.z });
        return;
      }
      const kind = CELL_KIND[cell];
      if (kind) batch.obstacles.push({ kind, x, z: row.z, ...(kind === "jetski" ? { vz: TRAFFIC_SPEED } : {}) });
    });
  }

  /** Coins trace a safe line: along the open lane, over hops, under flags, up a ramp's arc. */
  private coinsFor(previous: Row | null, row: Row, batch: Batch) {
    const clear = this.clearZ;
    this.clearZ = row.z + rowLength(row) + 2;
    const open = row.cells
      .map((cell, lane) => ({ cell, lane }))
      .filter(({ cell }) => !BLOCKED.has(cell));
    if (open.length === 0) return; // flown over off a ramp
    open.sort((a, b) => Math.abs(a.lane - this.pathLane) - Math.abs(b.lane - this.pathLane));
    const { cell, lane } = open[0];
    const moved = lane !== this.pathLane;
    this.pathLane = lane;

    const x = LANE_X[lane];
    const v = speedAt(row.z);
    if (this.rng() < 0.35) return;

    const from = Math.max(clear, previous && moved ? (previous.z + row.z) / 2 : row.z - 30);
    for (let z = from; z < row.z - 5; z += 3) batch.coins.push({ x, y: 0.9, z });

    if (cell === "L" || cell === "N") {
      // Along the arc of a hop timed for this obstacle.
      for (let i = 0; i < 5; i++) {
        const t = 0.12 + i * 0.1;
        batch.coins.push({ x, y: heightAt(JUMP_VY, t) + 0.8, z: row.z + (t - 0.32) * v });
      }
    } else if (cell === "J") {
      for (let i = 0; i < 8; i++) {
        const t = 0.12 + i * 0.11;
        batch.coins.push({ x, y: heightAt(RAMP_VY, t) + 0.8, z: row.z + 3 + t * v });
      }
    } else if (cell === "H" || cell === "D") {
      const length = cell === "D" ? 7 : 1;
      for (let dz = -2; dz <= length + 2; dz += 2.5) batch.coins.push({ x, y: 0.45, z: row.z + dz });
    }
  }

  private maybePower(from: number, to: number, batch: Batch) {
    if (from - this.lastPowerZ < between(this.rng, 380, 700)) return;
    this.lastPowerZ = from;
    let roll = this.rng();
    let kind: PowerKind = "magnet";
    for (const [k, w] of POWERS) {
      roll -= w;
      if (roll <= 0) {
        kind = k;
        break;
      }
    }
    batch.powers.push({ kind, x: LANE_X[Math.floor(this.rng() * 3)], z: (from + to) / 2 });
  }
}
