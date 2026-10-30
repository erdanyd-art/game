import { beatAt, judgeTap, type Judgement } from "./beat.ts";
import { START_X, type Level } from "./level.ts";
import { starsFor } from "./nights.ts";

/** Everything the simulation wants heard. The demo on the title screen passes silence. */
export interface Sfx {
  flash(judgement: Judgement, combo: number): void;
  recruit(count: number): void;
  eat(): void;
  croak(): void;
  screech(): void;
  scare(): void;
  win(): void;
  lose(): void;
}

export const silentSfx: Sfx = {
  flash() {},
  recruit() {},
  eat() {},
  croak() {},
  screech() {},
  scare() {},
  win() {},
  lose() {},
};

export type Steering =
  | { kind: "point"; x: number; y: number }
  | { kind: "direction"; x: number; y: number };

export type FlyState = "swarm" | "joining" | "wild" | "stray" | "home";

export type Fly = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Its place in the swarm, as a point in the unit disc. */
  sx: number;
  sy: number;
  /** Where a wild firefly hovers, or its spot in the tree once home. */
  hx: number;
  hy: number;
  /** Its own blink when not in sync: phase (0 to 1) and speed. */
  phase: number;
  rate: number;
  state: FlyState;
  t: number;
  /** Extra brightness from a flash, fading out. */
  glow: number;
  /** How far a wild firefly has been won over, 0 to 1. At 1 it joins. */
  trust: number;
};

export type Frog = {
  x: number;
  y: number;
  face: number;
  state: "idle" | "aim" | "lash" | "rest" | "stun";
  t: number;
  /** Length of the current aim, so its last stretch can lock on. */
  aimTotal: number;
  aimX: number;
  aimY: number;
  /** How far the tongue is out, 0 to 1. */
  reach: number;
  bitten: boolean;
};

export type Bat = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  state: "circle" | "windup" | "dive" | "flee";
  t: number;
  eaten: number;
  /** Whether this dive's losses have been shown. */
  reported: boolean;
};

export type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  kind: "spark" | "ember" | "z";
};

export type Popup = { text: string; x: number; y: number; t: number; tone: "great" | "good" | "bad" };
export type Ring = { x: number; y: number; radius: number; t: number };

export type Outcome = {
  kind: "home" | "dark" | "dawn";
  delivered: number;
  total: number;
  stars: number;
  bestCombo: number;
  perfect: number;
  good: number;
  miss: number;
  eaten: number;
};

export type HintId = "move" | "rhythm" | "call" | "grow" | "miss" | "frog" | "bat" | "tree";

type Options = {
  /** Seconds on the clock the player hears; beats are judged against it. */
  clock: () => number;
  sfx: Sfx;
  /** Title-screen mode: steers and flashes by itself, with no predators. */
  demo?: boolean;
  onHint?: (id: HintId) => void;
};

const TAU = Math.PI * 2;
const MAX_SPEED = 250;
const FROG_RANGE = 240;
const TONGUE_OUT = 0.1;
const TONGUE_BACK = 0.28;
const TREE_REACH = 280;
const COMBO_TIMEOUT_BEATS = 8;
export const RING_SECONDS = 0.5;
export const POPUP_SECONDS = 1.2;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function unitDisc(): [number, number] {
  const angle = Math.random() * TAU;
  const r = Math.sqrt(Math.random());
  return [Math.cos(angle) * r, Math.sin(angle) * r];
}

/** How far the swarm spreads around its leader: wider as it grows. */
export const swarmSpread = (count: number) => 14 + 7 * Math.sqrt(count);

export class Game {
  readonly level: Level;
  readonly demo: boolean;
  private readonly maxBite: number;
  private readonly clock: () => number;
  private readonly sfx: Sfx;
  private readonly onHint?: (id: HintId) => void;

