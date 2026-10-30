import {
  DUCK_TIME,
  GRAVITY,
  JUMP_VY,
  LANE_SWITCH_TIME,
  LANE_WIDTH,
  LANE_X,
  NITRO_BOOST,
  NITRO_TIME,
  PLAYER,
  RAMP_VY,
  SLAM_VY,
  SPECS,
  SPIN_TIME,
  START_SPEED,
  speedAt,
  timeToLand,
  type ObstacleKind,
} from "./config.ts";
import { Course, type PowerKind } from "./course.ts";

export interface Sfx {
  coin(streak: number): void;
  jump(): void;
  ramp(): void;
  land(hard: boolean): void;
  duck(): void;
  lane(): void;
  spin(): void;
  trick(spins: number): void;
  near(): void;
  combo(level: number): void;
  bump(): void;
  crash(): void;
  smash(): void;
  power(kind: PowerKind): void;
  nitro(): void;
  shield(): void;
  horn(): void;
  /** The police siren: on when a chase starts, off when it ends. */
  siren(on: boolean): void;
}

const quiet = () => {};
export const silentSfx: Sfx = {
  coin: quiet,
  jump: quiet,
  ramp: quiet,
  land: quiet,
  duck: quiet,
  lane: quiet,
  spin: quiet,
  trick: quiet,
  near: quiet,
  combo: quiet,
  bump: quiet,
  crash: quiet,
  smash: quiet,
  power: quiet,
  nitro: quiet,
  shield: quiet,
  horn: quiet,
  siren: quiet,
};

export type Action = "left" | "right" | "up" | "down" | "nitro" | "tap";

export type Obstacle = {
  id: number;
  kind: ObstacleKind;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Moving obstacles wait off-stage until it is time to head for their meeting point. */
  waiting: boolean;
  meetX: number;
  meetZ: number;
  passed: boolean;
  /** Seconds since nitro smashed it, or -1. */
  smashed: number;
};
export type Coin = { x: number; y: number; z: number; taken: boolean; pulled: boolean };
export type Power = { kind: PowerKind; x: number; z: number; taken: boolean };
export type Particle = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  kind: "foam" | "spray" | "splash" | "debris" | "spark";
};
export type Popup = { text: string; t: number; tone: "good" | "great" | "bad" | "gold" };
export type HintId = "lane" | "jump" | "duck" | "ramp" | "trick" | "nitro" | "banana" | "traffic" | "police";
export type Outcome = {
  score: number;
  distance: number;
  coins: number;
  bestCombo: number;
  tricks: number;
  nearMisses: number;
  escapes: number;
  smashes: number;
  powers: number;
};

const HINT_FOR: Partial<Record<ObstacleKind, HintId>> = {
  boat: "lane",
  rock: "lane",
  log: "jump",
  net: "jump",
  rope: "duck",
  deck: "duck",
  ramp: "ramp",
  banana: "banana",
  jetski: "traffic",
};
/** Obstacles you can only pass beside: passing them close after a lane change is a near miss. */
const BESIDE = new Set<ObstacleKind>(["boat", "rock", "jetski", "banana", "pillar"]);
const STEP = 1 / 120;

// The water police. A chase starts when heat (from reckless riding) boils over, or
// when a patrol spots you on a long run. They close in slowly and surge on every
// bump; nitro or a clean ride until they give up gets you away.
export const CHASE = {
  startGap: 50,
  caughtGap: 5,
  escapeGap: 85,
  bumpSurge: 20,
  /** They gain on you at first, then fall back once they tire. */
  pursuit: 1.05,
  tired: 0.82,
  giveUpAfter: 28,
  escapeBonus: 500,
};
const MAX_PARTICLES = 500;
export const POPUP_SECONDS = 1.1;
export const COMBO_STEP = 12;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

type Options = { sfx: Sfx; seed?: number; onHint?: (id: HintId) => void };

