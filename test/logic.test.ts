import assert from "node:assert/strict";
import { test } from "node:test";
import { beatAt, GOOD_WINDOW, judgeTap, PERFECT_WINDOW } from "../src/beat.ts";
import { createLevel } from "../src/level.ts";
import { NIGHTS, starsFor } from "../src/nights.ts";
import { createRng } from "../src/rng.ts";

const SPB = 60 / 72;

test("a tap on the beat is perfect, slightly off is good, far off is a miss", () => {
  assert.equal(judgeTap(10 + 4 * SPB, 10, SPB).judgement, "perfect");
  assert.equal(judgeTap(10 + 4 * SPB + PERFECT_WINDOW - 0.001, 10, SPB).judgement, "perfect");
  assert.equal(judgeTap(10 + 4 * SPB - PERFECT_WINDOW - 0.01, 10, SPB).judgement, "good");
  assert.equal(judgeTap(10 + 4 * SPB + GOOD_WINDOW + 0.01, 10, SPB).judgement, "miss");
  assert.equal(judgeTap(10 + 4.5 * SPB, 10, SPB).judgement, "miss");
});

test("a tap is judged against the nearest beat, early or late", () => {
  const early = judgeTap(10 + 5 * SPB - 0.05, 10, SPB);
  assert.equal(early.beat, 5);
  assert.ok(early.offset < 0);
  const late = judgeTap(10 + 5 * SPB + 0.05, 10, SPB);
  assert.equal(late.beat, 5);
  assert.ok(late.offset > 0);
});

test("good window stays inside half a beat at the fastest tempo", () => {
  const fastest = Math.max(...NIGHTS.map((n) => n.bpm));
  assert.ok(GOOD_WINDOW < 60 / fastest / 2);
});

test("beatAt reports the last beat and the phase towards the next", () => {
  const { beat, phase } = beatAt(10 + 3.25 * SPB, 10, SPB);
  assert.equal(beat, 3);
  assert.ok(Math.abs(phase - 0.25) < 1e-9);
  assert.equal(beatAt(9.9, 10, SPB).beat, -1); // before the music starts
});

test("the same seed always gives the same river", () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
  const one = createLevel(NIGHTS[2]);
  const two = createLevel(NIGHTS[2]);
  assert.deepEqual(one.clusters, two.clusters);
  assert.deepEqual(one.frogs, two.frogs);
  assert.equal(one.center(1234), two.center(1234));
});

for (const night of NIGHTS) {
  test(`night ${night.number}: everything sits in the river and the count adds up`, () => {
    const level = createLevel(night);
    assert.equal(level.clusters.length, night.clusters);
    assert.equal(level.frogs.length, night.frogs);
    const inside = (x: number, y: number) => Math.abs(y - level.center(x)) <= level.half(x);
    for (const c of level.clusters) {
      assert.ok(inside(c.x, c.y), `cluster at ${c.x} outside the banks`);
      assert.ok(c.x > 600 && c.x < level.end - 300, `cluster at ${c.x} outside the course`);
    }
    for (const f of level.frogs) assert.ok(inside(f.x, f.y), `frog at ${f.x} outside the banks`);
    assert.equal(level.total, night.startSwarm + level.clusters.reduce((s, c) => s + c.count, 0));
    // The river is never too narrow to pass.
    for (let x = 0; x < level.end; x += 50) assert.ok(level.half(x) > 200, `too narrow at ${x}`);
  });
}

test("the first frog of the first night waits past the opening stretch", () => {
  const level = createLevel(NIGHTS[0]);
  assert.ok(Math.min(...level.frogs.map((f) => f.x)) >= 1500);
});

test("stars follow the share of fireflies brought home", () => {
  assert.equal(starsFor(0, 100), 0);
  assert.equal(starsFor(34, 100), 0);
  assert.equal(starsFor(35, 100), 1);
  assert.equal(starsFor(60, 100), 2);
  assert.equal(starsFor(85, 100), 3);
  assert.equal(starsFor(100, 100), 3);
  assert.equal(starsFor(5, 0), 0);
});