  beatStart = 0;
  spb = 1;
  /** Seconds of play, not counting pauses. */
  time = 0;
  leader = { x: START_X, y: 0, vx: 0, vy: 0 };
  flies: Fly[] = [];
  frogs: Frog[] = [];
  bats: Bat[] = [];
  particles: Particle[] = [];
  popups: Popup[] = [];
  rings: Ring[] = [];
  swarmSize = 0;
  combo = 0;
  bestCombo = 0;
  /** 0 to 1. Rises with flashes on the beat; a synced swarm glows wider and blinks as one. */
  sync = 0.5;
  stats = { perfect: 0, good: 0, miss: 0, eaten: 0 };
  flashGlow = 0;
  flashRadius = 0;
  shake = 0;
  outcome: Outcome | null = null;
  /** True once the ending has played out and the result can be shown. */
  finished = false;
  demoDone = false;

  private endTimer = 0;
  private lastBeat = 0;
  private lastFlashBeat = Number.NEGATIVE_INFINITY;
  private beatsSinceFlash = 0;
  private batTimer = 3;
  private hinted = new Set<HintId>();

  constructor(level: Level, options: Options) {
    this.level = level;
    this.clock = options.clock;
    this.sfx = options.sfx;
    this.demo = options.demo ?? false;
    this.onHint = options.onHint;

    const night = level.night;
    this.maxBite = night.number === 1 ? 3 : 3 + Math.floor(night.number / 2);
    this.setBeat(this.clock() + 0.6, 60 / night.bpm);

    const L = this.leader;
    L.y = level.center(L.x);
    for (let i = 0; i < night.startSwarm; i++) {
      this.flies.push(this.makeFly(L.x + rand(-30, 30), L.y + rand(-30, 30), "swarm"));
    }
    for (const c of level.clusters) {
      for (let i = 0; i < c.count; i++) {
        this.flies.push(this.makeFly(c.x + rand(-40, 40), c.y + rand(-28, 28), "wild"));
      }
    }
    this.swarmSize = night.startSwarm;
    if (!this.demo) {
      this.frogs = level.frogs.map((spot) => ({
        ...spot,
        face: Math.random() * TAU,
        state: "idle",
        t: 0,
        aimTotal: 1,
        aimX: spot.x,
        aimY: spot.y,
        reach: 0,
        bitten: false,
      }));
    }
  }

  /** Lines the beat up with the music: beat 0 sounds at `start` on the clock. */
  setBeat(start: number, secondsPerBeat: number) {
    this.beatStart = start;
    this.spb = secondsPerBeat;
    this.lastBeat = beatAt(this.clock(), start, secondsPerBeat).beat;
  }

  /** 0 right on a beat, rising towards 1 just before the next. */
  beatPhase() {
    return beatAt(this.clock(), this.beatStart, this.spb).phase;
  }

  /**
   * Seconds until the second beat from now. Predators strike on it, so there is
   * always one whole beat in between to answer with a flash.
   */
  private untilStrike() {
    const now = this.clock();
    const { beat } = beatAt(now, this.beatStart, this.spb);
    return this.beatStart + (beat + 2) * this.spb - now;
  }

  get lightRadius() {
    return (70 + 15 * Math.sqrt(this.swarmSize)) * (0.6 + 0.4 * this.sync);
  }

  get dawn() {
    return clamp(this.time / this.level.night.dawnSeconds, 0, 1);
  }

  /** Share of the way from the start to the tree, 0 to 1. */
  get progress() {
    const goal = this.level.tree.x - TREE_REACH;
    return clamp((this.leader.x - START_X) / (goal - START_X), 0, 1);
  }