export class Game {
  readonly course: Course;
  readonly player = {
    lane: 1,
    fromLane: 1,
    x: 0,
    y: 0,
    vy: 0,
    z: 0,
    speed: START_SPEED,
    air: "none" as "none" | "jump" | "ramp",
    duck: 0,
    slam: false,
    spin: 0,
    spinning: false,
    queued: 0,
    spins: 0,
    shield: 0,
    magnet: 0,
    double: 0,
    nitro: 0,
    boost: 0,
    invulnerable: 0,
    slowed: 0,
    lastSwitch: -10,
    /** Where the current lane change started, and how far into it we are. */
    switchFrom: 0,
    switchT: 1,
    jumpBuffer: 0,
    /** Near edge of the ramp the current ramp jump took off from. */
    rampZ: 0,
    /** Lean into turns, in radians: for drawing. */
    bank: 0,
    tumble: 0,
  };
  obstacles: Obstacle[] = [];
  coins: Coin[] = [];
  powers: Power[] = [];
  particles: Particle[] = [];
  popups: Popup[] = [];
  score = 0;
  coinsRun = 0;
  combo = 0;
  bestCombo = 0;
  tricks = 0;
  nearMisses = 0;
  escapes = 0;
  smashes = 0;
  powersTaken = 0;
  /** 0 to 1: reckless riding draws the police. */
  heat = 0;
  readonly police = { active: false, gap: 0, time: 0, x: 0 };
  /** Seconds of simulated time. */
  time = 0;
  state: "run" | "crash" | "over" = "run";
  /** What ended the run, for the result screen. */
  cause = "";
  shake = 0;

  private readonly sfx: Sfx;
  private readonly onHint?: (id: HintId) => void;
  private hinted = new Set<HintId>();
  private nextId = 0;
  private crashTime = 0;
  private coinStreak = 0;
  private lastCoin = -10;
  private wakeTimer = 0;
  private nitroReady = false;
  private nextPatrol = 1100 + Math.random() * 500;

  constructor(options: Options) {
    this.sfx = options.sfx;
    this.onHint = options.onHint;
    this.course = new Course(options.seed ?? Math.floor(Math.random() * 1e9));
    this.spawn();
  }

  get multiplier() {
    return 1 + Math.min(4, Math.floor(this.combo / COMBO_STEP)) * 0.5;
  }

  get outcome(): Outcome {
    return {
      score: Math.round(this.score),
      distance: Math.round(this.player.z),
      coins: this.coinsRun,
      bestCombo: this.bestCombo,
      tricks: this.tricks,
      nearMisses: this.nearMisses,
      escapes: this.escapes,
      smashes: this.smashes,
      powers: this.powersTaken,
    };
  }

  /** Advances by `dt` real seconds; a crash plays out in slow motion. */
  update(dt: number) {
    const sim = this.state === "crash" ? dt * 0.4 : dt;
    const steps = Math.max(1, Math.ceil(sim / STEP));
    for (let i = 0; i < steps; i++) this.step(sim / steps);
    this.updateEffects(sim);
    this.shake = Math.max(0, this.shake - dt * 2.5);
    if (this.state === "crash") {
      this.crashTime += dt;
      if (this.crashTime > 1.6) this.state = "over";
    }
  }

  act(action: Action) {
    if (this.state !== "run") return;
    const p = this.player;
    switch (action) {
      case "left":
      case "right": {
        const lane = p.lane + (action === "left" ? -1 : 1);
        if (lane < 0 || lane > 2) return;
        p.fromLane = p.lane;
        p.lane = lane;
        p.lastSwitch = this.time;
        p.switchFrom = p.x;
        p.switchT = 0;
        this.sfx.lane();
        if (p.air === "none") this.burst(p.x, 0.3, p.z, 6, "spray", action === "left" ? 3 : -3);
        break;
      }
      case "up":
        if (p.air === "none") this.jump();
        else if (p.air === "ramp") this.trick();
        else p.jumpBuffer = 0.15; // pressed just before landing: hop again on touchdown
        break;
      case "tap":
        if (p.air === "ramp") this.trick();
        break;
      case "down":
        if (p.air !== "none") {
          if (p.spinning) break; // dropping mid-flip would only end in a crash
          // Over something (the wall a ramp clears): duck on landing instead of dropping onto it.
          if (!this.underneath()) p.vy = Math.min(p.vy, SLAM_VY);
          p.slam = true;
        } else {
          p.duck = DUCK_TIME;
          this.sfx.duck();
        }
        break;
      case "nitro":
        if (p.nitro >= 1 && p.boost <= 0) {
          p.boost = NITRO_TIME;
          p.nitro = 0;
          this.nitroReady = false;
          this.popup("NITRO!", "gold");
          this.sfx.nitro();
        }
        break;
    }
  }

