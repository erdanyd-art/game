import assert from "node:assert/strict";
import { test } from "node:test";
import {
  airtime,
  clearWindow,
  JUMP_VY,
  LANE_SWITCH_TIME,
  LANE_X,
  overRampOffset,
  PLAYER,
  RAMP_VY,
  SPECS,
  speedAt,
} from "../src/config.ts";
import { Course, crossingTime, type Row } from "../src/course.ts";

// A player with perfect foresight: given the rows, is there any way through?
// States are (lane, when the next hop can start, when the last ramp launched).
// An obstacle is overlapped from the moment the jetski's nose reaches it until
// its tail leaves, so the whole of that interval must be cleared, not one instant.
type State = { lane: number; free: number; ramp: number | null };

const RAMP_AIR = airtime(RAMP_VY);
const LENGTHS: Record<string, number> = { B: SPECS.boat.length, R: SPECS.rock.length, T: SPECS.jetski.length, P: SPECS.pillar.length, D: SPECS.deck.length, L: SPECS.log.length, N: SPECS.net.length, H: SPECS.rope.length };
const rowLength = (row: Row) => Math.max(0, ...row.cells.map((c) => LENGTHS[c] ?? 0));
const CLEARABLE: Record<string, keyof typeof SPECS> = { B: "boat", R: "rock" };
const overlap = (kind: keyof typeof SPECS, z: number) =>
  (SPECS[kind].length + PLAYER.front + PLAYER.back) / speedAt(z);
/** Is a jump launched at `start` above `kind` for the whole of [t, t + span]? */
function clears(vy: number, start: number, t: number, span: number, kind: keyof typeof SPECS) {
  const window = clearWindow(vy, SPECS[kind].bottom + SPECS[kind].height);
  return window !== null && t - start >= window[0] && t + span - start <= window[1];
}

function solve(rows: Row[]): { ok: true } | { ok: false; at: number; row: Row } {
  let states: State[] = [{ lane: 1, free: 0, ramp: null }];
  let previous: Row | null = null;
  for (const [i, row] of rows.entries()) {
    const next = new Map<string, State>();
    const window = row.time - (previous?.time ?? 0);
    // Moving over has to wait until the last row's obstacles have slid past.
    const alongside = previous ? (rowLength(previous) + PLAYER.front + PLAYER.back) / speedAt(previous.z) : 0;
    for (const s of states) {
      for (let lane = 0; lane < 3; lane++) {
        const moves = Math.abs(lane - s.lane);
        if (moves > 0 && moves * LANE_SWITCH_TIME > window - alongside - 0.05) continue;
        const cell = row.cells[lane];
        const flying = s.ramp !== null && row.time < s.ramp + RAMP_AIR;
        const ramp = flying ? s.ramp : null;
        let result: State | null = null;
        if (cell === ".") result = { lane, free: s.free, ramp };
        else if (cell in CLEARABLE) {
          const kind = CLEARABLE[cell];
          result = flying && clears(RAMP_VY, s.ramp!, row.time, overlap(kind, row.z), kind) ? { lane, free: s.free, ramp } : null;
        } else if (cell === "L" || cell === "N") {
          const kind = cell === "L" ? "log" : "net";
          const span = overlap(kind, row.z);
          if (flying) result = clears(RAMP_VY, s.ramp!, row.time, span, kind) ? { lane, free: s.free, ramp } : null;
          else {
            // The latest take-off that still clears it, but not before the last landing.
            const [t1, t2] = clearWindow(JUMP_VY, SPECS[kind].height)!;
            const start = Math.max(s.free, row.time + span - t2);
            if (start <= row.time - t1) result = { lane, free: start + airtime(JUMP_VY), ramp: null };
          }
        } else if (cell === "H" || cell === "D") {
          result = !flying && s.free <= row.time - 0.05 ? { lane, free: Math.max(s.free, row.time + 0.05), ramp: null } : null;
        } else if (cell === "J") {
          result = !flying && s.free <= row.time ? { lane, free: row.time + RAMP_AIR, ramp: row.time } : null;
        }
        // "P" (a pillar under a pier) is never passable.
        if (result) next.set(`${result.lane}|${result.free.toFixed(2)}|${result.ramp ?? "-"}`, result);
      }
    }
    if (next.size === 0) return { ok: false, at: i, row };
    states = [...next.values()];
    previous = row;
  }
  return { ok: true };
}

test("every generated course can be finished, at every tier and speed", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const course = new Course(seed);
    course.fill(6000);
    const result = solve(course.rows);
    if (!result.ok) {
      const around = course.rows.slice(Math.max(0, result.at - 3), result.at + 1);
      assert.fail(
        `seed ${seed}: stuck at row ${result.at}\n` +
          around.map((r) => `  z=${r.z.toFixed(0)} t=${r.time.toFixed(2)} ${r.cells.join("")}`).join("\n"),
      );
    }
  }
});