  update(dt: number, steering: Steering | null) {
    this.time += dt;
    this.trackBeats();
    this.sync = Math.max(0, this.sync - dt * 0.06);
    this.flashGlow = Math.max(0, this.flashGlow - dt * 2.4);
    this.shake = Math.max(0, this.shake - dt * 2.5);

    const tree = this.level.tree;
    const steer: Steering | null =
      this.outcome?.kind === "home"
        ? { kind: "point", x: tree.x, y: tree.y }
        : this.outcome
          ? null
          : this.demo
            ? this.autopilot()
            : steering;
    this.moveLeader(dt, steer);
    this.updateFlies(dt);
    this.updateFrogs(dt);
    this.updateBats(dt);
    this.updateEffects(dt);

    if (this.outcome) {
      this.endTimer -= dt;
      if (this.endTimer <= 0) this.finished = true;
    } else {
      this.checkProgress();
    }
  }

  /** A flash at `time` on the clock: judged against the beat. */
  flash(time: number) {
    if (this.outcome) return;
    const tap = judgeTap(time, this.beatStart, this.spb);
    // One flash per beat: mashing does not count twice.
    const judgement: Judgement = tap.beat === this.lastFlashBeat ? "miss" : tap.judgement;
    const L = this.leader;
    this.beatsSinceFlash = 0;

    if (judgement === "miss") {
      this.combo = 0;
      this.stats.miss++;
      this.sync = Math.max(0, this.sync - 0.2);
      this.scatter();
      this.popup("Meleset", "bad");
      this.sfx.flash("miss", 0);
      this.hint("miss");
      return;
    }

    this.lastFlashBeat = tap.beat;
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.stats[judgement]++;
    this.sync = Math.min(1, this.sync + (judgement === "perfect" ? 0.18 : 0.09));

    const perfect = judgement === "perfect";
    const radius = (90 + 8 * Math.sqrt(this.swarmSize) + Math.min(this.combo, 10) * 6) * (perfect ? 1 : 0.8);
    this.flashRadius = radius;
    this.flashGlow = 1;
    this.rings.push({ x: L.x, y: L.y, radius, t: 0 });
    if (perfect) {
      for (let i = 0; i < 14; i++) {
        const angle = (i / 14) * TAU + rand(-0.2, 0.2);
        const speed = rand(150, 260);
        this.particles.push({
          x: L.x,
          y: L.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0.5,
          max: 0.5,
          size: rand(6, 10),
          kind: "spark",
        });
      }
    }

    // Wild fireflies are won over flash by flash: closer and more precise counts
    // for more. Strays from your own swarm come straight back.
    let recruited = 0;
    for (const f of this.flies) {
      if (f.state === "swarm") f.glow = 1;
      if (f.state !== "wild" && f.state !== "stray") continue;
      const d = Math.hypot(f.x - L.x, f.y - L.y);
      if (d > radius) continue;
      f.glow = Math.max(f.glow, 0.6);
      f.trust = f.state === "stray" ? 1 : f.trust + (perfect ? 0.6 : 0.35) * (1 - (0.5 * d) / radius);
      if (f.trust < 1) continue;
      f.state = "joining";
      f.t = 0;
      f.glow = 1;
      [f.sx, f.sy] = unitDisc();
      recruited++;
    }

    // Only a flash right on the beat is bright enough to dazzle a predator.
    let scared = 0;
    if (perfect) {
      for (const frog of this.frogs) {
        if (frog.state === "stun") continue;
        if (Math.hypot(frog.x - L.x, frog.y - L.y) > radius + 20) continue;
        frog.state = "stun";
        frog.t = 3.5;
        frog.reach = 0;
        scared++;
      }
      for (const bat of this.bats) {
        if (bat.state === "flee") continue;
        const d = Math.hypot(bat.x - L.x, bat.y - L.y);
        if (d > radius + 60) continue;
        bat.state = "flee";
        bat.t = 1.4;
        bat.vx = ((bat.x - L.x) / (d || 1)) * 650;
        bat.vy = ((bat.y - L.y) / (d || 1)) * 650;
        scared++;
      }
    }

    this.sfx.flash(judgement, this.combo);
    this.popup(perfect ? "Pas!" : "Bagus", perfect ? "great" : "good");
    if (recruited) {
      this.sfx.recruit(recruited);
      this.popup(`+${recruited}`, "great", undefined, 26);
      this.hint("grow");
    }
    if (scared) this.sfx.scare();
  }