  private step(h: number) {
    const p = this.player;
    this.time += h;
    p.duck = Math.max(0, p.duck - h);
    p.shield = Math.max(0, p.shield - h);
    p.magnet = Math.max(0, p.magnet - h);
    p.double = Math.max(0, p.double - h);
    const boosting = p.boost > 0;
    p.boost = Math.max(0, p.boost - h);
    // Nitro ends with a moment of grace: you are still fast, and the course was spaced for normal speed.
    if (boosting && p.boost === 0) p.invulnerable = Math.max(p.invulnerable, 1);
    p.invulnerable = Math.max(0, p.invulnerable - h);
    p.jumpBuffer = Math.max(0, p.jumpBuffer - h);
    p.slowed = Math.max(0, p.slowed - h / 1.2);

    if (this.state === "run") {
      const target = speedAt(p.z) * (p.boost > 0 ? NITRO_BOOST : 1) * (1 - 0.3 * p.slowed);
      p.speed += (target - p.speed) * Math.min(1, h * (p.speed > target ? 6 : 3));
    } else {
      p.speed *= 1 - Math.min(1, h * 1.2);
      p.tumble += h * 9;
    }

    const z0 = p.z;
    const x0 = p.x;
    p.z += p.speed * h;
    // Lane changes ease in and out (a carve, not a slide), in the same time as before.
    const tx = LANE_X[p.lane];
    if (p.x !== tx) {
      p.switchT += h;
      const duration = (LANE_SWITCH_TIME * Math.abs(tx - p.switchFrom)) / LANE_WIDTH;
      const k = Math.min(1, p.switchT / Math.max(duration, 1e-3));
      p.x = p.switchFrom + (tx - p.switchFrom) * k * k * (3 - 2 * k);
    }
    p.bank += ((p.x - x0) / h / 17 - p.bank) * Math.min(1, h * 14);

    if (p.air !== "none") {
      p.vy -= GRAVITY * h;
      p.y += p.vy * h;
      if (p.y <= 0) this.land();
    }
    if (p.spinning) {
      p.spin += h / SPIN_TIME;
      if (p.spin >= 1) {
        p.spins++;
        p.spin = 0;
        if (p.queued > 0) p.queued--;
        else p.spinning = false;
      }
    }

    this.spawn();
    this.moveObstacles(h);
    this.launch(z0);
    this.collide(z0, x0, h);
    this.collect(z0, h);
    this.passBy();
    this.emit(h);
    this.chase(h);
    if (this.state === "run") this.score += (p.z - z0) * this.multiplier * (p.double > 0 ? 2 : 1);
  }

