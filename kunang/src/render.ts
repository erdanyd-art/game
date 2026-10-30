import { POPUP_SECONDS, RING_SECONDS, swarmSpread, type Game } from "./game.ts";
import { STICK_RADIUS, type Stick } from "./input.ts";

const TAU = Math.PI * 2;
/** The darkness layer is soft by nature, so it renders at half resolution. */
const DARK_SCALE = 0.5;

export type Overlay = {
  playing: boolean;
  cursor: { x: number; y: number } | null;
  stick: Stick | null;
  touch: boolean;
};

type View = { x0: number; x1: number; y0: number; y1: number };

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function sprite(size: number, stops: [number, string][]): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  return canvas;
}

export class Renderer {
  readonly cam = { x: 0, y: 0, zoom: 1 };
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dark: HTMLCanvasElement;
  private readonly dctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private shakeX = 0;
  private shakeY = 0;
  private bright = new Float32Array(256);
  private water: CanvasGradient | null = null;
  private vignette: CanvasGradient | null = null;
  private readonly calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly sprites = {
    // Fireflies in the swarm glow warm; wild ones a cooler green, so they read apart.
    warm: sprite(64, [
      [0, "rgba(255,255,225,1)"],
      [0.12, "rgba(240,255,150,0.9)"],
      [0.35, "rgba(210,255,100,0.3)"],
      [1, "rgba(180,255,80,0)"],
    ]),
    wild: sprite(64, [
      [0, "rgba(235,255,240,1)"],
      [0.12, "rgba(170,255,175,0.85)"],
      [0.35, "rgba(110,235,140,0.26)"],
      [1, "rgba(90,220,120,0)"],
    ]),
    amber: sprite(32, [
      [0, "rgba(255,245,200,1)"],
      [0.3, "rgba(255,190,70,0.6)"],
      [1, "rgba(255,160,40,0)"],
    ]),
    red: sprite(32, [
      [0, "rgba(255,225,215,1)"],
      [0.3, "rgba(255,70,50,0.75)"],
      [1, "rgba(255,40,30,0)"],
    ]),
    hole: sprite(256, [
      [0, "rgba(0,0,0,1)"],
      [0.5, "rgba(0,0,0,0.75)"],
      [1, "rgba(0,0,0,0)"],
    ]),
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.dark = document.createElement("canvas");
    this.dctx = this.dark.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.dark.width = Math.ceil(this.w * DARK_SCALE);
    this.dark.height = Math.ceil(this.h * DARK_SCALE);
    // Show about the same area of river on every screen, phone or desktop.
    this.cam.zoom = Math.min(1.35, Math.max(0.55, Math.sqrt((this.w * this.h) / (1150 * 720))));

    const water = this.ctx.createLinearGradient(0, 0, 0, this.h);
    water.addColorStop(0, "#0b2631");
    water.addColorStop(1, "#0f2f38");
    this.water = water;
    const r = Math.hypot(this.w, this.h) / 2;
    const vignette = this.ctx.createRadialGradient(this.w / 2, this.h / 2, r * 0.45, this.w / 2, this.h / 2, r);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.55)");
    this.vignette = vignette;
  }

  snap(game: Game) {
    const target = this.cameraTarget(game);
    this.cam.x = target.x;
    this.cam.y = target.y;
  }

  follow(game: Game, dt: number) {
    const target = this.cameraTarget(game);
    const k = 1 - Math.exp(-dt * 3.2);
    this.cam.x += (target.x - this.cam.x) * k;
    this.cam.y += (target.y - this.cam.y) * k;
    const shake = this.calm ? 0 : game.shake * game.shake * 14;
    this.shakeX = (Math.random() * 2 - 1) * shake;
    this.shakeY = (Math.random() * 2 - 1) * shake;
  }

  screenToWorld(sx: number, sy: number) {
    return {
      x: (sx - this.w / 2) / this.cam.zoom + this.cam.x,
      y: (sy - this.h / 2) / this.cam.zoom + this.cam.y,
    };
  }

  draw(game: Game, overlay: Overlay) {
    const { ctx } = this;
    const phase = game.beatPhase();
    const beatGlow = Math.exp(-phase * 5);
    this.measureBrightness(game, beatGlow);
    const view = this.view();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.water!;
    ctx.fillRect(0, 0, this.w, this.h);

    // The world, mostly hidden by the darkness drawn over it.
    this.toWorld(ctx, this.dpr);
    this.drawRipples(game, view);
    this.drawPads(game, view);
    this.drawFrogs(game);
    this.drawBanks(game, view);
    this.drawTree(game);
    this.drawBats(game);
    this.drawDarkness(game, beatGlow);

    // Light, added on top of the darkness.
    this.toWorld(ctx, this.dpr);
    ctx.globalCompositeOperation = "lighter";
    this.drawTreeGlow(game, beatGlow);
    this.drawFlies(game, view, beatGlow);
    this.drawRings(game);
    this.drawParticles(game);
    this.drawEyes(game);
    this.drawBeatRing(game, phase);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    this.drawSleep(game);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.vignette!;
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawPopups(game);
    if (overlay.playing) this.drawControls(overlay, beatGlow);
  }

  // --- Camera ------------------------------------------------------------

  private cameraTarget(game: Game) {
    const { level, leader } = game;
    let x = leader.x + leader.vx * 0.45;
    let y = leader.y + leader.vy * 0.3;
    if (game.outcome?.kind === "home") {
      x = level.tree.x;
      y = level.tree.y;
    }
    const halfW = this.w / 2 / this.cam.zoom;
    const halfH = this.h / 2 / this.cam.zoom;
    x = Math.min(Math.max(x, -260 + halfW), level.end + 900 - halfW);
    // Keep the banks in view without showing much beyond them.
    const top = level.center(x) - level.half(x) - 200;
    const bottom = level.center(x) + level.half(x) + 200;
    y = bottom - top <= halfH * 2 ? (top + bottom) / 2 : Math.min(Math.max(y, top + halfH), bottom - halfH);
    return { x, y };
  }

  private toWorld(c: CanvasRenderingContext2D, scale: number) {
    const z = this.cam.zoom * scale;
    c.setTransform(
      z,
      0,
      0,
      z,
      (this.w / 2) * scale - (this.cam.x + this.shakeX) * z,
      (this.h / 2) * scale - (this.cam.y + this.shakeY) * z,
    );
  }

  private toScreen(x: number, y: number) {
    return {
      x: (x - this.cam.x) * this.cam.zoom + this.w / 2,
      y: (y - this.cam.y) * this.cam.zoom + this.h / 2,
    };
  }

  private view(): View {
    const halfW = this.w / 2 / this.cam.zoom + 140;
    const halfH = this.h / 2 / this.cam.zoom + 140;
    return { x0: this.cam.x - halfW, x1: this.cam.x + halfW, y0: this.cam.y - halfH, y1: this.cam.y + halfH };
  }

  // --- World -------------------------------------------------------------

  private drawRipples(game: Game, view: View) {
    const { ctx } = this;
    ctx.strokeStyle = "rgb(140,200,210)";
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    for (const r of game.level.ripples) {
      if (r.x < view.x0 || r.x > view.x1 || r.y < view.y0 || r.y > view.y1) continue;
      const sway = Math.sin(game.time * 0.5 + r.phase) * 6;
      ctx.globalAlpha = 0.1 + 0.18 * (0.5 + 0.5 * Math.sin(game.time * 0.8 + r.phase));
      ctx.beginPath();
      ctx.moveTo(r.x - r.len / 2 + sway, r.y);
      ctx.quadraticCurveTo(r.x + sway, r.y - 3, r.x + r.len / 2 + sway, r.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawPads(game: Game, view: View) {
    const { ctx } = this;
    for (const p of game.level.pads) {
      if (p.x < view.x0 || p.x > view.x1 || p.y < view.y0 || p.y > view.y1) continue;
      const y = p.y + Math.sin(game.time * 0.6 + p.bob) * 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x, y);
      ctx.arc(p.x, y, p.r, p.notch + 0.35, p.notch - 0.35 + TAU);
      ctx.closePath();
      ctx.fillStyle = "#123521";
      ctx.fill();
      ctx.strokeStyle = "#1d4a2e";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (p.flower) {
        ctx.fillStyle = "#e48fb3";
        for (let i = 0; i < 5; i++) {
          const a = p.notch + Math.PI + (i / 5) * TAU;
          ctx.beginPath();
          ctx.arc(p.x + Math.cos(a) * 4, y + Math.sin(a) * 4, 3.2, 0, TAU);
          ctx.fill();
        }
        ctx.fillStyle = "#f6e27a";
        ctx.beginPath();
        ctx.arc(p.x, y, 2.4, 0, TAU);
        ctx.fill();
      }
    }
  }

  private drawFrogs(game: Game) {
    const { ctx } = this;
    for (const frog of game.frogs) {
      // Tongue first, so it comes out from under the head.
      if (frog.state === "lash" && frog.reach > 0) {
        const mouthX = frog.x + Math.cos(frog.face) * 16;
        const mouthY = frog.y + Math.sin(frog.face) * 16;
        const tipX = mouthX + (frog.aimX - mouthX) * frog.reach;
        const tipY = mouthY + (frog.aimY - mouthY) * frog.reach;
        ctx.strokeStyle = "#d9667f";
        ctx.lineWidth = 6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(mouthX, mouthY);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();
        ctx.fillStyle = "#e9859a";
        ctx.beginPath();
        ctx.arc(tipX, tipY, 7, 0, TAU);
        ctx.fill();
      }
      ctx.save();
      ctx.translate(frog.x, frog.y);
      ctx.rotate(frog.face);
      const crouch = frog.state === "aim" ? 0.9 : 1;
      ctx.fillStyle = "#25411f";
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(-9, side * 12, 10, 5, side * 0.5, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = "#30552a";
      ctx.beginPath();
      ctx.ellipse(0, 0, 16 * crouch, 13, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(11, 0, 9, 10.5, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#213c1c";
      for (const [x, y, r] of [
        [-5, -4, 3],
        [-2, 5, 2.5],
        [4, -1, 2],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawBanks(game: Game, view: View) {
    const { ctx } = this;
    const { center, half } = game.level;
    const x0 = Math.floor(view.x0 / 24) * 24;

    // Prop roots reach from the bank into the water.
    ctx.strokeStyle = "#142a1e";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const r of game.level.roots) {
      if (r.x < view.x0 || r.x > view.x1) continue;
      const edge = center(r.x) + r.side * half(r.x);
      ctx.moveTo(r.x, edge + r.side * 8);
      ctx.quadraticCurveTo(r.x + r.width / 2, edge - r.side * r.reach, r.x + r.width, edge + r.side * 6);
    }
    ctx.stroke();

    ctx.fillStyle = "#050e0a";
    for (const side of [-1, 1] as const) {
      const far = side < 0 ? view.y0 - 400 : view.y1 + 400;
      ctx.beginPath();
      ctx.moveTo(x0, far);
      for (let x = x0; x <= view.x1 + 24; x += 24) ctx.lineTo(x, center(x) + side * half(x));
      ctx.lineTo(view.x1 + 24, far);
      ctx.closePath();
      ctx.fill();
    }
    for (const c of game.level.canopy) {
      if (c.x < view.x0 - c.r || c.x > view.x1 + c.r) continue;
      ctx.fillStyle = c.shade > 0.5 ? "#0c2117" : "#0a1a12";
      ctx.beginPath();
      ctx.arc(c.x, center(c.x) + c.side * (half(c.x) + c.depth), c.r, 0, TAU);
      ctx.fill();
    }

    for (const cap of game.level.caps) {
      const visible = cap.dir < 0 ? view.x0 < cap.x + 100 : view.x1 > cap.x - 100;
      if (!visible) continue;
      ctx.fillStyle = "#050e0a";
      const far = cap.dir < 0 ? view.x0 - 200 : view.x1 + 200;
      ctx.fillRect(Math.min(cap.x, far), view.y0, Math.abs(far - cap.x), view.y1 - view.y0);
      for (const b of cap.blobs) {
        if (b.y < view.y0 - b.r || b.y > view.y1 + b.r) continue;
        ctx.fillStyle = b.shade > 0.5 ? "#0c2117" : "#0a1a12";
        ctx.beginPath();
        ctx.arc(cap.x + cap.dir * b.depth, b.y, b.r, 0, TAU);
        ctx.fill();
      }
    }
  }

  private drawTree(game: Game) {
    const { ctx } = this;
    const { x, y } = game.level.tree;
    if (Math.abs(x - this.cam.x) > this.w / this.cam.zoom + 400) return;
    ctx.strokeStyle = "#1c1611";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU;
      const reach = 215 + (i % 3) * 18;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * 120, y + Math.sin(a) * 102);
      ctx.quadraticCurveTo(
        x + Math.cos(a + 0.15) * (reach + 20),
        y + Math.sin(a + 0.15) * (reach + 20) * 0.85,
        x + Math.cos(a + 0.25) * reach,
        y + Math.sin(a + 0.25) * reach * 0.85,
      );
      ctx.stroke();
    }
    for (const b of game.level.treeCanopy) {
      ctx.fillStyle = b.shade > 0.5 ? "#0f2c1c" : "#0b2316";
      ctx.beginPath();
      ctx.arc(x + b.dx, y + b.dy, b.r, 0, TAU);
      ctx.fill();
    }
    // Moonlit tops give the canopy some volume.
    ctx.fillStyle = "rgba(60,110,80,0.14)";
    for (const b of game.level.treeCanopy) {
      ctx.beginPath();
      ctx.arc(x + b.dx - b.r * 0.18, y + b.dy - b.r * 0.2, b.r * 0.72, 0, TAU);
      ctx.fill();
    }
  }

  private drawBats(game: Game) {
    const { ctx } = this;
    ctx.fillStyle = "#06070a";
    for (const bat of game.bats) {
      const heading = Math.atan2(bat.vy, bat.vx);
      const flap = Math.sin(game.time * (bat.state === "dive" ? 28 : 15) + bat.angle * 3);
      ctx.save();
      ctx.translate(bat.x, bat.y);
      ctx.rotate(heading);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.quadraticCurveTo(-2, side * (10 + flap * 4), -10, side * (27 + flap * 7));
        ctx.lineTo(-5, side * (19 + flap * 4));
        ctx.lineTo(-13, side * 15);
        ctx.lineTo(-6, side * 6);
        ctx.closePath();
        ctx.fill();
      }
      ctx.beginPath();
      ctx.ellipse(0, 0, 11, 5.5, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  // --- Light -------------------------------------------------------------

  private measureBrightness(game: Game, beatGlow: number) {
    const flies = game.flies;
    if (this.bright.length < flies.length) this.bright = new Float32Array(flies.length * 2);
    const sync = game.sync;
    for (let i = 0; i < flies.length; i++) {
      const f = flies[i];
      // A firefly's own blink: dark most of the time, a brief bright flash.
      const own = Math.pow(0.5 + 0.5 * Math.sin((game.time * f.rate * 1.3 + f.phase) * TAU), 8);
      let b: number;
      if (f.state === "swarm" || f.state === "joining") {
        // In sync, the whole swarm blinks on the beat; out of sync, each blinks alone.
        b = 0.32 + 0.68 * (own * (1 - sync) + beatGlow * sync);
      } else if (f.state === "home") {
        b = 0.4 + 0.6 * beatGlow;
      } else {
        // Wild fireflies being won over start answering on the beat.
        b = 0.08 + 0.92 * (own * (1 - f.trust) + beatGlow * f.trust);
      }
      this.bright[i] = Math.max(b, f.glow);
    }
  }

  private drawDarkness(game: Game, beatGlow: number) {
    const d = this.dctx;
    const { leader, level } = game;
    const morning = smoothstep(0.72, 1, game.dawn);
    d.setTransform(1, 0, 0, 1, 0, 0);
    d.globalCompositeOperation = "source-over";
    d.globalAlpha = 1;
    d.clearRect(0, 0, this.dark.width, this.dark.height);
    const r = Math.round(3 + morning * 40);
    const g = Math.round(6 + morning * 22);
    const b = Math.round(14 + morning * 45);
    d.fillStyle = `rgba(${r},${g},${b},${0.86 - morning * 0.3})`;
    d.fillRect(0, 0, this.dark.width, this.dark.height);

    d.globalCompositeOperation = "destination-out";
    this.toWorld(d, DARK_SCALE);
    const hole = (x: number, y: number, radius: number, alpha: number) => {
      d.globalAlpha = alpha;
      d.drawImage(this.sprites.hole, x - radius, y - radius, radius * 2, radius * 2);
    };
    if (game.swarmSize > 0) hole(leader.x, leader.y, game.lightRadius * 2, 1);
    if (game.flashGlow > 0) hole(leader.x, leader.y, game.flashRadius * 1.6, game.flashGlow * 0.85);
    for (let i = 0; i < game.flies.length; i++) {
      const f = game.flies[i];
      if (f.state === "wild" || f.state === "stray") {
        if (this.bright[i] > 0.2) hole(f.x, f.y, 70, this.bright[i] * 0.75);
      } else if (f.state === "joining") {
        hole(f.x, f.y, 40, 0.6);
      }
    }
    // The tree glows faintly from afar: a beacon to steer by.
    const lit = game.outcome?.kind === "home";
    hole(level.tree.x, level.tree.y, lit ? 560 : 300, lit ? 1 : 0.26 + 0.1 * beatGlow);

    d.globalCompositeOperation = "source-over";
    d.globalAlpha = 1;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.dark, 0, 0, this.canvas.width, this.canvas.height);
  }

  private drawFlies(game: Game, view: View, beatGlow: number) {
    const { ctx } = this;
    const { warm, wild } = this.sprites;
    // A soft lantern-glow around the swarm, swelling on the beat when in sync.
    if (game.swarmSize > 0) {
      const { leader } = game;
      const aura = swarmSpread(game.swarmSize) * (2.6 + 0.8 * beatGlow * game.sync);
      ctx.globalAlpha = 0.12 + 0.14 * game.sync * beatGlow + 0.25 * game.flashGlow;
      ctx.drawImage(warm, leader.x - aura, leader.y - aura, aura * 2, aura * 2);
    }
    for (let i = 0; i < game.flies.length; i++) {
      const f = game.flies[i];
      if (f.x < view.x0 || f.x > view.x1 || f.y < view.y0 || f.y > view.y1) continue;
      const b = this.bright[i];
      const size = 14 + 30 * b;
      ctx.globalAlpha = 0.3 + 0.7 * b;
      const loyal = (f.state !== "wild" && f.state !== "stray") || f.trust > 0.5;
      ctx.drawImage(loyal ? warm : wild, f.x - size / 2, f.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  /** Once the swarm is home, the whole tree breathes light on the beat. */
  private drawTreeGlow(game: Game, beatGlow: number) {
    if (game.outcome?.kind !== "home") return;
    const { ctx } = this;
    const { x, y } = game.level.tree;
    const home = game.outcome.delivered;
    const r = 260 + 3 * home;
    ctx.globalAlpha = Math.min(0.5, 0.12 + home / 300) * (0.75 + 0.25 * beatGlow);
    ctx.drawImage(this.sprites.warm, x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  private drawRings(game: Game) {
    const { ctx } = this;
    ctx.strokeStyle = "rgb(240,255,175)";
    for (const ring of game.rings) {
      const p = ring.t / RING_SECONDS;
      ctx.globalAlpha = (1 - p) * 0.7;
      ctx.lineWidth = 4 * (1 - p) + 1;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.radius * (1 - (1 - p) ** 3), 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawParticles(game: Game) {
    const { ctx } = this;
    for (const p of game.particles) {
      if (p.kind === "z") continue;
      const life = p.life / p.max;
      const size = p.size * (p.kind === "spark" ? life : 0.6 + life);
      ctx.globalAlpha = life * (p.kind === "spark" ? 0.9 : 0.7);
      ctx.drawImage(p.kind === "spark" ? this.sprites.warm : this.sprites.amber, p.x - size, p.y - size, size * 2, size * 2);
    }
    ctx.globalAlpha = 1;
  }

  private drawEyes(game: Game) {
    const { ctx } = this;
    const { amber, red } = this.sprites;
    for (const frog of game.frogs) {
      if (frog.state === "stun") continue;
      const aiming = frog.state === "aim" || frog.state === "lash";
      const hx = frog.x + Math.cos(frog.face) * 13;
      const hy = frog.y + Math.sin(frog.face) * 13;
      const px = -Math.sin(frog.face) * 6;
      const py = Math.cos(frog.face) * 6;
      const size = aiming ? 24 + 6 * Math.sin(game.time * 30) : 12;
      ctx.globalAlpha = aiming ? 1 : 0.5 + 0.2 * Math.sin(game.time * 0.7 + frog.x);
      for (const s of [1, -1]) {
        ctx.drawImage(aiming ? red : amber, hx + px * s - size / 2, hy + py * s - size / 2, size, size);
      }
      if (frog.state === "aim") {
        // Where the tongue will land: step out of the circle before it locks.
        const urgency = 1 - frog.t / frog.aimTotal;
        ctx.globalAlpha = 0.2 + 0.5 * urgency;
        ctx.strokeStyle = "rgb(255,90,70)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(frog.aimX, frog.aimY, 38, 0, TAU);
        ctx.stroke();
      }
    }
    for (const bat of game.bats) {
      const heading = Math.atan2(bat.vy, bat.vx);
      const size = bat.state === "windup" ? 18 + 5 * Math.sin(game.time * 40) : 9;
      ctx.globalAlpha = bat.state === "flee" ? 0.4 : 0.9;
      for (const s of [1, -1]) {
        const ex = bat.x + Math.cos(heading) * 7 - Math.sin(heading) * 3 * s;
        const ey = bat.y + Math.sin(heading) * 7 + Math.cos(heading) * 3 * s;
        ctx.drawImage(red, ex - size / 2, ey - size / 2, size, size);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** A ring falls inward each beat and lands on the edge of the light exactly on the beat. */
  private drawBeatRing(game: Game, phase: number) {
    if (game.outcome || game.swarmSize === 0 || game.demo) return;
    const { ctx } = this;
    const { leader } = game;
    const radius = Math.max(game.lightRadius, swarmSpread(game.swarmSize) + 30);
    ctx.strokeStyle = "rgb(240,255,190)";
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.06 + 0.32 * phase * phase;
    ctx.beginPath();
    ctx.arc(leader.x, leader.y, radius + 90 * (1 - phase), 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.5 * Math.exp(-phase * 7);
    ctx.beginPath();
    ctx.arc(leader.x, leader.y, radius, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Stunned frogs: closed eyes and a drift of z's. */
  private drawSleep(game: Game) {
    const { ctx } = this;
    ctx.fillStyle = "rgb(190,215,255)";
    ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    for (const p of game.particles) {
      if (p.kind !== "z") continue;
      ctx.globalAlpha = (p.life / p.max) * 0.85;
      ctx.fillText("z", p.x, p.y);
    }
    ctx.strokeStyle = "rgba(255,200,120,0.6)";
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 1;
    for (const frog of game.frogs) {
      if (frog.state !== "stun") continue;
      const hx = frog.x + Math.cos(frog.face) * 13;
      const hy = frog.y + Math.sin(frog.face) * 13;
      const px = -Math.sin(frog.face) * 6;
      const py = Math.cos(frog.face) * 6;
      ctx.beginPath();
      for (const s of [1, -1]) {
        ctx.moveTo(hx + px * s - 2.5, hy + py * s);
        ctx.lineTo(hx + px * s + 2.5, hy + py * s);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // --- Screen ------------------------------------------------------------

  private drawPopups(game: Game) {
    const { ctx } = this;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const colors = { great: "#f6ffb0", good: "#d5f5c8", bad: "#ff9585" };
    for (const p of game.popups) {
      const s = this.toScreen(p.x, p.y - p.t * 34);
      const size = p.tone === "great" ? 22 : 18;
      ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
      ctx.globalAlpha = 1 - (p.t / POPUP_SECONDS) ** 2;
      ctx.shadowColor = p.tone === "bad" ? "rgba(255,80,60,0.6)" : "rgba(220,255,120,0.7)";
      ctx.shadowBlur = 12;
      ctx.fillStyle = colors[p.tone];
      ctx.fillText(p.text, s.x, s.y);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  private drawControls(overlay: Overlay, beatGlow: number) {
    const { ctx } = this;
    if (!overlay.touch) {
      if (!overlay.cursor) return;
      ctx.strokeStyle = "rgba(240,255,190,0.55)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(overlay.cursor.x, overlay.cursor.y, 9, 0, TAU);
      ctx.stroke();
      return;
    }
    // Touch: the stick where the thumb landed, and the flash zone pulsing on the beat.
    const stick = overlay.stick;
    const base = stick ? { x: stick.ox, y: stick.oy } : { x: this.w * 0.2, y: this.h - 110 };
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.strokeStyle = `rgba(255,255,255,${stick ? 0.22 : 0.1})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(base.x, base.y, STICK_RADIUS, 0, TAU);
    ctx.fill();
    ctx.stroke();
    if (stick) {
      const dx = stick.x - stick.ox;
      const dy = stick.y - stick.oy;
      const d = Math.hypot(dx, dy);
      const m = d > STICK_RADIUS ? STICK_RADIUS / d : 1;
      ctx.fillStyle = "rgba(240,255,190,0.28)";
      ctx.beginPath();
      ctx.arc(stick.ox + dx * m, stick.oy + dy * m, 22, 0, TAU);
      ctx.fill();
    }
    const fx = this.w - 86;
    const fy = this.h - 110;
    ctx.strokeStyle = `rgba(240,255,190,${0.18 + 0.45 * beatGlow})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(fx, fy, 46, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `rgba(240,255,190,${0.35 + 0.5 * beatGlow})`;
    ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("KEDIP", fx, fy);
  }
}