  private trackBeats() {
    const { beat } = beatAt(this.clock(), this.beatStart, this.spb);
    if (beat <= this.lastBeat) return;
    this.beatsSinceFlash += beat - this.lastBeat;
    this.lastBeat = beat;
    if (this.beatsSinceFlash > COMBO_TIMEOUT_BEATS) this.combo = 0;
    if (this.demo && beat >= 0) this.flash(this.beatStart + beat * this.spb);
  }

  private autopilot(): Steering {
    const x = this.leader.x + 70;
    const y = this.level.center(x) + Math.sin(this.time * 0.3) * this.level.half(x) * 0.45;
    return { kind: "point", x, y };
  }

  private moveLeader(dt: number, steer: Steering | null) {
    const L = this.leader;
    let vx = 0;
    let vy = 0;
    if (steer?.kind === "point") {
      const dx = steer.x - L.x;
      const dy = steer.y - L.y;
      const d = Math.hypot(dx, dy);
      if (d > 6) {
        const speed = Math.min(MAX_SPEED, d * 2.4);
        vx = (dx / d) * speed;
        vy = (dy / d) * speed;
      }
    } else if (steer?.kind === "direction") {
      vx = steer.x * MAX_SPEED;
      vy = steer.y * MAX_SPEED;
    }
    const k = Math.min(1, dt * 5);
    L.vx += (vx - L.vx) * k;
    L.vy += (vy - L.vy) * k;
    L.x = clamp(L.x + L.vx * dt, 60, this.level.end + 260);
    L.y += L.vy * dt;

    // The banks are soft walls.
    const c = this.level.center(L.x);
    const h = Math.max(60, this.level.half(L.x) - 50);
    if (L.y < c - h) {
      L.y = c - h;
      L.vy = Math.max(0, L.vy);
    } else if (L.y > c + h) {
      L.y = c + h;
      L.vy = Math.min(0, L.vy);
    }
  }

  private updateFlies(dt: number) {
    const L = this.leader;
    const spread = swarmSpread(this.swarmSize);
    const turn = this.time * 0.35;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    let size = 0;

    for (const f of this.flies) {
      let tx = f.x;
      let ty = f.y;
      let k = 0;
      let damp = 1.5;
      // Swarm members follow the leader's own velocity, so they keep up instead of trailing.
      let followVx = 0;
      let followVy = 0;

      switch (f.state) {
        case "swarm":
        case "joining": {
          const sx = f.sx * cos - f.sy * sin;
          const sy = f.sx * sin + f.sy * cos;
          tx = L.x + sx * spread + Math.sin(this.time * 1.7 + f.phase * 40) * 5;
          ty = L.y + sy * spread + Math.cos(this.time * 1.3 + f.phase * 30) * 5;
          followVx = L.vx;
          followVy = L.vy;
          if (f.state === "joining") {
            k = 9;
            damp = 4;
            f.t += dt;
            const near = Math.hypot(tx - f.x, ty - f.y) < spread * 0.6;
            if ((near && f.t > 0.4) || f.t > 1.6) f.state = "swarm";
          } else {
            k = 16;
            damp = 6;
          }
          size++;
          break;
        }
        case "wild":
          f.trust = Math.max(0, f.trust - dt * 0.04);
          tx = f.hx + Math.sin(this.time * 0.9 * f.rate + f.phase * TAU) * 20;
          ty = f.hy + Math.cos(this.time * 0.7 * f.rate + f.phase * 9) * 14;
          k = 4;
          damp = 2.5;
          break;
        case "stray":
          // Drifts on its scatter momentum, then settles where it ended up.
          f.t -= dt;
          if (f.t <= 0) {
            f.state = "wild";
            f.hx = f.x;
            f.hy = f.y;
          }
          break;
        case "home":
          tx = f.hx + Math.sin(this.time * 0.8 + f.phase * TAU) * 6;
          ty = f.hy + Math.cos(this.time * 0.6 + f.phase * 9) * 6;
          k = 5;
          damp = 3;
          break;
      }

      f.vx += ((tx - f.x) * k + (followVx - f.vx) * damp) * dt;
      f.vy += ((ty - f.y) * k + (followVy - f.vy) * damp) * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.glow = Math.max(0, f.glow - dt * 1.5);
    }
    this.swarmSize = size;
  }

