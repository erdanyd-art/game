import { COMBO_STEP, type Outcome } from "./game.ts";

// Three goals at a time. Most must be done within one run; some add up across
// runs. A finished goal pays coins and the next one in the list takes its place;
// after the list runs out it starts again with bigger targets.

export type MissionKind = "coins" | "tricks" | "near" | "distance" | "escapes" | "powers" | "smashes" | "combo";
export type Mission = { kind: MissionKind; target: number; reward: number; total: boolean };
export type MissionSlot = { n: number; progress: number };
export type MissionState = { next: number; active: MissionSlot[] };

const LIST: Mission[] = [
  { kind: "coins", target: 50, reward: 100, total: false },
  { kind: "tricks", target: 2, reward: 150, total: false },
  { kind: "near", target: 5, reward: 150, total: false },
  { kind: "distance", target: 1000, reward: 200, total: false },
  { kind: "escapes", target: 1, reward: 300, total: false },
  { kind: "powers", target: 3, reward: 200, total: false },
  { kind: "coins", target: 500, reward: 250, total: true },
  { kind: "smashes", target: 4, reward: 250, total: false },
  { kind: "combo", target: 24, reward: 250, total: false },
  { kind: "tricks", target: 15, reward: 300, total: true },
  { kind: "distance", target: 2500, reward: 400, total: false },
  { kind: "near", target: 12, reward: 350, total: false },
  { kind: "escapes", target: 3, reward: 450, total: true },
  { kind: "combo", target: 48, reward: 500, total: false },
];

export function missionAt(n: number): Mission {
  const lap = Math.floor(n / LIST.length);
  const m = LIST[n % LIST.length];
  // Combo tops out at ×3 (48), so it does not grow.
  const target = m.kind === "combo" ? m.target : Math.round(m.target * (1 + lap));
  return { ...m, target, reward: Math.round(m.reward * (1 + lap * 0.5)) };
}

const fmt = (n: number) => n.toLocaleString("id-ID");

export function describe(m: Mission): string {
  const run = m.total ? "" : " dalam satu run";
  switch (m.kind) {
    case "coins":
      return m.total ? `Kumpulkan ${fmt(m.target)} koin total` : `Kumpulkan ${fmt(m.target)} koin${run}`;
    case "tricks":
      return `Salto ${m.target} kali${m.total ? " total" : run}`;
    case "near":
      return `Nyaris ${m.target} kali${run}`;
    case "distance":
      return `Tempuh ${fmt(m.target)} m${run}`;
    case "escapes":
      return m.target === 1 && !m.total ? "Lolos dari kejaran Polairud" : `Lolos dari Polairud ${m.target} kali${m.total ? " total" : run}`;
    case "powers":
      return `Ambil ${m.target} power-up${run}`;
    case "smashes":
      return `Hancurkan ${m.target} rintangan dengan nitro`;
    case "combo":
      return `Capai kombo ×${1 + Math.floor(m.target / COMBO_STEP) * 0.5}`;
  }
}

export function statValue(kind: MissionKind, o: Outcome): number {
  switch (kind) {
    case "coins":
      return o.coins;
    case "tricks":
      return o.tricks;
    case "near":
      return o.nearMisses;
    case "distance":
      return o.distance;
    case "escapes":
      return o.escapes;
    case "powers":
      return o.powers;
    case "smashes":
      return o.smashes;
    case "combo":
      return o.bestCombo;
  }
}

/** How far a goal has got, counting this run so far. */
export function progressOf(slot: MissionSlot, o: Outcome): number {
  const m = missionAt(slot.n);
  const v = statValue(m.kind, o);
  return m.total ? slot.progress + v : v;
}

export const freshMissions = (): MissionState => ({
  next: 3,
  active: [0, 1, 2].map((n) => ({ n, progress: 0 })),
});

/** At the end of a run: bank running totals, swap finished goals for new ones, and pay out. */
export function settle(state: MissionState, o: Outcome): { done: Mission[]; reward: number } {
  const done: Mission[] = [];
  let reward = 0;
  state.active = state.active.map((slot) => {
    const m = missionAt(slot.n);
    const p = progressOf(slot, o);
    if (p >= m.target) {
      done.push(m);
      reward += m.reward;
      return { n: state.next++, progress: 0 };
    }
    return { n: slot.n, progress: m.total ? p : 0 };
  });
  return { done, reward };
}

/** Accepts only a well-formed saved state. */
export function readMissions(raw: unknown): MissionState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (!ok(r.next) || !Array.isArray(r.active) || r.active.length !== 3) return null;
  const active: MissionSlot[] = [];
  for (const slot of r.active) {
    if (typeof slot !== "object" || slot === null) return null;
    const s = slot as Record<string, unknown>;
    if (!ok(s.n) || !ok(s.progress)) return null;
    active.push({ n: s.n, progress: s.progress });
  }
  return { next: r.next, active };
}