  private chase(h: number) {
    const p = this.player;
    const cop = this.police;
    if (this.state !== "run") return;
    if (!cop.active) {
      if (p.z > this.nextPatrol) this.heat = 1; // a patrol spots you
      if (this.heat < 1 || p.z <= 300) {
        this.heat = Math.max(0, this.heat - h * 0.015);
      } else {
        cop.active = true;
        cop.gap = CHASE.startGap;
        cop.time = 0;
        cop.x = p.x;
        this.heat = 0;
        this.popup("Polairud mengejar!", "bad");
        this.sfx.siren(true);
        this.hint("police");
      }
      return;
    }
    cop.time += h;
    cop.x += (p.x - cop.x) * Math.min(1, h * 1.5);
    const pace = cop.time < CHASE.giveUpAfter ? CHASE.pursuit : CHASE.tired;
    cop.gap += (p.speed - speedAt(p.z) * pace) * h;
    if (cop.gap >= CHASE.escapeGap) {
      cop.active = false;
      this.escapes++;
      this.nextPatrol = p.z + 1300 + Math.random() * 700;
      this.popup(`Lolos dari Polairud! +${this.bonus(CHASE.escapeBonus)}`, "gold");
      this.sfx.siren(false);
      this.sfx.power("shield");
    } else if (cop.gap <= CHASE.caughtGap) {
      if (p.shield > 0) {
        p.shield = 0;
        cop.gap = 30;
        this.popup("Pelampung menyelamatkanmu!", "good");
        this.sfx.shield();
      } else {
        this.hit(null, "Ditangkap Polairud!");
        this.sfx.siren(false);
      }
    }
  }

  /** Reckless riding warms things up; not while already being chased. */
  private warm(amount: number) {
    if (!this.police.active) this.heat = Math.min(1, this.heat + amount);
  }

  private jump() {
    const p = this.player;
    p.air = "jump";
    p.vy = JUMP_VY;
    p.duck = 0;
    this.sfx.jump();
  }

  /** A backflip, but only one that can be finished before touching down: mashing never crashes. */
  private trick() {
    const p = this.player;
    const left = timeToLand(p.y, p.vy);
    if (!p.spinning) {
      if (left < SPIN_TIME + 0.05) return;
      p.spinning = true;
      p.spin = 0;
      this.sfx.spin();
    } else if ((1 - p.spin + p.queued + 1) * SPIN_TIME + 0.05 <= left) {
      p.queued++;
    }
  }

  private land() {
    const p = this.player;
    const hard = p.vy < -12;
    p.y = 0;
    p.vy = 0;
    p.air = "none";
    this.burst(p.x, 0.1, p.z - 0.5, hard ? 18 : 10, "splash");
    this.shake = Math.min(1, this.shake + (hard ? 0.35 : 0.15));
    this.sfx.land(hard);
    if (this.state !== "run") return;

    // Mid-flip on touchdown is a wipeout; nearly round is forgiven.
    if (p.spinning && p.spin < 0.8) {
      p.spinning = false;
      p.spin = 0;
      p.queued = 0;
      p.spins = 0;
      this.hit(null, "Mendarat miring!");
      if (this.state !== "run") return;
    } else if (p.spinning) {
      p.spins++;
      p.spinning = false;
      p.spin = 0;
      p.queued = 0;
    }
    if (p.spins > 0) {
      const spins = p.spins;
      p.spins = 0;
      const points = this.bonus(150 * spins * (spins + 1));
      this.tricks += spins;
      this.addCombo(3 * spins);
      this.charge(0.3 * spins);
      this.popup(spins === 1 ? `Salto! +${points}` : `Salto ×${spins}! +${points}`, "great");
      this.sfx.trick(spins);
    }
    if (p.slam) {
      p.slam = false;
      p.duck = DUCK_TIME;
    }
    if (p.jumpBuffer > 0) {
      p.jumpBuffer = 0;
      this.jump();
    }
  }

