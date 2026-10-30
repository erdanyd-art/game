import assert from "node:assert/strict";
import { test } from "node:test";
import type { Outcome } from "../src/game.ts";
import { describe, freshMissions, missionAt, progressOf, readMissions, settle } from "../src/missions.ts";

const run = (o: Partial<Outcome>): Outcome => ({ score: 0, distance: 0, coins: 0, bestCombo: 0, tricks: 0, nearMisses: 0, escapes: 0, smashes: 0, powers: 0, ...o });

test("three goals to start, each described in Indonesian", () => {
  const s = freshMissions();
  assert.deepEqual(s.active.map((a) => a.n), [0, 1, 2]);
  assert.equal(describe(missionAt(0)), "Kumpulkan 50 koin dalam satu run");
  assert.equal(describe(missionAt(1)), "Salto 2 kali dalam satu run");
  assert.equal(describe(missionAt(8)), "Capai kombo ×2");
});

test("finishing a goal pays out and brings in the next one", () => {
  const s = freshMissions();
  const { done, reward } = settle(s, run({ coins: 60, tricks: 1 }));
  assert.equal(done.length, 1);
  assert.equal(reward, missionAt(0).reward);
  assert.deepEqual(s.active.map((a) => a.n), [3, 1, 2]);
  assert.equal(s.next, 4);
});

test("run goals reset each run; total goals add up across runs", () => {
  const s = { next: 10, active: [{ n: 1, progress: 0 }, { n: 6, progress: 0 }, { n: 9, progress: 0 }] };
  settle(s, run({ tricks: 1, coins: 300 }));
  assert.equal(s.active[0].progress, 0, "1 of 2 flips does not carry over");
  assert.equal(s.active[1].progress, 300, "coins add up");
  const { done } = settle(s, run({ coins: 250 }));
  assert.equal(done.length, 1, "500 coins reached across two runs");
  assert.equal(progressOf({ n: 9, progress: 14 }, run({ tricks: 1 })), 15);
});

test("after the list, goals come round again bigger", () => {
  const lap = missionAt(14);
  assert.equal(lap.kind, missionAt(0).kind);
  assert.equal(lap.target, missionAt(0).target * 2);
  assert.ok(lap.reward > missionAt(0).reward);
  assert.equal(missionAt(14 + 8).target, 24, "combo stays reachable");
});

test("a corrupted saved state is rejected", () => {
  assert.equal(readMissions({ next: 3, active: [{ n: 0 }] }), null);
  assert.equal(readMissions("nope"), null);
  assert.deepEqual(readMissions(freshMissions()), freshMissions());
});
