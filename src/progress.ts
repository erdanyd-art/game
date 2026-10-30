import { NIGHTS } from "./nights.ts";

export type Progress = {
  /** Best stars per night, 0 to 3. */
  stars: number[];
  muted: boolean;
};

const KEY = "kunang.progress.v1";

const fresh = (): Progress => ({ stars: NIGHTS.map(() => 0), muted: false });

// Progress is a convenience: storage can be blocked or cleared, and a hand-edited
// value must not break the game, so anything unexpected falls back to a fresh start.
export function loadProgress(): Progress {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return fresh();
    const { stars, muted } = raw as Record<string, unknown>;
    return {
      stars: NIGHTS.map((_, i) => {
        const value = Array.isArray(stars) ? stars[i] : 0;
        return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 0;
      }),
      muted: muted === true,
    };
  } catch {
    return fresh();
  }
}

export function saveProgress(progress: Progress) {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {}
}

/** A night opens once the one before it has been finished with at least one star. */
export function isUnlocked(progress: Progress, index: number) {
  return index === 0 || progress.stars[index - 1] > 0;
}