  private updateFrogs(dt: number) {
    const L = this.leader;
    for (const frog of this.frogs) {
      const dx = L.x - frog.x;
      const dy = L.y - frog.y;
      const d = Math.hypot(dx, dy);
      if (frog.state !== "stun") frog.face += wrapAngle(Math.atan2(dy, dx) - frog.face) * Math.min(1, dt * 4);
      if (d < 420) this.hint("frog");

      switch (frog.state) {
        case "idle":
          if (!this.outcome && d < FROG_RANGE && this.swarmSize > 0) {
            frog.state = "aim";
            frog.t = frog.aimTotal = this.untilStrike();
            frog.aimX = L.x;
            frog.aimY = L.y;
            this.sfx.croak();
          }
          break;
        case "aim":
          frog.t -= dt;
          // Tracks the swarm at first, then locks on: moving away in time dodges the tongue.
          if (frog.t > frog.aimTotal * 0.4) {
            const k = Math.min(1, dt * 10);
            frog.aimX += (L.x - frog.aimX) * k;
            frog.aimY += (L.y - frog.aimY) * k;
          }
          if (frog.t <= 0) {
            const ax = frog.aimX - frog.x;
            const ay = frog.aimY - frog.y;
            const reach = Math.hypot(ax, ay);
            if (reach > FROG_RANGE) {
              frog.aimX = frog.x + (ax / reach) * FROG_RANGE;
              frog.aimY = frog.y + (ay / reach) * FROG_RANGE;
            }
            frog.state = "lash";
            frog.t = 0;
            frog.bitten = false;
          }
          break;
        case "lash":
          frog.t += dt;
          frog.reach =
            frog.t < TONGUE_OUT ? frog.t / TONGUE_OUT : Math.max(0, 1 - (frog.t - TONGUE_OUT) / TONGUE_BACK);
          if (!frog.bitten && frog.t >= TONGUE_OUT) {
            frog.bitten = true;
            const eaten = this.bite(frog.aimX, frog.aimY, 38, this.maxBite);
            if (eaten) this.popup(`-${eaten}`, "bad", { x: frog.aimX, y: frog.aimY });
          }
          if (frog.t >= TONGUE_OUT + TONGUE_BACK) {
            frog.state = "rest";
            frog.t = 1.6;
            frog.reach = 0;
          }
          break;
        case "rest":
          frog.t -= dt;
          if (frog.t <= 0) frog.state = "idle";
          break;
        case "stun":
          frog.t -= dt;
          if (Math.random() < dt * 1.6) {
            this.particles.push({
              x: frog.x + 6,
              y: frog.y - 14,
              vx: rand(4, 14),
              vy: -20,
              life: 1.4,
              max: 1.4,
              size: rand(10, 14),
              kind: "z",
            });
          }
          if (frog.t <= 0) {
            frog.state = "rest";
            frog.t = 0.5;
          }
          break;
      }
    }
  }