  private spawn() {
    const p = this.player;
    const batch = this.course.fill(p.z + 240);
    for (const o of batch.obstacles) {
      const moving = o.vx !== undefined || o.vz !== undefined;
      this.obstacles.push({
        id: this.nextId++,
        kind: o.kind,
        x: o.x,
        z: o.z,
        vx: o.vx ?? 0,
        vz: o.vz ?? 0,
        waiting: moving,
        meetX: o.x,
        meetZ: o.z,
        passed: false,
        smashed: -1,
      });
    }
    for (const c of batch.coins) this.coins.push({ ...c, taken: false, pulled: false });
    for (const pw of batch.powers) this.powers.push({ ...pw, taken: false });

    for (const o of this.obstacles) {
      if (!o.waiting) continue;
      // Head off so as to arrive exactly when the player does.
      const eta = (o.meetZ - p.z) / Math.max(p.speed, 1);
      const lead = o.kind === "banana" ? 2.2 : 8;
      if (eta > lead) continue;
      o.waiting = false;
      o.z = o.meetZ - o.vz * eta;
      o.x = o.meetX - o.vx * eta;
      if (o.kind === "banana") this.sfx.horn();
    }

    for (const o of this.obstacles) {
      const id = HINT_FOR[o.kind];
      if (!id || o.waiting || this.hinted.has(id)) continue;
      if (o.z - p.z < 75 && o.z > p.z) this.hint(id);
    }

    if (this.obstacles.length > 80 || this.coins.length > 200) {
      this.obstacles = this.obstacles.filter((o) => o.waiting || o.z + SPECS[o.kind].length > p.z - 15);
      this.coins = this.coins.filter((c) => !c.taken && c.z > p.z - 8);
      this.powers = this.powers.filter((pw) => !pw.taken && pw.z > p.z - 8);
    }
  }

  private moveObstacles(h: number) {
    const p = this.player;
    for (const o of this.obstacles) {
      if (o.waiting) continue;
      if (o.smashed >= 0) o.smashed += h;
      const moving = o.vx !== 0 || o.vz !== 0;
      const eta = (o.meetZ - (p.z + PLAYER.front)) / Math.max(1, p.speed);
      if (moving && eta > 0 && o.smashed < 0) {
        // Stay on schedule for the meeting point whatever the player's speed does
        // (nitro, a bump): a crossing that was safe to wait out must stay safe.
        // At steady speed this is exactly the obstacle's own motion.
        const most = (Math.abs(o.vx) + Math.abs(o.vz)) * 2.5 * h;
        o.x += Math.max(-most, Math.min(most, o.meetX - o.vx * eta - o.x));
        o.z += Math.max(-most, Math.min(most, o.meetZ - o.vz * eta - o.z));
        continue;
      }
      o.x += o.vx * h;
      o.z += o.vz * h;
    }
  }

  private launch(z0: number) {
    const p = this.player;
    // A low hop over a ramp still catches it: pressing jump just before one is the natural thing to do.
    if (p.air === "ramp" || p.y > 1.4 || this.state !== "run") return;
    for (const o of this.obstacles) {
      if (o.kind !== "ramp" || o.waiting) continue;
      // Any of the hull over it, from the nose touching it until the tail leaves it.
      if (p.z + PLAYER.front < o.z || z0 - PLAYER.back > o.z + SPECS.ramp.length) continue;
      // Some of the hull over it, or already swerving onto it from the next lane:
      // a late swerve is still a swerve, and the lane change finishes in the air.
      const dx = Math.abs(p.x - o.x);
      const onto = LANE_X[p.lane] === o.x && dx <= LANE_WIDTH + 0.01;
      if (dx < SPECS.ramp.halfWidth + PLAYER.halfWidth || onto) {
        p.air = "ramp";
        p.rampZ = o.z;
        p.vy = RAMP_VY;
        p.duck = 0;
        p.jumpBuffer = 0;
        // A ramp always launches at full speed, so the arc clears what it was built to clear.
        p.slowed = 0;
        p.speed = Math.max(p.speed, speedAt(p.z));
        this.bonus(50);
        this.charge(0.1);
        this.sfx.ramp();
        this.hint("trick");
        this.burst(p.x, 0.2, p.z, 14, "splash");
        return;
      }
    }
  }

