import type { Action } from "./game.ts";

const KEYS: Record<string, Action> = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  ArrowUp: "up",
  KeyW: "up",
  Space: "up",
  ArrowDown: "down",
  KeyS: "down",
  ShiftLeft: "nitro",
  ShiftRight: "nitro",
  KeyE: "nitro",
  KeyN: "nitro",
};
/** A drag this long counts as a swipe; each further stretch of it is another. */
const SWIPE = 30;
const TAP_MS = 250;

/**
 * Keys: arrows or WASD, Space to jump, Shift for nitro.
 * Touch (or mouse drag): swipe in any direction; tap does a flip in the air.
 * Swipes fire as soon as the finger has moved far enough, not on release.
 */
export class Input {
  enabled = false;
  readonly touch = matchMedia("(pointer: coarse)").matches;
  private actions: Action[] = [];
  private drag: { id: number; x: number; y: number; t: number; swiped: boolean } | null = null;
  private pauseWanted = false;
  private muteWanted = false;
  private confirmWanted = false;

  constructor(surface: HTMLElement) {
    window.addEventListener("keydown", (e) => this.key(e));
    surface.addEventListener("pointerdown", (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), swiped: false };
    });
    window.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id || !this.enabled) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE) return;
      this.actions.push(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down");
      // Keep tracking from here, so one long drag can cross two lanes.
      d.x = e.clientX;
      d.y = e.clientY;
      d.swiped = true;
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      if (this.enabled && !d.swiped && performance.now() - d.t < TAP_MS) this.actions.push("tap");
      this.drag = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", () => (this.drag = null));
    window.addEventListener("blur", () => (this.drag = null));
  }

  /** From an on-screen button, such as nitro on touch screens. */
  push(action: Action) {
    if (this.enabled) this.actions.push(action);
  }

  take(): Action[] {
    const actions = this.actions;
    this.actions = [];
    return actions;
  }

  consumePause() {
    const wanted = this.pauseWanted;
    this.pauseWanted = false;
    return wanted;
  }

  consumeMute() {
    const wanted = this.muteWanted;
    this.muteWanted = false;
    return wanted;
  }

  /** Enter or Space on a menu: play (again). */
  consumeConfirm() {
    const wanted = this.confirmWanted;
    this.confirmWanted = false;
    return wanted;
  }

  reset() {
    this.actions = [];
    this.drag = null;
    this.pauseWanted = false;
    this.confirmWanted = false;
  }

  private key(e: KeyboardEvent) {
    if (e.repeat) return;
    if (e.code === "Escape" || e.code === "KeyP") {
      this.pauseWanted = true;
      return;
    }
    if (e.code === "KeyM") {
      this.muteWanted = true;
      return;
    }
    if (!this.enabled) {
      // Let focused buttons handle their own Enter/Space.
      const onButton = document.activeElement instanceof HTMLButtonElement;
      if ((e.code === "Enter" || e.code === "Space") && !onButton) this.confirmWanted = true;
      return;
    }
    const action = KEYS[e.code];
    if (action) {
      e.preventDefault();
      this.actions.push(action);
    }
  }
}
