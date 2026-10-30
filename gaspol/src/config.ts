// One source of truth for physics, shared by the game, the course generator and
// the solver test, so "can this be passed?" is always asked with the real numbers.
// Units are metres and seconds; z points forward, y up.

export const LANE_X = [-2.4, 0, 2.4] as const;
export const LANE_WIDTH = 2.4;
/** Seconds to slide one lane over. */
export const LANE_SWITCH_TIME = 0.14;

export const GRAVITY = 25;

/** Seconds until touching down, from height y rising at vy. */
export const timeToLand = (y: number, vy: number) => (vy + Math.sqrt(vy * vy + 2 * GRAVITY * Math.max(0, y))) / GRAVITY;
/** A normal hop: 0.64 s in the air, 1.28 m high. Clears logs, not rocks. */
export const JUMP_VY = 8;
/** Off a wave ramp: 1.2 s in the air, 4.5 m high. Clears a row of boats, sails and all. */
export const RAMP_VY = 15;
/** Pressing down in the air drops you fast. */
export const SLAM_VY = -20;
export const DUCK_TIME = 0.6;
/** One backflip off a ramp. */
export const SPIN_TIME = 0.4;

export const START_SPEED = 20;
export const MAX_SPEED = 42;
const ACCEL_PER_METER = 0.008;
export const NITRO_TIME = 4;
export const NITRO_BOOST = 1.45;

export const PLAYER = { halfWidth: 0.45, front: 1.0, back: 1.3, height: 1.5, duckHeight: 0.75 };

export const airtime = (vy: number) => (2 * vy) / GRAVITY;
export const heightAt = (vy: number, t: number) => vy * t - 0.5 * GRAVITY * t * t;
export const speedAt = (distance: number) => Math.min(MAX_SPEED, START_SPEED + distance * ACCEL_PER_METER);

export type ObstacleKind =
  | "boat"
  | "rock"
  | "log"
  | "net"
  | "rope"
  | "deck"
  | "pillar"
  | "ramp"
  | "jetski"
  | "banana";

/** Box of each obstacle: `z` is its near edge, it reaches `length` further on. */
export type Spec = { halfWidth: number; length: number; bottom: number; height: number; solid: boolean };

export const SPECS: Record<ObstacleKind, Spec> = {
  boat: { halfWidth: 1.0, length: 4.5, bottom: 0, height: 2.2, solid: true },
  rock: { halfWidth: 0.95, length: 2.2, bottom: 0, height: 1.6, solid: true },
  log: { halfWidth: 1.15, length: 0.8, bottom: 0, height: 0.6, solid: true },
  net: { halfWidth: 1.2, length: 0.5, bottom: 0, height: 0.65, solid: true },
  // Hung from 0.95 m up: a standing rider (1.5 m) hits it, a ducking one (0.75 m) passes.
  rope: { halfWidth: 1.2, length: 0.4, bottom: 0.95, height: 1.6, solid: true },
  deck: { halfWidth: 1.2, length: 7, bottom: 0.95, height: 1.1, solid: true },
  pillar: { halfWidth: 0.55, length: 7, bottom: 0, height: 2.05, solid: true },
  ramp: { halfWidth: 1.1, length: 3, bottom: 0, height: 0, solid: false },
  jetski: { halfWidth: 0.55, length: 2.6, bottom: 0, height: 1.4, solid: true },
  banana: { halfWidth: 2.6, length: 1.3, bottom: 0, height: 1.4, solid: true },
};

/** When a jump launched at `vy` is above `height` (with a 10 cm margin): seconds after take-off. */
export function clearWindow(vy: number, height: number): [number, number] | null {
  const h = height + 0.1;
  const disc = vy * vy - 2 * GRAVITY * h;
  if (disc <= 0) return null;
  const root = Math.sqrt(disc);
  return [(vy - root) / GRAVITY, (vy + root) / GRAVITY];
}

/**
 * A ramp launches you while any of the hull is over it: from the nose touching
 * its near edge until the tail leaves its far edge. This is how far the nose
 * travels in that time, so a late launch is up to this much further on.
 */
export const RAMP_REACH = SPECS.ramp.length + PLAYER.front + PLAYER.back;

/**
 * How far past a ramp's near edge to put an obstacle so a ramp jump at `speed`
 * clears all of it, front to back, however early or late on the ramp it launched.
 */
export function overRampOffset(speed: number, kind: ObstacleKind): number {
  const [t1, t2] = clearWindow(RAMP_VY, SPECS[kind].height)!;
  const span = SPECS[kind].length + PLAYER.front + PLAYER.back;
  return (speed * (t1 + t2)) / 2 - span / 2 + RAMP_REACH / 2;
}

/** Speed of other jetskis riding the same way, and of a banana boat crossing. */
export const TRAFFIC_SPEED = 12;
export const BANANA_SPEED = 4;

/** Distance thresholds where the course gets harder. */
export const TIERS = [0, 350, 1100, 2200];
export const tierAt = (distance: number) => TIERS.filter((t) => distance >= t).length - 1;