  private collide(z0: number, x0: number, h: number) {
    if (this.state !== "run") return;
    const p = this.player;
    // Stay low for as long as something is overhead: a pier is longer than one duck.
    if (p.duck > 0) {
      for (const o of this.obstacles) {
        if ((o.kind !== "deck" && o.kind !== "rope") || o.smashed >= 0) continue;
        const s = SPECS[o.kind];
        const under = p.z + PLAYER.front >= o.z && p.z - PLAYER.back <= o.z + s.length + 0.5;
        if (under && Math.abs(p.x - o.x) < s.halfWidth + PLAYER.halfWidth) p.duck = Math.max(p.duck, 0.12);
      }
    }
    const top = p.y + (p.duck > 0 && p.air === "none" ? PLAYER.duckHeight : PLAYER.height);
    for (const o of this.obstacles) {
      if (o.waiting || o.smashed >= 0) continue;
      const s = SPECS[o.kind];
      if (!s.solid) continue;
      // Boats beside the ramp you took off from: brushed past on the way up.
      if (p.air === "ramp" && o.z >= p.rampZ - 0.5 && o.z <= p.rampZ + SPECS.ramp.length) continue;
      if (p.z + PLAYER.front < o.z || z0 - PLAYER.back > o.z + s.length) continue;
      const reach = s.halfWidth + PLAYER.halfWidth;
      if (Math.abs(p.x - o.x) >= reach) continue;
      if (p.y >= s.bottom + s.height || top <= s.bottom) continue;

      if (p.boost > 0) {
        this.smash(o);
        continue;
      }
      if (p.invulnerable > 0) continue;
      // Slid into its side while changing lanes: bounce back instead of crashing.
      const before = Math.abs(x0 - (o.x - o.vx * h));
      const changing = this.time - p.lastSwitch < LANE_SWITCH_TIME * 2 + 0.05;
      if (changing && before >= reach - 0.02 && z0 + PLAYER.front > o.z + 0.2) this.bump(o);
      else this.hit(o, "Nyemplung!");
      if (this.state !== "run") return;
    }
  }

  /** Would dropping straight down from here land on something? */
  private underneath(): boolean {
    const p = this.player;
    const reach = p.z + PLAYER.front + p.speed * timeToLand(p.y, Math.min(p.vy, SLAM_VY)) + 0.5;
    return this.obstacles.some((o) => {
      const s = SPECS[o.kind];
      if (!s.solid || o.waiting || o.smashed >= 0) return false;
      if (o.z > reach || o.z + s.length < p.z - PLAYER.back) return false;
      return Math.abs(o.x - p.x) < s.halfWidth + PLAYER.halfWidth || Math.abs(o.x - LANE_X[p.lane]) < s.halfWidth + PLAYER.halfWidth;
    });
  }

  private bump(o: Obstacle) {
    const p = this.player;
    o.passed = true; // no near-miss reward for the boat you just hit
    p.lane = p.fromLane;
    const side = Math.sign(p.x - o.x) || 1;
    p.x = o.x + side * (SPECS[o.kind].halfWidth + PLAYER.halfWidth + 0.02);
    p.switchFrom = p.x;
    p.switchT = 0;
    p.slowed = 1;
    p.invulnerable = 0.3;
    this.combo = 0;
    // The police surge on every bump while they are after you.
    if (this.police.active) this.police.gap -= CHASE.bumpSurge;
    else this.warm(0.3);
    this.shake = Math.min(1, this.shake + 0.5);
    this.popup("Aduh!", "bad");
    this.sfx.bump();
  }

  private hit(o: Obstacle | null, cause: string) {
    const p = this.player;
    if (p.shield > 0) {
      p.shield = 0;
      p.invulnerable = 1.2;
      if (o) this.smash(o, false);
      this.shake = Math.min(1, this.shake + 0.5);
      this.popup("Pelampung menyelamatkanmu!", "good");
      this.sfx.shield();
      this.warm(0.35);
      return;
    }
    this.state = "crash";
    this.cause = cause;
    p.air = "jump";
    p.vy = 7;
    p.boost = 0;
    this.shake = 1;
    this.popup(cause, "bad");
    this.burst(p.x, 0.5, p.z, 28, "splash");
    this.sfx.crash();
  }

  private smash(o: Obstacle, score = true) {
    o.smashed = 0;
    if (score) {
      this.smashes++;
      this.warm(0.12);
    }
    const s = SPECS[o.kind];
    this.burst(o.x, s.bottom + s.height / 2, o.z, 16, "debris");
    this.burst(o.x, 0.3, o.z, 10, "splash");
    this.shake = Math.min(1, this.shake + 0.25);
    if (score) this.bonus(25);
    this.sfx.smash();
  }

