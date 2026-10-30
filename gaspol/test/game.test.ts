import assert from "node:assert/strict";
import { test } from "node:test";
import { LANE_X, NITRO_TIME, overRampOffset, speedAt, type ObstacleKind } from "../src/config.ts";
import { CHASE, Game, silentSfx, type Action } from "../src/game.ts";

/** A game on an empty sea, with only the obstacles a test places. */
function sandbox() {
  const game = new Game({ sfx: silentSfx, seed: 1 });
  (game.course as { fill: unknown }).fill = () => ({ obstacles: [], coins: [], powers: [] });
  game.obstacles = [];
  game.coins = [];
  game.powers = [];
  return game;
}
let id = 1000;
function place(game: Game, kind: ObstacleKind, lane: number, z: number) {
  game.obstacles.push({ id: id++, kind, x: LANE_X[lane], z, vx: 0, vz: 0, waiting: false, meetX: LANE_X[lane], meetZ: z, passed: false, smashed: -1 });
}
/** Runs until the player reaches z, firing each action once the player passes its z. */
function ride(game: Game, until: number, actions: [number, Action][] = []) {
  const queue = [...actions];
  for (let i = 0; i < 5000 && game.player.z < until && game.state === "run"; i++) {
    while (queue.length && game.player.z >= queue[0][0]) game.act(queue.shift()![1]);
    game.update(1 / 60);
  }
}

test("riding straight into a boat crashes", () => {
  const g = sandbox();
  place(g, "boat", 1, 40);
  ride(g, 60);
  assert.equal(g.state, "crash");
});

test("changing lane early avoids it", () => {
  const g = sandbox();
  place(g, "boat", 1, 40);
  ride(g, 60, [[20, "left"]]);
  assert.equal(g.state, "run");
});

test("sliding into the side of a boat bounces you back, it does not end the run", () => {
  const g = sandbox();
  place(g, "boat", 0, 30);
  ride(g, 31.5, [[31, "left"]]);
  ride(g, 50);
  assert.equal(g.state, "run");
  assert.equal(g.player.lane, 1);
  assert.equal(g.combo, 0);
});

test("a timed hop clears a log; no hop does not", () => {
  const g = sandbox();
  place(g, "log", 1, 40);
  // Take off ~0.3 s (about 6 m at 20 m/s) before the log.
  ride(g, 70, [[33, "up"]]);
  assert.equal(g.state, "run");
  const h = sandbox();
  place(h, "log", 1, 40);
  ride(h, 70);
  assert.equal(h.state, "crash");
});

test("ducking passes under the flags; hopping into them does not", () => {
  const g = sandbox();
  place(g, "rope", 1, 40);
  ride(g, 60, [[36, "down"]]);
  assert.equal(g.state, "run");
  const h = sandbox();
  place(h, "rope", 1, 40);
  ride(h, 60, [[34, "up"]]);
  assert.equal(h.state, "crash");
});

test("a ramp flies you over a row of boats", () => {
  const g = sandbox();
  place(g, "ramp", 1, 40);
  for (const lane of [0, 1, 2]) place(g, "boat", lane, 40 + overRampOffset(speedAt(40), "boat"));
  ride(g, 80);
  assert.equal(g.state, "run");
  assert.ok(g.combo >= 1, "flying over counts as a clean pass");
});

test("backflips off a ramp score, and mashing the button never crashes you", () => {
  const g = sandbox();
  place(g, "ramp", 1, 40);
  ride(g, 90, [[41, "up"]]);
  assert.equal(g.state, "run");
  assert.equal(g.tricks, 1);
  const mash = sandbox();
  place(mash, "ramp", 1, 40);
  ride(mash, 90, [[41, "up"], [42, "up"], [43, "up"], [44, "up"], [45, "up"]]);
  assert.equal(mash.state, "run");
  assert.ok(mash.tricks >= 2 && mash.tricks <= 3, `${mash.tricks} flips fit in the air`);
  const late = sandbox();
  place(late, "ramp", 1, 40);
  ride(late, 90, [[61, "up"]]); // too late to finish one: nothing happens
  assert.equal(late.state, "run");
  assert.equal(late.tricks, 0);
});

test("a ramp still launches you if you hopped just before it", () => {
  for (const at of [34, 37, 39]) {
    const g = sandbox();
    place(g, "ramp", 1, 40);
    for (const lane of [0, 1, 2]) place(g, "boat", lane, 40 + overRampOffset(speedAt(40), "boat"));
    ride(g, 90, [[at, "up"]]);
    assert.equal(g.state, "run", `hop at ${at} m`);
  }
});

