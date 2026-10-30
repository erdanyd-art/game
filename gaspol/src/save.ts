export type Skin = {
  id: string;
  name: string;
  price: number;
  hull: string;
  stripe: string;
  vest: string;
  helmet: string;
};

export const SKINS: readonly Skin[] = [
  { id: "klasik", name: "Klasik", price: 0, hull: "#f4f6f8", stripe: "#e63946", vest: "#ff8c1a", helmet: "#1d3557" },
  { id: "senja", name: "Senja Bali", price: 400, hull: "#ff7b54", stripe: "#ffd56b", vest: "#2a9d8f", helmet: "#fff4e0" },
  { id: "karang", name: "Karang Biru", price: 1200, hull: "#13b5d8", stripe: "#03045e", vest: "#ffd60a", helmet: "#ff006e" },
  { id: "emas", name: "Emas", price: 3000, hull: "#ffd166", stripe: "#3a2e05", vest: "#1b1b1b", helmet: "#ffd166" },
];

import { freshMissions, readMissions, type MissionState } from "./missions.ts";

export type Save = {
  best: number;
  coins: number;
  owned: string[];
  skin: string;
  muted: boolean;
  /** Runs started: the first run shows how to play. */
  runs: number;
  missions: MissionState;
  /** Graphics: decided by the device, or forced high or low. */
  quality: Quality;
};

export const QUALITIES = ["auto", "high", "low"] as const;
export type Quality = (typeof QUALITIES)[number];

const KEY = "gaspol.save.v1";
const fresh = (): Save => ({ best: 0, coins: 0, owned: ["klasik"], skin: "klasik", muted: false, runs: 0, missions: freshMissions(), quality: "auto" });
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

// Storage can be blocked, cleared or hand-edited; anything odd falls back to defaults.
export function loadSave(): Save {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return fresh();
    const r = raw as Record<string, unknown>;
    const ids = new Set(SKINS.map((s) => s.id));
    const owned = Array.isArray(r.owned) ? r.owned.filter((id): id is string => typeof id === "string" && ids.has(id)) : [];
    if (!owned.includes("klasik")) owned.unshift("klasik");
    const skin = typeof r.skin === "string" && owned.includes(r.skin) ? r.skin : "klasik";
    return {
      best: count(r.best),
      coins: count(r.coins),
      owned,
      skin,
      muted: r.muted === true,
      runs: count(r.runs),
      missions: readMissions(r.missions) ?? freshMissions(),
      quality: QUALITIES.includes(r.quality as Quality) ? (r.quality as Quality) : "auto",
    };
  } catch {
    return fresh();
  }
}

export function writeSave(save: Save) {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {}
}

export const skinById = (id: string) => SKINS.find((s) => s.id === id) ?? SKINS[0];