  private updateBats(dt: number) {
    const L = this.leader;
    const night = this.level.night;
    if (!this.demo && !this.outcome && night.bats > 0 && L.x > 900) {
      this.batTimer -= dt;
      if (this.batTimer <= 0 && this.bats.length < night.bats) {
        const angle = Math.random() * TAU;
        this.bats.push({
          x: L.x + Math.cos(angle) * 650,
          y: L.y + Math.sin(angle) * 500,
          vx: 0,
          vy: 0,
          angle,
          state: "circle",
          t: rand(2, 3.5),
          eaten: 0,
          reported: false,
        });
        this.batTimer = rand(4, 7);
        this.hint("bat");
      }
    }

    for (let i = this.bats.length - 1; i >= 0; i--) {
      const bat = this.bats[i];
      switch (bat.state) {
        case "circle": {
          bat.angle += dt * 0.8;
          const tx = L.x + Math.cos(bat.angle) * 400;
          const ty = L.y + Math.sin(bat.angle) * 300;
          bat.vx += ((tx - bat.x) * 3 - bat.vx * 2.2) * dt;
          bat.vy += ((ty - bat.y) * 3 - bat.vy * 2.2) * dt;
          bat.t -= dt;
          if (bat.t <= 0 && !this.outcome && this.swarmSize > 0) {
            bat.state = "windup";
            bat.t = this.untilStrike();
            this.sfx.screech();
          }
          break;
        }
        case "windup": {
          const k = Math.min(1, dt * 4);
          bat.vx -= bat.vx * k;
          bat.vy -= bat.vy * k;
          bat.t -= dt;
          if (bat.t <= 0) {
            const dx = L.x + L.vx * 0.35 - bat.x;
            const dy = L.y + L.vy * 0.35 - bat.y;
            const d = Math.hypot(dx, dy) || 1;
            bat.vx = (dx / d) * 560;
            bat.vy = (dy / d) * 560;
            bat.state = "dive";
            bat.t = 1.4;
            bat.eaten = 0;
            bat.reported = false;
          }
          break;
        }
        case "dive":
          bat.t -= dt;
          if (bat.eaten < 5) bat.eaten += this.bite(bat.x, bat.y, 30, 5 - bat.eaten);
          // Report the loss as the bat leaves the swarm, where it happened.
          if (bat.eaten && !bat.reported && Math.hypot(bat.x - L.x, bat.y - L.y) > swarmSpread(this.swarmSize) + 40) {
            bat.reported = true;
            this.popup(`-${bat.eaten}`, "bad", bat);
          }
          if (bat.t <= 0) {
            bat.state = "circle";
            bat.t = rand(3, 5.5);
            bat.angle = Math.atan2(bat.y - L.y, bat.x - L.x);
          }
          break;
        case "flee":
          bat.t -= dt;
          if (bat.t <= 0) {
            this.bats.splice(i, 1);
            continue;
          }
          break;
      }
      bat.x += bat.vx * dt;
      bat.y += bat.vy * dt;
    }
  }