test("a last-moment swerve onto a ramp still launches you over the wall", () => {
  const wall = 40 + overRampOffset(speedAt(40), "boat");
  // Out of a boat lane beside the ramp, nose 0.8 m short of it: you brush past that boat on the way up.
  const boats = sandbox();
  place(boats, "ramp", 0, 40);
  place(boats, "boat", 1, 40);
  place(boats, "boat", 2, 40);
  for (const lane of [0, 1, 2]) place(boats, "boat", lane, wall);
  ride(boats, wall + 20, [[38.2, "left"]]);
  assert.equal(boats.state, "run");
  // From open water beside it, with the nose already 1.5 m past its near edge.
  const open = sandbox();
  place(open, "ramp", 0, 40);
  for (const lane of [0, 1, 2]) place(open, "boat", lane, wall);
  ride(open, wall + 20, [[40.5, "left"]]);
  assert.equal(open.state, "run");
});

test("riding past a ramp in the next lane does not launch you", () => {
  const g = sandbox();
  place(g, "ramp", 0, 40);
  let top = 0;
  for (let i = 0; i < 200 && g.player.z < 60; i++) {
    g.update(1 / 60);
    top = Math.max(top, g.player.y);
  }
  assert.equal(top, 0);
});

test("down over the wall ducks on landing instead of dropping onto it; over open water it drops", () => {
  const wall = 40 + overRampOffset(speedAt(40), "boat");
  const g = sandbox();
  place(g, "ramp", 1, 40);
  for (const lane of [0, 1, 2]) place(g, "boat", lane, wall);
  place(g, "rope", 1, wall + 20);
  ride(g, wall + 40, [[wall - 2, "down"]]);
  assert.equal(g.state, "run", "flew over the wall and ducked under the flags");
  const open = sandbox();
  place(open, "ramp", 1, 40);
  ride(open, 52, [[45, "down"]]);
  assert.equal(open.player.air, "none", "dropped well before the arc would end");
});

test("nitro smashes through obstacles and runs out", () => {
  const g = sandbox();
  g.player.nitro = 1;
  place(g, "boat", 1, 40);
  place(g, "rock", 1, 60);
  ride(g, 90, [[5, "nitro"]]);
  assert.equal(g.state, "run");
  assert.ok(g.obstacles.every((o) => o.smashed >= 0));
  const t0 = g.time;
  ride(g, 400);
  assert.ok(g.player.boost === 0 && g.time - t0 > 0 && g.time > NITRO_TIME);
});

test("when nitro runs out you get a second of grace while slowing down", () => {
  const g = sandbox();
  ride(g, 1000);
  g.player.nitro = 1;
  g.act("nitro");
  // Ride out the nitro, then put a rock right where it ends.
  while (g.player.boost > 0) g.update(1 / 60);
  place(g, "rock", 1, g.player.z + 12);
  ride(g, g.player.z + 30);
  assert.equal(g.state, "run");
  assert.ok(g.player.speed < 32, `back near normal speed: ${g.player.speed.toFixed(1)}`);
});

test("the life ring absorbs one crash, not two", () => {
  const g = sandbox();
  g.player.shield = 20;
  place(g, "boat", 1, 40);
  place(g, "boat", 1, 120);
  ride(g, 100);
  assert.equal(g.state, "run");
  assert.equal(g.player.shield, 0);
  ride(g, 160);
  assert.equal(g.state, "crash");
});

test("a close pass right after a lane change is a near miss", () => {
  const g = sandbox();
  place(g, "boat", 1, 40);
  ride(g, 60, [[36, "left"]]);
  assert.equal(g.state, "run");
  assert.equal(g.nearMisses, 1);
  const calm = sandbox();
  place(calm, "boat", 1, 40);
  ride(calm, 60, [[5, "left"]]);
  assert.equal(calm.nearMisses, 0, "drifting past long after a lane change is not");
});

test("coins are collected in your lane, and the magnet pulls the rest", () => {
  const g = sandbox();
  for (let z = 20; z < 60; z += 4) g.coins.push({ x: 0, y: 0.9, z, taken: false, pulled: false });
  for (let z = 20; z < 60; z += 4) g.coins.push({ x: LANE_X[2], y: 0.9, z, taken: false, pulled: false });
  ride(g, 70);
  assert.equal(g.coinsRun, 10);
  const m = sandbox();
  m.player.magnet = 8;
  for (let z = 20; z < 60; z += 4) m.coins.push({ x: LANE_X[2], y: 0.9, z, taken: false, pulled: false });
  ride(m, 70);
  assert.equal(m.coinsRun, 10);
});

