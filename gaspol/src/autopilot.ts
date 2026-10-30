import { LANE_X, PLAYER, SPECS, type ObstacleKind } from "./config.ts";
import type { Action, Game, Obstacle } from "./game.ts";

// A simple rider: looks a moment ahead in each lane and hops, ducks or swerves.
// It drives the title-screen demo and the balance checks. `reaction` delays how
// soon it notices things; `slack` makes it misjudge timing, like a person.

const LOW = new Set<ObstacleKind>(["log", "net"]);
const HIGH = new Set<ObstacleKind>(["rope", "deck"]);

export type Pilot = { reaction: number; slack: number; tricks: number };

export const SHARP: Pilot = { reaction: 0.15, slack: 0.02, tricks: 1 };

function laneOf(x: number) {
  let best = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(LANE_X[i] - x) < Math.abs(LANE_X[best] - x)) best = i;
  return best;
}

/** Seconds until the jetski's nose meets the obstacle (negative once alongside). */
function eta(game: Game, o: Obstacle) {
  const p = game.player;
  return (o.z - (p.z + PLAYER.front)) / Math.max(1, p.speed - o.vz);
}

/** Does it cover the lane when we get there? Moving things are judged where they will be. */
function blocking(game: Game, o: Obstacle, lane: number) {
  const x = LANE_X[lane];
  const t = Math.max(0, eta(game, o));
  const span = (SPECS[o.kind].length + PLAYER.front + PLAYER.back) / Math.max(1, game.player.speed - o.vz);
  const reach = SPECS[o.kind].halfWidth + PLAYER.halfWidth + 0.1;
  // A banana boat sweeps sideways while we pass it: check both ends of that moment.
  return [t, t + span].some((dt) => Math.abs(o.x + o.vx * dt - x) < reach);
}

/** The first thing in a lane within `window` seconds, ignoring what is already behind. */
function firstIn(game: Game, lane: number, window: number) {
  let best: { o: Obstacle; t: number } | null = null;
  for (const o of game.obstacles) {
    if (o.waiting || o.smashed >= 0 || !blocking(game, o, lane)) continue;
    const t = eta(game, o);
    const tail = (o.z + SPECS[o.kind].length - (game.player.z - PLAYER.back)) / Math.max(1, game.player.speed);
    if (tail < 0 || t > window) continue;
    if (!best || t < best.t) best = { o, t };
  }
  return best;
}

/** How long a lane stays clear of anything that must be dodged sideways; a ramp first means a way over. */
function clearance(game: Game, lane: number) {
  let soonest = Infinity;
  let ramp = Infinity;
  for (const o of game.obstacles) {
    if (o.waiting || o.smashed >= 0 || LOW.has(o.kind) || HIGH.has(o.kind)) continue;
    if (!blocking(game, o, lane)) continue;
    const t = eta(game, o);
    const tail = (o.z + SPECS[o.kind].length - (game.player.z - PLAYER.back)) / Math.max(1, game.player.speed);
    if (tail < 0) continue;
    if (o.kind === "ramp") ramp = Math.min(ramp, Math.max(0, t));
    else soonest = Math.min(soonest, Math.max(0, t));
  }
  return ramp < soonest ? 5 : soonest;
}

export class Autopilot {
  private readonly pilot: Pilot;
  private airTricks = 0;
  private wasAir = false;

  constructor(pilot: Pilot = SHARP) {
    this.pilot = pilot;
  }

  decide(game: Game): Action | null {
    const p = game.player;
    if (game.state !== "run") return null;
    const jitter = (Math.random() * 2 - 1) * this.pilot.slack;

    if (p.air === "ramp") {
      if (!this.wasAir) this.airTricks = 0;
      this.wasAir = true;
      // Flip early enough to finish before touching down.
      if (!p.spinning && this.airTricks < this.pilot.tricks && p.vy > 4) {
        this.airTricks++;
        return "tap";
      }
      return null;
    }
    this.wasAir = p.air !== "none";
    if (p.nitro >= 1 && p.boost <= 0) return "nitro";

    const lane = laneOf(p.x);
    const seen = 1.2 - this.pilot.reaction;
    const next = firstIn(game, lane, seen);
    if (!next) return null;
    const { o, t } = next;
    if (o.kind === "ramp") return null;
    if (LOW.has(o.kind) && p.air === "none") return t < 0.22 + jitter ? "up" : null;
    if (HIGH.has(o.kind) && p.air === "none") return t < 0.3 + jitter && p.duck <= 0.05 ? "down" : null;
    if (LOW.has(o.kind) || HIGH.has(o.kind)) return null;

    // Something to steer round: head for the lane that stays clear longest.
    if (t > 0.75 + jitter) return null;
    const options = [lane - 1, lane + 1].filter((l) => l >= 0 && l <= 2);
    let best = lane;
    let bestClear = clearance(game, lane);
    for (const l of options) {
      const c = clearance(game, l);
      if (c > bestClear + 0.05) {
        best = l;
        bestClear = c;
      }
    }
    // From an edge lane with the middle blocked too, head for the far lane via the middle.
    if (best === lane && lane !== 1 && clearance(game, lane === 0 ? 2 : 0) > bestClear) best = 1;
    if (best === lane || p.lane !== lane) return null;
    return best < lane ? "left" : "right";
  }
}
