/** Steering in screen terms; main turns a point into world coordinates. */
export type ScreenSteer =
  | { kind: "point"; sx: number; sy: number }
  | { kind: "direction"; x: number; y: number };

export type Stick = { ox: number; oy: number; x: number; y: number };

const FLASH_KEYS = new Set(["Space", "KeyJ", "KeyK", "KeyF"]);
const DIRECTIONS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  KeyW: [0, -1],
  ArrowDown: [0, 1],
  KeyS: [0, 1],
  ArrowLeft: [-1, 0],
  KeyA: [-1, 0],
  ArrowRight: [1, 0],
  KeyD: [1, 0],
};
export const STICK_RADIUS = 56;

/**
 * Mouse: the swarm follows the cursor, click to flash.
 * Keys: WASD or arrows to move, Space (or J, K, F) to flash.
 * Touch: a floating stick on the left half, tap the right half to flash.
 */
export class Input {
  /** Only while playing do keys belong to the game rather than the page. */
  enabled = false;
  /** Starts from the device's primary pointer, then follows whatever was used last. */
  touch = matchMedia("(pointer: coarse)").matches;
  private mode: "mouse" | "keys" | "touch" = this.touch ? "touch" : "mouse";
  private pointer: { x: number; y: number } | null = null;
  private keys = new Set<string>();
  private stick: (Stick & { id: number }) | null = null;
  private flashes: number[] = [];
  private pauseWanted = false;
  private muteWanted = false;
  private readonly clock: () => number;

  constructor(surface: HTMLElement, clock: () => number) {
    this.clock = clock;
    surface.addEventListener("pointerdown", (e) => this.down(e));
    surface.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("pointermove", (e) => this.move(e));
    window.addEventListener("pointerup", (e) => this.up(e));
    window.addEventListener("pointercancel", (e) => this.up(e));
    window.addEventListener("keydown", (e) => this.key(e));
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.release());
  }

  /** Flash times on the game clock, oldest first. */
  takeFlashes(): number[] {
    const flashes = this.flashes;
    this.flashes = [];
    return flashes;
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

  steer(): ScreenSteer | null {
    if (this.mode === "touch") {
      if (!this.stick) return { kind: "direction", x: 0, y: 0 };
      const dx = this.stick.x - this.stick.ox;
      const dy = this.stick.y - this.stick.oy;
      const d = Math.hypot(dx, dy);
      if (d < 6) return { kind: "direction", x: 0, y: 0 };
      const m = Math.min(1, d / STICK_RADIUS);
      return { kind: "direction", x: (dx / d) * m, y: (dy / d) * m };
    }
    if (this.mode === "keys") {
      let x = 0;
      let y = 0;
      for (const code of this.keys) {
        x += DIRECTIONS[code][0];
        y += DIRECTIONS[code][1];
      }
      const d = Math.hypot(x, y);
      return { kind: "direction", x: d ? x / d : 0, y: d ? y / d : 0 };
    }
    return this.pointer ? { kind: "point", sx: this.pointer.x, sy: this.pointer.y } : null;
  }

  /** What to draw: the mouse cursor (only when steering with it) and the touch stick. */
  view() {
    return {
      cursor: this.mode === "mouse" ? this.pointer : null,
      stick: this.stick as Stick | null,
      touch: this.touch,
    };
  }

  /** Drops anything pressed while the game was not listening. */
  reset() {
    this.flashes = [];
    this.pauseWanted = false;
    this.release();
  }

  private release() {
    this.keys.clear();
    this.stick = null;
  }

  private flash() {
    if (this.enabled) this.flashes.push(this.clock());
  }

  private down(e: PointerEvent) {
    if (e.pointerType === "mouse") {
      this.mode = "mouse";
      this.touch = false;
      this.pointer = { x: e.clientX, y: e.clientY };
      if (e.button === 0) this.flash();
      return;
    }
    e.preventDefault();
    this.touch = true;
    this.mode = "touch";
    if (e.clientX < window.innerWidth / 2 && !this.stick) {
      this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
    } else {
      this.flash();
    }
  }

  private move(e: PointerEvent) {
    if (e.pointerType === "mouse") {
      const last = this.pointer;
      this.pointer = { x: e.clientX, y: e.clientY };
      // A real mouse movement takes over from the keyboard; a nudge does not.
      if (this.mode === "keys" && last && Math.hypot(e.clientX - last.x, e.clientY - last.y) > 12) {
        this.mode = "mouse";
      }
      if (this.mode === "keys" && !last) this.mode = "mouse";
      return;
    }
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick.x = e.clientX;
      this.stick.y = e.clientY;
    }
  }

  private up(e: PointerEvent) {
    if (this.stick && e.pointerId === this.stick.id) this.stick = null;
  }

  private key(e: KeyboardEvent) {
    if (e.code === "Escape" || e.code === "KeyP") {
      if (!e.repeat) this.pauseWanted = true;
      return;
    }
    if (e.code === "KeyM") {
      if (!e.repeat) this.muteWanted = true;
      return;
    }
    if (!this.enabled) return;
    if (FLASH_KEYS.has(e.code)) {
      e.preventDefault();
      if (!e.repeat) this.flash();
    } else if (e.code in DIRECTIONS) {
      e.preventDefault();
      this.keys.add(e.code);
      this.mode = "keys";
    }
  }
}