  private updateEffects(dt: number) {
    const drag = 1 - Math.min(1, dt * 2.2);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind !== "z") {
        p.vx *= drag;
        p.vy *= drag;
      }
    }
    for (const p of this.popups) p.t += dt;
    this.popups = this.popups.filter((p) => p.t < POPUP_SECONDS);
    for (const r of this.rings) r.t += dt;
    this.rings = this.rings.filter((r) => r.t < RING_SECONDS);
  }

  private checkProgress() {
    const L = this.leader;
    const tree = this.level.tree;
    if (this.demo) {
      if (L.x > this.level.end - 600) this.demoDone = true;
      return;
    }
    if (this.time > 0.8) this.hint("move");
    if (this.time > 5) this.hint("rhythm");
    if (L.x > this.level.end - 1100) this.hint("tree");
    if (!this.hinted.has("call")) {
      for (const f of this.flies) {
        if (f.state === "wild" && Math.hypot(f.x - L.x, f.y - L.y) < 340) {
          this.hint("call");
          break;
        }
      }
    }

    if (Math.hypot(L.x - tree.x, L.y - tree.y) < TREE_REACH) this.arrive();
    else if (this.time >= this.level.night.dawnSeconds) this.lose("dawn");
    else if (this.swarmSize === 0) this.lose("dark");
  }

  private arrive() {
    const tree = this.level.tree;
    let delivered = 0;
    for (const f of this.flies) {
      if (f.state !== "swarm" && f.state !== "joining") continue;
      const [sx, sy] = unitDisc();
      f.state = "home";
      f.hx = tree.x + sx * 170;
      f.hy = tree.y + sy * 140;
      delivered++;
    }
    this.swarmSize = 0;
    this.outcome = this.makeOutcome("home", delivered);
    this.endTimer = 3.4;
    this.sfx.win();
  }

  private lose(kind: "dark" | "dawn") {
    this.outcome = this.makeOutcome(kind, 0);
    this.endTimer = 1.8;
    this.sfx.lose();
  }

  private makeOutcome(kind: Outcome["kind"], delivered: number): Outcome {
    return {
      kind,
      delivered,
      total: this.level.total,
      stars: kind === "home" ? starsFor(delivered, this.level.total) : 0,
      bestCombo: this.bestCombo,
      ...this.stats,
    };
  }

  /** Eats up to `max` swarm fireflies within `radius` of a point. */
  private bite(x: number, y: number, radius: number, max: number): number {
    let eaten = 0;
    const r2 = radius * radius;
    for (let i = this.flies.length - 1; i >= 0 && eaten < max; i--) {
      const f = this.flies[i];
      if (f.state !== "swarm" && f.state !== "joining") continue;
      if ((f.x - x) ** 2 + (f.y - y) ** 2 > r2) continue;
      this.flies.splice(i, 1);
      eaten++;
      for (let k = 0; k < 5; k++) {
        this.particles.push({
          x: f.x,
          y: f.y,
          vx: rand(-70, 70),
          vy: rand(-70, 70),
          life: 0.6,
          max: 0.6,
          size: rand(5, 9),
          kind: "ember",
        });
      }
    }
    if (eaten) {
      this.swarmSize -= eaten;
      this.stats.eaten += eaten;
      this.shake = Math.min(1, this.shake + 0.35 + eaten * 0.08);
      this.sfx.eat();
    }
    return eaten;
  }

  /** A flash off the beat startles a few fireflies away from the swarm. */
  private scatter() {
    const swarm = this.flies.filter((f) => f.state === "swarm");
    if (swarm.length < 8) return;
    const count = Math.max(1, Math.floor(swarm.length * 0.06));
    for (let i = 0; i < count; i++) {
      const f = swarm.splice(Math.floor(Math.random() * swarm.length), 1)[0];
      const angle = Math.random() * TAU;
      const speed = rand(110, 170);
      f.state = "stray";
      f.t = 1.6;
      f.vx = this.leader.vx + Math.cos(angle) * speed;
      f.vy = this.leader.vy + Math.sin(angle) * speed;
    }
  }

  /** Floating text above the swarm, or just above a given point. */
  private popup(text: string, tone: Popup["tone"], at?: { x: number; y: number }, lift = 0) {
    const x = at ? at.x : this.leader.x;
    const y = at ? at.y - 20 : this.leader.y - swarmSpread(this.swarmSize) - 24 - lift;
    this.popups.push({ text, x, y, t: 0, tone });
  }

  private hint(id: HintId) {
    if (this.demo || this.hinted.has(id)) return;
    this.hinted.add(id);
    this.onHint?.(id);
  }

  private makeFly(x: number, y: number, state: FlyState): Fly {
    const [sx, sy] = unitDisc();
    return {
      x,
      y,
      vx: 0,
      vy: 0,
      sx,
      sy,
      hx: x,
      hy: y,
      phase: Math.random(),
      rate: rand(0.6, 1.4),
      state,
      t: 0,
      glow: 0,
      trust: 0,
    };
  }
}
