export type Judgement = "perfect" | "good" | "miss";

// Seconds either side of a beat. Generous on purpose: this is a calm game, and
// browsers add a few milliseconds between a key press and its event.
export const PERFECT_WINDOW = 0.08;
export const GOOD_WINDOW = 0.16;

export type Tap = { beat: number; offset: number; judgement: Judgement };

/** Judges a tap against the nearest beat. `offset` is negative when early. */
export function judgeTap(time: number, start: number, secondsPerBeat: number): Tap {
  const position = (time - start) / secondsPerBeat;
  const beat = Math.round(position);
  const offset = (position - beat) * secondsPerBeat;
  const distance = Math.abs(offset);
  const judgement: Judgement =
    distance <= PERFECT_WINDOW ? "perfect" : distance <= GOOD_WINDOW ? "good" : "miss";
  return { beat, offset, judgement };
}

/** The last beat at or before `time`, and how far (0 to 1) it is towards the next. */
export function beatAt(time: number, start: number, secondsPerBeat: number) {
  const position = (time - start) / secondsPerBeat;
  const beat = Math.floor(position);
  return { beat, phase: position - beat };
}