test("the combo multiplier climbs and a bump resets it", () => {
  const g = sandbox();
  g.combo = 23;
  assert.equal(g.multiplier, 1.5);
  g.combo = 24;
  assert.equal(g.multiplier, 2);
  g.combo = 1000;
  assert.equal(g.multiplier, 3);
});

test("speed rises with distance and a crash ends the run after a moment", () => {
  const g = sandbox();
  ride(g, 1000);
  assert.ok(g.player.speed > 26 && g.player.speed < 29, `speed ${g.player.speed.toFixed(1)}`);
  place(g, "rock", 1, g.player.z + 30);
  ride(g, g.player.z + 60);
  assert.equal(g.state, "crash");
  for (let i = 0; i < 120 && g.state === "crash"; i++) g.update(1 / 60);
  assert.equal(g.state, "over");
  assert.ok(g.outcome.distance >= 1000);
});

/** A run already far enough out for the police to take an interest. */
function chased() {
  const g = sandbox();
  ride(g, 400);
  g.heat = 1;
  g.update(1 / 60);
  return g;
}

test("reckless riding draws the police; a calm start does not", () => {
  const calm = sandbox();
  ride(calm, 600);
  assert.equal(calm.police.active, false);
  const g = chased();
  assert.equal(g.police.active, true);
  assert.equal(Math.round(g.police.gap), CHASE.startGap);
});

test("the police close in slowly, and every bump lets them surge", () => {
  const g = chased();
  const start = g.police.gap;
  ride(g, g.player.z + 150);
  assert.ok(g.police.gap < start && g.police.gap > start - 15, `gap ${g.police.gap.toFixed(1)}`);
  place(g, "boat", 0, g.player.z + 20);
  const before = g.police.gap;
  ride(g, g.player.z + 21.5, [[g.player.z + 20.8, "left"]]);
  ride(g, g.player.z + 10);
  assert.ok(g.police.gap < before - CHASE.bumpSurge + 2, `bumped: ${before.toFixed(1)} -> ${g.police.gap.toFixed(1)}`);
});

test("getting caught ends the run; the life ring buys one more chance", () => {
  const g = chased();
  g.player.shield = 20;
  g.police.gap = CHASE.caughtGap + 0.01;
  ride(g, g.player.z + 30);
  assert.equal(g.state, "run");
  assert.equal(g.police.gap > 20, true);
  g.police.gap = CHASE.caughtGap + 0.01;
  ride(g, g.player.z + 30);
  assert.equal(g.state, "crash");
  assert.equal(g.cause, "Ditangkap Polairud!");
});

test("nitro pulls away for an escape and a bonus", () => {
  const g = chased();
  g.player.nitro = 1;
  g.act("nitro");
  const score = g.score;
  ride(g, g.player.z + 400);
  assert.equal(g.police.active, false);
  assert.equal(g.escapes, 1);
  assert.ok(g.score - score > CHASE.escapeBonus);
});

test("riding clean until they tire also gets you away", () => {
  const g = chased();
  for (let i = 0; i < 60 * 60 && g.police.active && g.state === "run"; i++) g.update(1 / 60);
  assert.equal(g.state, "run");
  assert.equal(g.escapes, 1);
});

test("continuing after a crash clears the way and keeps the run going", () => {
  const g = sandbox();
  place(g, "rock", 1, 40);
  place(g, "boat", 1, 80);
  ride(g, 60);
  assert.equal(g.state, "crash");
  const distance = g.player.z;
  g.revive();
  assert.equal(g.state, "run");
  ride(g, 140);
  assert.equal(g.state, "run", "the boat just ahead was cleared");
  assert.ok(g.player.z > distance + 50);
  place(g, "rock", 1, g.player.z + 30);
  ride(g, g.player.z + 60);
  assert.equal(g.state, "crash", "only the way ahead at the moment of reviving is cleared");
});

test("caught by the police, continuing puts them well back", () => {
  const g = chased();
  g.police.gap = CHASE.caughtGap + 0.01;
  ride(g, g.player.z + 10);
  assert.equal(g.cause, "Ditangkap Polairud!");
  g.revive();
  assert.ok(g.police.gap >= 40);
  ride(g, g.player.z + 50);
  assert.equal(g.state, "run");
});