  private collect(z0: number, h: number) {
    const p = this.player;
    const center = p.y + 0.8;
    for (const c of this.coins) {
      if (c.taken) continue;
      const dz = c.z - p.z;
      if (p.magnet > 0 && dz > -2 && dz < 18 && Math.abs(c.x - p.x) < 8) c.pulled = true;
      if (c.pulled) {
        const k = Math.min(1, h * 10);
        c.x += (p.x - c.x) * k;
        c.y += (center - c.y) * k;
        c.z += (p.z + 0.4 - c.z) * k + p.speed * h;
      }
      if (c.z < z0 - PLAYER.back || c.z > p.z + PLAYER.front) continue;
      if (Math.abs(c.x - p.x) > 1.0 || Math.abs(c.y - center) > 1.1) continue;
      c.taken = true;
      this.coinsRun++;
      this.coinStreak = this.time - this.lastCoin < 0.6 ? this.coinStreak + 1 : 1;
      this.lastCoin = this.time;
      this.bonus(10);
      this.charge(0.012);
      this.burst(c.x, c.y, c.z, 4, "spark");
      this.sfx.coin(this.coinStreak);
    }
    for (const pw of this.powers) {
      if (pw.taken || pw.z < z0 - PLAYER.back || pw.z > p.z + PLAYER.front) continue;
      if (Math.abs(pw.x - p.x) > 1.2 || p.y > 2.2) continue;
      pw.taken = true;
      this.powersTaken++;
      const names: Record<PowerKind, string> = {
        magnet: "Magnet koin!",
        shield: "Pelampung!",
        double: "Skor ×2!",
        nitro: "Nitro penuh!",
      };
      if (pw.kind === "magnet") p.magnet = 8;
      else if (pw.kind === "shield") p.shield = 20;
      else if (pw.kind === "double") p.double = 10;
      else this.charge(1);
      this.popup(names[pw.kind], "gold");
      this.burst(pw.x, 1, pw.z, 12, "spark");
      this.sfx.power(pw.kind);
    }
  }

  /** Rewards for each obstacle left behind: clean passes build the combo, close ones score. */
  private passBy() {
    const p = this.player;
    for (const o of this.obstacles) {
      if (o.passed || o.waiting) continue;
      const s = SPECS[o.kind];
      if (o.z + s.length >= p.z - PLAYER.back) continue;
      o.passed = true;
      if (o.smashed >= 0 || !s.solid || this.state !== "run") continue;
      const gap = Math.abs(p.x - o.x) - (s.halfWidth + PLAYER.halfWidth);
      if (gap < 0) {
        this.addCombo(1); // went over or under it
      } else if (gap < 1.6 && BESIDE.has(o.kind) && this.time - p.lastSwitch < 0.7) {
        this.nearMisses++;
        this.warm(0.1);
        this.addCombo(2);
        this.charge(0.07);
        this.popup(`Nyaris! +${this.bonus(50)}`, "good");
        this.sfx.near();
      }
    }
  }

  private emit(h: number) {
    const p = this.player;
    if (p.air !== "none" || this.state !== "run") return;
    this.wakeTimer -= h;
    if (this.wakeTimer > 0) return;
    this.wakeTimer = 0.025;
    for (const side of [-1, 1]) {
      this.particle({ x: p.x + side * 0.38, y: 0, z: p.z - 1.2, vx: side * rand(0.3, 0.9), vy: 0, vz: 0, life: 1.4, size: rand(0.35, 0.55), kind: "foam" });
    }
    // The rooster tail: a plume thrown up behind the jet.
    const tall = p.boost > 0 ? 1.25 : 1;
    this.particle({
      x: p.x + rand(-0.15, 0.15),
      y: 0.2,
      z: p.z - 1.4,
      vx: rand(-0.6, 0.6),
      vy: rand(3, 5.5) * tall,
      // Lags only a little behind the jetski, so the plume arcs up right behind it.
      vz: p.speed * rand(0.78, 0.88),
      life: 0.45,
      size: rand(0.12, 0.22),
      kind: "spray",
    });
  }

