import assert from "node:assert/strict";
import { test } from "node:test";
import { LANE_X, NITRO_TIME, type ObstacleKind } from "../src/config.ts";
import { Game, silentSfx, type Action } from "../src/game.ts";

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
  // At 20 m/s the boats are cleared from ~5 m to ~14 m past the ramp.
  for (const lane of [0, 1, 2]) place(g, "boat", lane, 49);
  ride(g, 80);
  assert.equal(g.state, "run");
  assert.ok(g.combo >= 1, "flying over counts as a clean pass");
});

test("backflips off a ramp score when landed clean, and wipe you out when not", () => {
  const g = sandbox();
  place(g, "ramp", 1, 40);
  ride(g, 80, [[41, "up"]]); // one flip (0.4 s) in 0.96 s of air
  assert.equal(g.state, "run");
  assert.equal(g.tricks, 1);
  const h = sandbox();
  place(h, "ramp", 1, 40);
  ride(h, 80, [[55, "up"]]); // too late: 0.8 s into a 1.04 s jump, still flipping on touchdown
  assert.equal(h.state, "crash");
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