test("the solver is not a pushover: it rejects impossible rows", () => {
  const t = (time: number, cells: string) => ({ z: time * 20, time, cells: [...cells] as Row["cells"] });
  assert.equal(solve([t(3, "BBB")]).ok, false, "a wall of boats without a ramp");
  assert.equal(solve([t(3, "PDP"), t(3.6, "PPP")]).ok, false, "all pillars");
  assert.equal(solve([t(3, "LLL"), t(3.2, "HHH")]).ok, false, "duck while still in the air");
  assert.equal(solve([t(3, "BB."), t(3.1, ".BB")]).ok, false, "two lanes over in 0.1 s");
  assert.equal(solve([t(3, "BB."), t(3.7, ".BB")]).ok, true, "two lanes over once the boats are past");
  assert.equal(solve([t(3, "BB."), t(3.4, ".BB")]).ok, false, "boats still alongside: no room to cross");
  assert.equal(solve([t(3, ".J."), t(3 + 0.45, "BBB")]).ok, true, "a ramp clears the wall");
  assert.equal(solve([t(3, ".J."), t(3 + 0.05, "BBB")]).ok, false, "too early: still low");
  assert.equal(solve([t(3, ".J."), t(3 + 0.75, "BBB")]).ok, false, "too late: coming down onto the boats");
});

test("the run opens with one lesson at a time: dodge, jump, duck, ramp", () => {
  const course = new Course(7);
  course.fill(600);
  const first = course.rows.slice(0, 4).map((r) => r.cells.join(""));
  assert.equal(first[0], ".B.");
  assert.equal(first[1], "LLL");
  assert.equal(first[2], "HHH");
  assert.equal(first[3], ".J.");
});

test("rows are spaced in time, never closer than half a second", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const course = new Course(seed);
    course.fill(6000);
    for (let i = 1; i < course.rows.length; i++) {
      const gap = course.rows[i].time - course.rows[i - 1].time;
      const overRamp = course.rows[i - 1].cells.includes("J");
      assert.ok(gap >= (overRamp ? 0.25 : 0.48), `seed ${seed} row ${i}: gap ${gap.toFixed(2)}s`);
    }
  }
});

test("coins and power-ups never sit inside something solid", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const course = new Course(seed);
    const { obstacles, coins, powers } = course.fill(6000);
    const solid = obstacles.filter((o) => SPECS[o.kind].solid && o.vx === undefined && o.vz === undefined);
    const inside = (x: number, y: number, z: number) =>
      solid.some((o) => {
        const s = SPECS[o.kind];
        return Math.abs(x - o.x) < s.halfWidth + 0.3 && z > o.z - 0.3 && z < o.z + s.length + 0.3 && y > s.bottom - 0.3 && y < s.bottom + s.height + 0.3;
      });
    for (const c of coins) assert.ok(!inside(c.x, c.y, c.z), `seed ${seed}: coin at ${c.x},${c.y.toFixed(1)},${c.z.toFixed(1)}`);
    for (const p of powers) assert.ok(!inside(p.x, 1, p.z), `seed ${seed}: ${p.kind} at ${p.x},${p.z.toFixed(1)}`);
    assert.ok(coins.length > 300, "plenty of coins");
    assert.ok(powers.length >= 6, "power-ups show up regularly");
  }
});

test("a wall behind a ramp is cleared front to back at every speed, even 30% slowed", () => {
  for (const speed of [20, 23, 30, 42]) {
    const offset = overRampOffset(speed, "boat");
    const span = SPECS.boat.length + PLAYER.front + PLAYER.back;
    for (const v of [speed, speed * 1.45]) {
      const tIn = offset / v;
      assert.ok(clears(RAMP_VY, 0, tIn, span / v, "boat"), `${speed} m/s course, riding at ${v.toFixed(0)} m/s`);
    }
  }
});

test("every lane change leaves a person time to react", () => {
  for (let seed = 1; seed <= 80; seed++) {
    const course = new Course(seed);
    course.fill(6000);
    for (let i = 1; i < course.rows.length; i++) {
      const [a, b] = [course.rows[i - 1], course.rows[i]];
      const need = crossingTime(a.cells, b.cells, speedAt(a.z));
      assert.ok(b.time - a.time >= need - 0.03, `seed ${seed} row ${i}: ${a.cells.join("")} -> ${b.cells.join("")} in ${(b.time - a.time).toFixed(2)}s, needs ${need.toFixed(2)}s`);
    }
  }
});

test("difficulty rises: later tiers bring new patterns and tighter rows", () => {
  const course = new Course(3);
  course.fill(5000);
  const early = course.rows.filter((r) => r.z < 350);
  const late = course.rows.filter((r) => r.z > 2400);
  assert.ok(!early.some((r) => r.cells.includes("P") || r.cells.includes("T")), "no piers or traffic in the opening");
  const gaps = (rows: Row[]) => rows.slice(1).map((r, i) => r.time - rows[i].time);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(gaps(late)) < mean(gaps(early)) * 0.85, "late rows come faster");
  assert.equal(speedAt(0), 20);
  assert.ok(LANE_X.length === 3);
});