  private updateEffects(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i];
      q.life -= dt;
      if (q.life <= 0) {
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
        continue;
      }
      q.x += q.vx * dt;
      q.z += q.vz * dt;
      if (q.kind === "foam") {
        q.vx *= 1 - Math.min(1, dt * 1.5);
        continue;
      }
      q.vy -= GRAVITY * 0.6 * dt;
      q.y += q.vy * dt;
      if (q.y < 0) {
        q.y = 0;
        q.vy = 0;
        q.vx *= 0.5;
        q.vz *= 0.5;
      }
    }
    for (const p of this.popups) p.t += dt;
    this.popups = this.popups.filter((p) => p.t < POPUP_SECONDS);
  }

  private particle(q: Omit<Particle, "max">) {
    if (this.particles.length >= MAX_PARTICLES) return;
    this.particles.push({ ...q, max: q.life });
  }

  private burst(x: number, y: number, z: number, count: number, kind: Particle["kind"], push = 0) {
    const p = this.player;
    for (let i = 0; i < count; i++) {
      this.particle({
        x: x + rand(-0.4, 0.4),
        y,
        z: z + rand(-0.4, 0.4),
        vx: rand(-2.5, 2.5) + push,
        vy: kind === "spark" ? rand(1, 3) : rand(2, 6),
        vz: (kind === "debris" ? rand(-2, 6) : rand(-1, 3)) + (kind === "spark" ? p.speed * 0.9 : 0),
        life: kind === "spark" ? 0.35 : rand(0.5, 0.9),
        size: kind === "debris" ? rand(0.15, 0.35) : rand(0.15, 0.35),
        kind,
      });
    }
  }

  private bonus(points: number) {
    const value = Math.round(points * this.multiplier * (this.player.double > 0 ? 2 : 1));
    this.score += value;
    return value;
  }

  private addCombo(n: number) {
    const before = this.multiplier;
    this.combo += n;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    if (this.multiplier > before) {
      this.popup(`Kombo ×${this.multiplier}`, "gold");
      this.sfx.combo(this.multiplier);
    }
  }

  private charge(amount: number) {
    const p = this.player;
    if (p.boost > 0) return;
    p.nitro = Math.min(1, p.nitro + amount);
    if (p.nitro >= 1 && !this.nitroReady) {
      this.nitroReady = true;
      this.popup("Nitro siap!", "gold");
      this.hint("nitro");
    }
  }

  /**
   * Back on the water after a crash (paid for with coins): the way ahead is
   * cleared, the police drop back, and a moment of grace to get going again.
   */
  revive() {
    if (this.state === "run") return;
    const p = this.player;
    this.state = "run";
    this.cause = "";
    this.crashTime = 0;
    p.tumble = 0;
    p.y = 0;
    p.vy = 0;
    p.air = "none";
    p.spin = 0;
    p.spinning = false;
    p.queued = 0;
    p.spins = 0;
    p.duck = 0;
    p.slowed = 0;
    p.x = LANE_X[p.lane];
    p.switchFrom = p.x;
    p.switchT = 1;
    p.speed = speedAt(p.z) * 0.7;
    p.invulnerable = 2.5;
    for (const o of this.obstacles) {
      if (!o.waiting && o.z + SPECS[o.kind].length > p.z - 5 && o.z < p.z + 70) o.smashed = 0;
    }
    if (this.police.active) this.police.gap = Math.max(this.police.gap, 40);
    this.popup("Lanjut!", "gold");
  }

  /** For news from outside the simulation, such as a finished mission. */
  announce(text: string, tone: Popup["tone"] = "gold") {
    this.popup(text, tone);
  }

  private popup(text: string, tone: Popup["tone"]) {
    this.popups.push({ text, t: 0, tone });
    if (this.popups.length > 4) this.popups.shift();
  }

  private hint(id: HintId) {
    if (this.hinted.has(id)) return;
    this.hinted.add(id);
    this.onHint?.(id);
  }
}

