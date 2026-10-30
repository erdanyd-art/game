import { SPECS } from "./config.ts";
import type { PowerKind } from "./course.ts";
import { POPUP_SECONDS, type Game, type Obstacle, type Particle } from "./game.ts";
import type { Skin } from "./save.ts";

// Pseudo-3D: every world point (x, y, z) is projected from a camera behind and
// above the jetski. Sprites are drawn in metres after translating to their
// projected base and scaling by pixels-per-metre at that depth.

const TAU = Math.PI * 2;
const DRAW_DISTANCE = 190;
const NEAR = 0.8;
/** Closer than this a sprite would fill the screen: things that have passed are left out. */
const CLOSE = 3;
const SHORE = 8.5;
const DECOR_STEP = 11;

type Point = { x: number; y: number; s: number };
type Drawable = { z: number; draw: () => void };

/** Deterministic 0..1 noise from integers: the same palm stands in the same place every frame. */
function hash(a: number, b = 0) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

const NPC_SKINS: Skin[] = [
  { id: "npc1", name: "", price: 0, hull: "#4cc9f0", stripe: "#f72585", vest: "#f9c74f", helmet: "#ffffff" },
  { id: "npc2", name: "", price: 0, hull: "#90be6d", stripe: "#277da1", vest: "#f94144", helmet: "#222222" },
  { id: "npc3", name: "", price: 0, hull: "#f8961e", stripe: "#ffffff", vest: "#577590", helmet: "#f3722c" },
];
const SAILS = ["#e63946", "#ffb703", "#ffffff", "#2a9d8f"];
const HULLS = ["#ffffff", "#fff1c2", "#bde0fe"];
const FLAGS = ["#e63946", "#ffd166", "#06d6a0", "#118ab2", "#f78c6b"];
const UMBRELLAS = [
  ["#ef476f", "#ffffff"],
  ["#118ab2", "#ffd166"],
  ["#06d6a0", "#ffffff"],
  ["#f78c6b", "#073b4c"],
];

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private horizon = 0;
  private focal = 0;
  private camHeight = 3;
  private camX = 0;
  private camY = 3;
  private camZ = -6;
  private camBack = 6;
  private roll = 0;
  private shakeX = 0;
  private shakeY = 0;
  private time = 0;
  private readonly calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    // Frame the three lanes to fill the width on phones and sit centred on wide
    // screens, with the jetski at 80% of the height whatever the shape.
    const portrait = this.h > this.w;
    this.horizon = this.h * (portrait ? 0.3 : 0.38);
    const perMetre = Math.min(0.92 * this.w, 0.95 * this.h) / 7.2;
    this.focal = perMetre * this.camBack;
    this.camHeight = (this.h * 0.8 - this.horizon) / perMetre;
  }

  draw(game: Game, skin: Skin, dt: number) {
    this.time += dt;
    const p = game.player;
    const back = this.camBack + (p.boost > 0 ? 0.9 : 0);
    this.camZ = p.z - back;
    this.camX += (p.x * 0.7 - this.camX) * Math.min(1, dt * 6);
    this.camY = this.camHeight + p.y * 0.45;
    this.roll += (-p.bank * 0.07 - this.roll) * Math.min(1, dt * 8);
    const shake = this.calm ? 0 : game.shake * game.shake * 12;
    this.shakeX = (Math.random() * 2 - 1) * shake;
    this.shakeY = (Math.random() * 2 - 1) * shake;

    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    // Roll and shake the whole world around a point near the jetski.
    const pivotY = this.h * 0.8;
    ctx.translate(this.w / 2 + this.shakeX, pivotY + this.shakeY);
    ctx.rotate(this.roll);
    ctx.translate(-this.w / 2, -pivotY);

    this.drawSky();
    this.drawSea();
    this.drawWaves();
    this.drawBeach();

    const items: Drawable[] = [];
    this.collectDecor(items);
    for (const o of game.obstacles) {
      if (o.waiting || o.z > this.camZ + DRAW_DISTANCE) continue;
      // A pier is still drawn while you are under it; anything else once it nears the lens is gone.
      if (o.kind === "deck" ? o.z + SPECS.deck.length < this.camZ + CLOSE : o.z < this.camZ + CLOSE) continue;
      if (o.smashed > 0.45) continue;
      items.push({ z: o.z, draw: () => this.drawObstacle(o) });
    }
    for (const c of game.coins) {
      if (c.taken || c.z < p.z - 1 || c.z > this.camZ + DRAW_DISTANCE) continue;
      items.push({ z: c.z, draw: () => this.drawCoin(c.x, c.y, c.z) });
    }
    for (const pw of game.powers) {
      if (pw.taken || pw.z < p.z - 1 || pw.z > this.camZ + DRAW_DISTANCE) continue;
      items.push({ z: pw.z, draw: () => this.drawPower(pw.kind, pw.x, pw.z) });
    }
    for (const q of game.particles) {
      if (q.z < this.camZ + CLOSE) continue;
      items.push({ z: q.z, draw: () => this.drawParticle(q) });
    }
    items.push({ z: p.z - 0.01, draw: () => this.drawPlayer(game, skin) });
    items.sort((a, b) => b.z - a.z);
    for (const item of items) item.draw();

    if (p.boost > 0 || p.speed > 36) this.drawSpeedLines(p.boost > 0 ? 1 : (p.speed - 36) / 10);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawPopups(game);
  }

  // --- Projection ----------------------------------------------------------

  private project(x: number, y: number, z: number): Point | null {
    const dz = z - this.camZ;
    if (dz < NEAR) return null;
    const s = this.focal / dz;
    return { x: this.w / 2 + (x - this.camX) * s, y: this.horizon + (this.camY - y) * s, s };
  }

  /** Runs `paint` in metre units with the origin at (x, y, z), y pointing up as negative. */
  private at(x: number, y: number, z: number, paint: (ctx: CanvasRenderingContext2D, s: number) => void) {
    const pt = this.project(x, y, z);
    if (!pt || pt.s < 0.4) return;
    const { ctx } = this;
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.scale(pt.s, pt.s);
    paint(ctx, pt.s);
    ctx.restore();
  }

  /** A flat polygon through world points; skipped if any point is behind the camera. */
  private poly(points: [number, number, number][], fill: string) {
    const projected = points.map(([x, y, z]) => this.project(x, y, z));
    if (projected.some((pt) => !pt)) return;
    const { ctx } = this;
    ctx.beginPath();
    for (const [i, pt] of projected.entries()) {
      if (i === 0) ctx.moveTo(pt!.x, pt!.y);
      else ctx.lineTo(pt!.x, pt!.y);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // --- Backdrop ------------------------------------------------------------

  private drawSky() {
    const { ctx, w, h, horizon } = this;
    const sky = ctx.createLinearGradient(0, -h * 0.2, 0, horizon);
    sky.addColorStop(0, "#211f5e");
    sky.addColorStop(0.45, "#6f3c8e");
    sky.addColorStop(0.78, "#ee6f6a");
    sky.addColorStop(1, "#ffb86b");
    ctx.fillStyle = sky;
    ctx.fillRect(-w * 0.25, -h * 0.3, w * 1.5, horizon + h * 0.3 + 2);

    // The sun, low over the sea, drifting a little against the lean.
    const sx = w * 0.6 - this.camX * 4;
    const sy = horizon - h * 0.06;
    const r = Math.min(w, h) * 0.08;
    const glow = ctx.createRadialGradient(sx, sy, r * 0.3, sx, sy, r * 5);
    glow.addColorStop(0, "rgba(255,226,160,0.75)");
    glow.addColorStop(0.3, "rgba(255,170,110,0.25)");
    glow.addColorStop(1, "rgba(255,150,100,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(sx - r * 5, sy - r * 5, r * 10, r * 10);
    ctx.fillStyle = "#fff3cf";
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, TAU);
    ctx.fill();

    // Clouds: long, flat and lit pink from below.
    ctx.fillStyle = "rgba(255,190,190,0.35)";
    for (let i = 0; i < 5; i++) {
      const cx = ((hash(i, 1) * 1.6 - 0.3) * w + this.time * (6 + i * 2) - this.camX * 2) % (w * 1.6) - w * 0.2;
      const cy = horizon * (0.25 + hash(i, 2) * 0.5);
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * (0.08 + hash(i, 3) * 0.1), h * 0.012, 0, 0, TAU);
      ctx.fill();
    }

    // Gunung Agung on the left, the coast's hills on the right.
    const shift = -this.camX * 6;
    ctx.fillStyle = "#5b3f73";
    ctx.beginPath();
    ctx.moveTo(-w * 0.2 + shift, horizon + 1);
    ctx.lineTo(w * 0.08 + shift, horizon - h * 0.05);
    ctx.lineTo(w * 0.17 + shift, horizon - h * 0.13);
    ctx.lineTo(w * 0.2 + shift, horizon - h * 0.125);
    ctx.lineTo(w * 0.3 + shift, horizon - h * 0.04);
    ctx.lineTo(w * 0.42 + shift, horizon + 1);
    ctx.fill();
    ctx.fillStyle = "#4a3a63";
    ctx.beginPath();
    ctx.moveTo(w * 0.62 + shift, horizon + 1);
    ctx.quadraticCurveTo(w * 0.8 + shift, horizon - h * 0.06, w * 1.25, horizon - h * 0.05);
    ctx.lineTo(w * 1.25, horizon + 1);
    ctx.fill();
  }

  private drawSea() {
    const { ctx, w, h, horizon } = this;
    const sea = ctx.createLinearGradient(0, horizon, 0, h);
    sea.addColorStop(0, "#f7b98d");
    sea.addColorStop(0.07, "#8fb7c4");
    sea.addColorStop(0.35, "#25a3bb");
    sea.addColorStop(1, "#0b7d9b");
    ctx.fillStyle = sea;
    ctx.fillRect(-w * 0.25, horizon, w * 1.5, h * 1.3);

    // Glitter: the sun's path on the water.
    const sx = w * 0.6 - this.camX * 4;
    const depth = (h - horizon) * 0.55;
    const frame = Math.floor(this.time * 10);
    for (let i = 0; i < 46; i++) {
      const t = hash(i, frame);
      const y = horizon + 3 + Math.pow(hash(i, 7), 1.6) * depth;
      const spread = 6 + (y - horizon) * 0.5;
      const x = sx + (hash(i, frame + 1) - 0.5) * spread * 2;
      ctx.fillStyle = `rgba(255,240,200,${0.25 + t * 0.55})`;
      ctx.fillRect(x, y, 4 + (y - horizon) * 0.08, 1.5);
    }
  }

  private drawWaves() {
    const { ctx } = this;
    const step = 7;
    const first = Math.ceil((this.camZ + NEAR) / step);
    const last = Math.floor((this.camZ + DRAW_DISTANCE) / step);
    for (let k = last; k >= first; k--) {
      const z = k * step;
      const fade = 1 - (z - this.camZ) / DRAW_DISTANCE;
      for (let j = 0; j < 7; j++) {
        const x = (hash(k, j) - 0.5) * 90;
        if (x > SHORE) continue;
        const a = this.project(x, 0, z);
        const b = this.project(x + 1.5 + hash(k, j + 9) * 3, 0, z);
        if (!a || !b) continue;
        ctx.fillStyle = `rgba(255,255,255,${0.32 * fade})`;
        ctx.fillRect(a.x, a.y, b.x - a.x, Math.max(1, a.s * 0.07));
        ctx.fillStyle = `rgba(0,70,100,${0.12 * fade})`;
        ctx.fillRect(a.x, a.y + Math.max(1, a.s * 0.07), b.x - a.x, Math.max(1, a.s * 0.06));
      }
    }
  }

  private drawBeach() {
    const { ctx, w, h } = this;
    const near = this.camZ + NEAR + 0.3;
    const far = this.camZ + DRAW_DISTANCE;
    const shore: Point[] = [];
    for (let z = far; z >= near; z -= z - this.camZ > 30 ? 12 : 3) {
      const pt = this.project(SHORE + Math.sin(z * 0.05) * 0.8, 0, z);
      if (pt) shore.push(pt);
    }
    if (shore.length < 2) return;

    const sand = ctx.createLinearGradient(0, this.horizon, 0, h);
    sand.addColorStop(0, "#d9a98a");
    sand.addColorStop(0.3, "#ebc79c");
    sand.addColorStop(1, "#f5dcae");
    ctx.fillStyle = sand;
    ctx.beginPath();
    ctx.moveTo(shore[0].x, shore[0].y);
    for (const pt of shore) ctx.lineTo(pt.x, pt.y);
    ctx.lineTo(w * 1.3, h * 1.3);
    ctx.lineTo(w * 1.3, this.horizon);
    ctx.closePath();
    ctx.fill();

    // Wet sand, then the line of foam where the waves wash in and out.
    const wash = Math.sin(this.time * 1.3) * 0.35;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(170,130,95,0.35)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    shore.forEach((pt, i) => (i ? ctx.lineTo(pt.x + 4, pt.y) : ctx.moveTo(pt.x + 4, pt.y)));
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    for (let z = far, i = 0; z >= near; z -= z - this.camZ > 30 ? 12 : 3, i++) {
      const pt = this.project(SHORE - 0.25 + wash + Math.sin(z * 0.05) * 0.8, 0, z);
      if (!pt) continue;
      ctx.lineWidth = Math.max(1, pt.s * 0.12);
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
  }

  // --- Decor ---------------------------------------------------------------

  private collectDecor(items: Drawable[]) {
    const first = Math.ceil((this.camZ + NEAR) / DECOR_STEP);
    const last = Math.floor((this.camZ + DRAW_DISTANCE) / DECOR_STEP);
    for (let k = first; k <= last; k++) {
      const z = k * DECOR_STEP;
      const r = hash(k, 1);
      if (r < 0.42) {
        const x = 10.5 + hash(k, 2) * 9;
        const height = 6 + hash(k, 3) * 3;
        const lean = 0.25 + hash(k, 4) * 0.3;
        items.push({ z, draw: () => this.at(x, 0, z, (c) => this.palm(c, height, lean)) });
      } else if (r < 0.66) {
        const x = 10 + hash(k, 2) * 3.5;
        const colors = UMBRELLAS[Math.floor(hash(k, 5) * UMBRELLAS.length)];
        items.push({ z, draw: () => this.at(x, 0, z, (c) => this.umbrella(c, colors)) });
      } else if (r < 0.74) {
        const x = 17 + hash(k, 2) * 4;
        items.push({ z, draw: () => this.at(x, 0, z, (c) => this.warung(c)) });
      } else if (r < 0.8) {
        const x = 9.6 + hash(k, 2) * 1.5;
        items.push({ z, draw: () => this.at(x, 0, z, (c) => this.surfboards(c, k)) });
      }
      // A second palm row further back keeps the coast lush.
      if (hash(k, 8) < 0.55) {
        const x = 21 + hash(k, 9) * 8;
        const zz = z + hash(k, 10) * DECOR_STEP;
        items.push({ z: zz, draw: () => this.at(x, 0, zz, (c) => this.palm(c, 8 + hash(k, 11) * 3, -0.2)) });
      }
      // Distant sails out at sea.
      if (hash(k, 12) < 0.07) {
        const x = -40 - hash(k, 13) * 30;
        items.push({ z, draw: () => this.at(x, 0, z, (c) => this.sailboat(c)) });
      }
    }
    // Buoys mark the lanes.
    const step = 30;
    for (let k = Math.ceil((this.camZ + NEAR) / step); k * step < this.camZ + DRAW_DISTANCE; k++) {
      const z = k * step;
      for (const x of [-1.2, 1.2]) {
        items.push({ z, draw: () => this.at(x, 0, z, (c) => this.buoy(c, k)) });
      }
    }
  }

  private palm(c: CanvasRenderingContext2D, height: number, lean: number) {
    const topX = lean * height * 0.35;
    c.strokeStyle = "#7a5534";
    c.lineCap = "round";
    c.lineWidth = 0.32;
    c.beginPath();
    c.moveTo(0, 0);
    c.quadraticCurveTo(topX * 0.2, -height * 0.55, topX, -height);
    c.stroke();
    c.strokeStyle = "rgba(60,40,25,0.4)";
    c.lineWidth = 0.05;
    for (let i = 1; i < 8; i++) {
      const t = i / 8;
      const x = topX * t * t;
      c.beginPath();
      c.moveTo(x - 0.16, -height * t);
      c.lineTo(x + 0.16, -height * t + 0.05);
      c.stroke();
    }
    c.fillStyle = "#2f6b3a";
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + 0.3;
      const reach = 2.2 + (i % 2) * 0.6;
      const ex = topX + Math.cos(a) * reach;
      const ey = -height + Math.sin(a) * reach * 0.45 + 0.6;
      c.beginPath();
      c.moveTo(topX, -height);
      c.quadraticCurveTo(topX + Math.cos(a) * reach * 0.6, -height - 0.7 + Math.sin(a) * 0.4, ex, ey);
      c.quadraticCurveTo(topX + Math.cos(a) * reach * 0.5, -height + 0.1, topX, -height);
      c.fill();
    }
    c.fillStyle = "#5a3d22";
    c.beginPath();
    c.arc(topX, -height + 0.2, 0.22, 0, TAU);
    c.fill();
  }

  private umbrella(c: CanvasRenderingContext2D, [a, b]: string[]) {
    c.fillStyle = "rgba(120,80,50,0.25)";
    c.beginPath();
    c.ellipse(0.2, 0, 1.3, 0.25, 0, 0, TAU);
    c.fill();
    c.fillStyle = "#3d7ea6";
    c.fillRect(-0.9, -0.12, 1.6, 0.12);
    c.strokeStyle = "#ddd";
    c.lineWidth = 0.06;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(0, -2.2);
    c.stroke();
    for (let i = 0; i < 6; i++) {
      c.fillStyle = i % 2 ? a : b;
      c.beginPath();
      c.moveTo(0, -2.35);
      c.arc(0, -2.0, 1.4, Math.PI + (i * Math.PI) / 6, Math.PI + ((i + 1) * Math.PI) / 6);
      c.closePath();
      c.fill();
    }
  }

  private warung(c: CanvasRenderingContext2D) {
    c.fillStyle = "#5c3b1e";
    for (const x of [-1.6, 1.6]) c.fillRect(x - 0.08, -2.2, 0.16, 2.2);
    c.fillStyle = "#8a5a2b";
    c.fillRect(-1.5, -1.1, 3, 0.9);
    c.fillStyle = "#c9a15e";
    c.beginPath();
    c.moveTo(-2.2, -2.1);
    c.lineTo(0, -3.4);
    c.lineTo(2.2, -2.1);
    c.closePath();
    c.fill();
    c.strokeStyle = "rgba(90,60,25,0.6)";
    c.lineWidth = 0.05;
    for (let i = -4; i <= 4; i++) {
      c.beginPath();
      c.moveTo(i * 0.5, -2.1);
      c.lineTo(i * 0.15, -3.2);
      c.stroke();
    }
    c.fillStyle = "#e63946";
    c.fillRect(-0.7, -1.9, 1.4, 0.35);
    c.fillStyle = "#fff";
    c.font = "bold 0.25px sans-serif";
    c.textAlign = "center";
    c.fillText("ES KELAPA", 0, -1.66);
  }

  private surfboards(c: CanvasRenderingContext2D, k: number) {
    const colors = ["#ff595e", "#ffca3a", "#1982c4", "#8ac926"];
    for (let i = 0; i < 3; i++) {
      c.save();
      c.translate(i * 0.45 - 0.45, 0);
      c.rotate((i - 1) * 0.12);
      c.fillStyle = colors[(i + k) % colors.length];
      c.beginPath();
      c.ellipse(0, -1.0, 0.2, 1.0, 0, 0, TAU);
      c.fill();
      c.fillStyle = "rgba(255,255,255,0.7)";
      c.fillRect(-0.02, -1.9, 0.04, 1.8);
      c.restore();
    }
  }

  private sailboat(c: CanvasRenderingContext2D) {
    c.fillStyle = "#2b2140";
    c.beginPath();
    c.moveTo(-1.5, -0.3);
    c.lineTo(1.5, -0.3);
    c.lineTo(1.1, 0);
    c.lineTo(-1.1, 0);
    c.fill();
    c.fillStyle = "#fbe7d0";
    c.beginPath();
    c.moveTo(0, -3.5);
    c.lineTo(0, -0.4);
    c.lineTo(1.3, -0.5);
    c.fill();
  }

  private buoy(c: CanvasRenderingContext2D, k: number) {
    const bob = Math.sin(this.time * 2.4 + k) * 0.06;
    c.fillStyle = "#ff7b00";
    c.beginPath();
    c.arc(0, -0.18 + bob, 0.22, 0, TAU);
    c.fill();
    c.fillStyle = "#fff";
    c.fillRect(-0.22, -0.2 + bob, 0.44, 0.07);
  }

  // --- Obstacles -----------------------------------------------------------

  private drawObstacle(o: Obstacle) {
    const fade = o.smashed >= 0 ? 1 - o.smashed / 0.45 : 1;
    const { ctx } = this;
    ctx.globalAlpha = fade;
    const lift = o.smashed >= 0 ? o.smashed * 4 : 0;
    switch (o.kind) {
      case "boat":
        this.boat(o, lift);
        break;
      case "rock":
        this.at(o.x, lift, o.z, (c) => this.rock(c, o.id));
        break;
      case "log":
        this.poly(
          [
            [o.x - 1.15, 0.6, o.z],
            [o.x + 1.15, 0.6, o.z],
            [o.x + 1.15, 0.6, o.z + 0.8],
            [o.x - 1.15, 0.6, o.z + 0.8],
          ],
          "#6e4527",
        );
        this.at(o.x, lift, o.z, (c) => this.log(c));
        break;
      case "net":
        this.at(o.x, lift, o.z, (c) => this.net(c));
        break;
      case "rope":
        this.at(o.x, lift, o.z, (c) => this.flags(c, o.id));
        break;
      case "deck":
        this.deck(o);
        break;
      case "pillar":
        for (const dz of [7, 3.5, 0]) this.at(o.x, 0, o.z + dz, (c) => this.pillars(c));
        break;
      case "ramp":
        this.ramp(o);
        break;
      case "jetski":
        this.at(o.x, lift, o.z, (c) => this.rider(c, NPC_SKINS[o.id % NPC_SKINS.length], { bank: Math.sin(this.time * 2 + o.id) * 0.05, spin: 0, duck: false, boost: false, shield: false }));
        break;
      case "banana":
        this.at(o.x, lift, o.z, (c) => this.banana(c, Math.sign(o.vx) || 1));
        break;
    }
    ctx.globalAlpha = 1;
  }

  private boat(o: Obstacle, lift: number) {
    const hull = HULLS[o.id % HULLS.length];
    const y = 0.8 + lift;
    // Seen from above: a hull narrowing to a pointed bow, with a wooden deck inside.
    this.poly(
      [
        [o.x - 0.95, y, o.z],
        [o.x + 0.95, y, o.z],
        [o.x + 0.7, y, o.z + 3.4],
        [o.x, y + 0.15, o.z + 4.5],
        [o.x - 0.7, y, o.z + 3.4],
      ],
      hull,
    );
    this.poly(
      [
        [o.x - 0.75, y + 0.02, o.z + 0.15],
        [o.x + 0.75, y + 0.02, o.z + 0.15],
        [o.x + 0.5, y + 0.02, o.z + 3.2],
        [o.x - 0.5, y + 0.02, o.z + 3.2],
      ],
      "#8b5e34",
    );
    this.at(o.x, lift, o.z, (c) => {
      // Outriggers: the jukung's bamboo arms and floats.
      c.strokeStyle = "#c9a86a";
      c.lineWidth = 0.08;
      for (const side of [-1, 1]) {
        c.beginPath();
        c.moveTo(side * 0.6, -0.78);
        c.quadraticCurveTo(side * 0.95, -0.95, side * 1.12, -0.45);
        c.stroke();
        c.fillStyle = "#e9e2d0";
        c.beginPath();
        c.ellipse(side * 1.12, -0.12, 0.1, 0.12, 0, 0, TAU);
        c.fill();
      }
      c.fillStyle = hull;
      c.beginPath();
      c.moveTo(-0.95, -0.85);
      c.lineTo(0.95, -0.85);
      c.lineTo(0.72, -0.18);
      c.quadraticCurveTo(0, 0.08, -0.72, -0.18);
      c.closePath();
      c.fill();
      c.fillStyle = SAILS[(o.id + 1) % SAILS.length];
      c.fillRect(-0.9, -0.66, 1.8, 0.12);
      c.fillStyle = "#1d3557";
      c.fillRect(-0.86, -0.5, 1.72, 0.07);
      c.strokeStyle = "#3b2a1a";
      c.lineWidth = 0.07;
      c.beginPath();
      c.moveTo(0, -0.85);
      c.lineTo(0, -3.1);
      c.stroke();
      c.fillStyle = SAILS[o.id % SAILS.length];
      c.beginPath();
      c.moveTo(0.04, -3.0);
      c.lineTo(0.04, -1.05);
      c.lineTo(1.05, -1.2);
      c.closePath();
      c.fill();
      c.fillStyle = "rgba(0,0,0,0.12)";
      c.beginPath();
      c.moveTo(0.04, -2.2);
      c.lineTo(0.04, -1.05);
      c.lineTo(1.05, -1.2);
      c.closePath();
      c.fill();
    });
  }

  private rock(c: CanvasRenderingContext2D, id: number) {
    const jag = (i: number) => (hash(id, i) - 0.5) * 0.25;
    c.fillStyle = "rgba(255,255,255,0.6)";
    c.beginPath();
    c.ellipse(0, -0.02, 1.15, 0.16, 0, 0, TAU);
    c.fill();
    c.fillStyle = "#5f5b68";
    c.beginPath();
    c.moveTo(-1.0, 0);
    c.lineTo(-0.95 + jag(1), -0.8);
    c.lineTo(-0.45 + jag(2), -1.5);
    c.lineTo(0.2 + jag(3), -1.62);
    c.lineTo(0.75 + jag(4), -1.05);
    c.lineTo(1.0, 0);
    c.closePath();
    c.fill();
    c.fillStyle = "#86818f";
    c.beginPath();
    c.moveTo(-0.95 + jag(1), -0.8);
    c.lineTo(-0.45 + jag(2), -1.5);
    c.lineTo(0.2 + jag(3), -1.62);
    c.lineTo(-0.1, -0.9);
    c.closePath();
    c.fill();
    c.fillStyle = "#3f7d4c";
    c.beginPath();
    c.ellipse(0.4, -0.25, 0.35, 0.12, 0.2, 0, TAU);
    c.fill();
  }

  private log(c: CanvasRenderingContext2D) {
    c.fillStyle = "#8a5a33";
    c.beginPath();
    c.roundRect(-1.15, -0.6, 2.3, 0.58, 0.29);
    c.fill();
    c.strokeStyle = "rgba(60,35,15,0.5)";
    c.lineWidth = 0.04;
    for (const y of [-0.45, -0.3, -0.17]) {
      c.beginPath();
      c.moveTo(-0.9, y);
      c.lineTo(0.9, y + 0.02);
      c.stroke();
    }
    for (const x of [-1.0, 1.0]) {
      c.fillStyle = "#c49a6c";
      c.beginPath();
      c.ellipse(x, -0.31, 0.14, 0.27, 0, 0, TAU);
      c.fill();
      c.strokeStyle = "#8a5a33";
      c.beginPath();
      c.ellipse(x, -0.31, 0.07, 0.14, 0, 0, TAU);
      c.stroke();
    }
    c.fillStyle = "rgba(255,255,255,0.7)";
    c.fillRect(-1.2, -0.05, 2.4, 0.06);
  }

  private net(c: CanvasRenderingContext2D) {
    c.strokeStyle = "rgba(30,30,30,0.5)";
    c.lineWidth = 0.025;
    for (let x = -1.2; x <= 1.2; x += 0.2) {
      c.beginPath();
      c.moveTo(x, -0.6);
      c.lineTo(x + 0.1, 0);
      c.stroke();
    }
    c.strokeStyle = "#f1f1f1";
    c.lineWidth = 0.04;
    c.beginPath();
    c.moveTo(-1.25, -0.6);
    c.lineTo(1.25, -0.6);
    c.stroke();
    for (let i = 0; i < 6; i++) {
      c.fillStyle = i % 2 ? "#ffffff" : "#e63946";
      c.beginPath();
      c.arc(-1.1 + i * 0.44, -0.6, 0.14, 0, TAU);
      c.fill();
    }
  }

  private flags(c: CanvasRenderingContext2D, id: number) {
    c.fillStyle = "#7a5230";
    for (const x of [-1.3, 1.3]) c.fillRect(x - 0.05, -2.75, 0.1, 2.75);
    c.strokeStyle = "#f1e3c8";
    c.lineWidth = 0.035;
    c.beginPath();
    c.moveTo(-1.3, -2.6);
    c.quadraticCurveTo(0, -2.3, 1.3, -2.6);
    c.stroke();
    const sway = Math.sin(this.time * 4 + id) * 0.05;
    for (let i = 0; i < 7; i++) {
      const x = -1.08 + i * 0.36;
      const t = (x + 1.3) / 2.6;
      const y = -2.6 + 4 * t * (1 - t) * 0.3;
      c.fillStyle = FLAGS[(i + id) % FLAGS.length];
      c.beginPath();
      c.moveTo(x - 0.15, y);
      c.lineTo(x + 0.15, y);
      c.lineTo(x + sway, -1.08);
      c.closePath();
      c.fill();
    }
  }

  private deck(o: Obstacle) {
    const { x, z } = o;
    // Stilts at the far end, the top surface (from wherever it comes into view), then the near edge.
    this.at(x, 0, z + 7, (c) => this.stilts(c));
    const from = Math.max(z, this.camZ + NEAR + 0.2);
    this.poly(
      [
        [x - 1.2, 2.05, from],
        [x + 1.2, 2.05, from],
        [x + 1.2, 2.05, z + 7],
        [x - 1.2, 2.05, z + 7],
      ],
      "#9a6b3e",
    );
    const { ctx } = this;
    ctx.strokeStyle = "rgba(70,45,20,0.5)";
    for (let dz = 0.7; dz < 7; dz += 0.7) {
      const a = this.project(x - 1.2, 2.05, z + dz);
      const b = this.project(x + 1.2, 2.05, z + dz);
      if (!a || !b) continue;
      ctx.lineWidth = Math.max(1, a.s * 0.03);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    if (z < this.camZ + CLOSE) return;
    this.at(x, 0, z, (c) => {
      this.stilts(c);
      c.fillStyle = "#6b4626";
      c.fillRect(-1.2, -2.05, 2.4, 1.1);
      c.fillStyle = "rgba(0,0,0,0.25)";
      c.fillRect(-1.2, -1.05, 2.4, 0.1);
      c.strokeStyle = "rgba(40,25,10,0.5)";
      c.lineWidth = 0.03;
      for (const y of [-1.8, -1.55, -1.3]) {
        c.beginPath();
        c.moveTo(-1.2, y);
        c.lineTo(1.2, y);
        c.stroke();
      }
      // Railing.
      c.strokeStyle = "#e8d3b0";
      c.lineWidth = 0.06;
      for (const px of [-1.15, -0.4, 0.4, 1.15]) {
        c.beginPath();
        c.moveTo(px, -2.05);
        c.lineTo(px, -2.85);
        c.stroke();
      }
      c.beginPath();
      c.moveTo(-1.2, -2.8);
      c.lineTo(1.2, -2.8);
      c.stroke();
    });
  }

  private stilts(c: CanvasRenderingContext2D) {
    c.fillStyle = "#4b3420";
    for (const x of [-1.1, 1.1]) c.fillRect(x - 0.08, -1.0, 0.16, 1.0);
  }

  private pillars(c: CanvasRenderingContext2D) {
    c.fillStyle = "#3e2c1c";
    for (const x of [-0.5, 0, 0.5]) c.fillRect(x - 0.13, -1.0, 0.26, 1.0);
    c.strokeStyle = "#5c4330";
    c.lineWidth = 0.08;
    c.beginPath();
    c.moveTo(-0.55, -0.9);
    c.lineTo(0.55, -0.15);
    c.moveTo(0.55, -0.9);
    c.lineTo(-0.55, -0.15);
    c.stroke();
    c.fillStyle = "rgba(255,255,255,0.6)";
    c.fillRect(-0.65, -0.06, 1.3, 0.06);
  }

  private ramp(o: Obstacle) {
    const { x, z } = o;
    const w = 1.1;
    this.poly([[x - w, 0, z], [x - w, 0, z + 3], [x - w, 1, z + 3]], "#c46a00");
    this.poly([[x + w, 0, z], [x + w, 0, z + 3], [x + w, 1, z + 3]], "#c46a00");
    this.poly([[x - w, 0, z], [x + w, 0, z], [x + w, 1, z + 3], [x - w, 1, z + 3]], "#ff9f1c");
    // Chevrons pointing up the slope.
    for (let i = 0; i < 3; i++) {
      const z0 = z + 0.4 + i * 0.9;
      const y0 = (z0 - z) / 3;
      const y1 = (z0 + 0.45 - z) / 3;
      this.poly(
        [
          [x - w * 0.8, y0, z0],
          [x, y1, z0 + 0.45],
          [x + w * 0.8, y0, z0],
          [x + w * 0.8, y0 + 0.08, z0 + 0.25],
          [x, y1 + 0.08, z0 + 0.7],
          [x - w * 0.8, y0 + 0.08, z0 + 0.25],
        ],
        "#1b1b1b",
      );
    }
    this.at(x, 0, z, (c) => {
      c.fillStyle = "rgba(255,255,255,0.75)";
      c.beginPath();
      c.ellipse(0, -0.03, 1.25, 0.12, 0, 0, TAU);
      c.fill();
    });
  }

  private banana(c: CanvasRenderingContext2D, dir: number) {
    c.strokeStyle = "rgba(240,240,240,0.8)";
    c.lineWidth = 0.04;
    c.beginPath();
    c.moveTo(dir * 2.6, -0.55);
    c.lineTo(dir * 8, -0.4);
    c.stroke();
    const colors = ["#ef476f", "#118ab2", "#06d6a0", "#f78c6b"];
    for (let i = 0; i < 4; i++) {
      const x = -1.8 + i * 1.2;
      const bob = Math.sin(this.time * 6 + i) * 0.04;
      c.fillStyle = colors[i];
      c.beginPath();
      c.roundRect(x - 0.2, -1.55 + bob, 0.4, 0.55, 0.12);
      c.fill();
      c.fillStyle = "#c68642";
      c.beginPath();
      c.arc(x, -1.72 + bob, 0.15, 0, TAU);
      c.fill();
    }
    c.fillStyle = "#e0a800";
    c.beginPath();
    c.roundRect(-2.6, -0.65, 5.2, 0.5, 0.25);
    c.fill();
    c.fillStyle = "#ffd23f";
    c.beginPath();
    c.roundRect(-2.6, -1.05, 5.2, 0.55, 0.27);
    c.fill();
    c.fillStyle = "#3a2e05";
    c.beginPath();
    c.arc(dir * 2.35, -0.85, 0.08, 0, TAU);
    c.fill();
    c.fillStyle = "rgba(255,255,255,0.75)";
    c.fillRect(-2.7, -0.08, 5.4, 0.08);
  }

  // --- Pickups and particles -------------------------------------------------

  private drawCoin(x: number, y: number, z: number) {
    const turn = Math.abs(Math.cos(this.time * 4 + z * 0.3));
    this.at(x, y, z, (c) => {
      c.fillStyle = "rgba(255,210,63,0.18)";
      c.beginPath();
      c.arc(0, 0, 0.42, 0, TAU);
      c.fill();
      c.fillStyle = "#c98a00";
      c.beginPath();
      c.ellipse(0, 0, Math.max(0.05, 0.32 * turn), 0.32, 0, 0, TAU);
      c.fill();
      c.fillStyle = "#ffd23f";
      c.beginPath();
      c.ellipse(-0.03 * turn, 0, Math.max(0.03, 0.26 * turn), 0.26, 0, 0, TAU);
      c.fill();
      c.fillStyle = "#fff3b0";
      c.beginPath();
      c.ellipse(-0.08 * turn, -0.08, Math.max(0.01, 0.07 * turn), 0.1, 0, 0, TAU);
      c.fill();
    });
  }

  private drawPower(kind: PowerKind, x: number, z: number) {
    const y = 1.1 + Math.sin(this.time * 3 + z) * 0.15;
    const tint: Record<PowerKind, string> = {
      magnet: "rgba(255,90,90,",
      shield: "rgba(255,170,60,",
      double: "rgba(120,220,120,",
      nitro: "rgba(80,170,255,",
    };
    this.at(x, y, z, (c) => {
      const glow = c.createRadialGradient(0, 0, 0.1, 0, 0, 0.75);
      glow.addColorStop(0, `${tint[kind]}0.9)`);
      glow.addColorStop(0.6, `${tint[kind]}0.45)`);
      glow.addColorStop(1, `${tint[kind]}0)`);
      c.fillStyle = glow;
      c.beginPath();
      c.arc(0, 0, 0.75, 0, TAU);
      c.fill();
      c.strokeStyle = "rgba(255,255,255,0.9)";
      c.lineWidth = 0.04;
      c.beginPath();
      c.arc(0, 0, 0.5, 0, TAU);
      c.stroke();
      if (kind === "magnet") {
        c.strokeStyle = "#e63946";
        c.lineWidth = 0.14;
        c.beginPath();
        c.arc(0, -0.02, 0.2, Math.PI, 0, true);
        c.stroke();
        c.fillStyle = "#ddd";
        c.fillRect(-0.27, -0.05, 0.14, 0.12);
        c.fillRect(0.13, -0.05, 0.14, 0.12);
      } else if (kind === "shield") {
        c.lineWidth = 0.12;
        for (let i = 0; i < 4; i++) {
          c.strokeStyle = i % 2 ? "#ffffff" : "#ff6b1a";
          c.beginPath();
          c.arc(0, 0, 0.25, (i * Math.PI) / 2, ((i + 1) * Math.PI) / 2);
          c.stroke();
        }
      } else if (kind === "double") {
        c.fillStyle = "#fff";
        c.font = "900 0.38px sans-serif";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText("×2", 0, 0.02);
      } else {
        c.fillStyle = "#e9f2ff";
        c.beginPath();
        c.roundRect(-0.12, -0.3, 0.24, 0.5, 0.06);
        c.fill();
        c.fillStyle = "#ff8c1a";
        c.beginPath();
        c.moveTo(-0.1, 0.22);
        c.lineTo(0, 0.42);
        c.lineTo(0.1, 0.22);
        c.fill();
      }
    });
  }

  private drawParticle(q: Particle) {
    const life = q.life / q.max;
    const { ctx } = this;
    // Fade out as it nears the lens, so the wake never smears across the screen.
    const near = Math.min(1, (q.z - this.camZ - CLOSE) / 3);
    if (q.kind === "foam") {
      const pt = this.project(q.x, 0, q.z);
      if (!pt) return;
      ctx.fillStyle = `rgba(255,255,255,${0.55 * life * near})`;
      ctx.beginPath();
      ctx.ellipse(pt.x, pt.y, q.size * pt.s * (1.6 - life * 0.6), q.size * pt.s * 0.3, 0, 0, TAU);
      ctx.fill();
      return;
    }
    const pt = this.project(q.x, q.y, q.z);
    if (!pt) return;
    const r = Math.min(this.h * 0.025, Math.max(0.6, q.size * pt.s));
    if (q.kind === "debris") ctx.fillStyle = `rgba(120,80,45,${life})`;
    else if (q.kind === "spark") ctx.fillStyle = `rgba(255,225,90,${life})`;
    else if (q.kind === "spray") ctx.fillStyle = `rgba(240,250,255,${0.55 * life * near})`;
    else ctx.fillStyle = `rgba(240,250,255,${0.85 * life * near})`;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, TAU);
    ctx.fill();
  }

  // --- The rider -------------------------------------------------------------

  private drawPlayer(game: Game, skin: Skin) {
    const p = game.player;
    if (p.y > 0.05) {
      const shadow = this.project(p.x, 0, p.z);
      if (shadow) {
        const { ctx } = this;
        ctx.fillStyle = `rgba(0,40,60,${Math.max(0.08, 0.3 - p.y * 0.06)})`;
        ctx.beginPath();
        ctx.ellipse(shadow.x, shadow.y, 0.65 * shadow.s, 0.16 * shadow.s, 0, 0, TAU);
        ctx.fill();
      }
    }
    const crashed = game.state !== "run";
    this.at(p.x, p.y, p.z, (c) =>
      this.rider(c, skin, {
        bank: p.bank * 0.45,
        spin: crashed ? p.tumble : p.spin,
        duck: p.duck > 0 && p.air === "none",
        boost: p.boost > 0,
        shield: p.shield > 0 || (p.invulnerable > 0 && Math.floor(game.time * 12) % 2 === 0),
      }),
    );
  }

  private rider(
    c: CanvasRenderingContext2D,
    skin: Skin,
    o: { bank: number; spin: number; duck: boolean; boost: boolean; shield: boolean },
  ) {
    c.save();
    c.translate(0, -0.6);
    c.rotate(o.bank + o.spin * TAU);
    c.translate(0, 0.6);

    if (o.boost) {
      const flicker = 0.8 + Math.random() * 0.4;
      const flame = c.createRadialGradient(0, -0.25, 0.02, 0, -0.25, 0.6 * flicker);
      flame.addColorStop(0, "rgba(255,255,255,0.95)");
      flame.addColorStop(0.3, "rgba(120,200,255,0.8)");
      flame.addColorStop(1, "rgba(60,120,255,0)");
      c.fillStyle = flame;
      c.beginPath();
      c.arc(0, -0.25, 0.6 * flicker, 0, TAU);
      c.fill();
    }

    // Hull, seen from behind.
    c.fillStyle = skin.hull;
    c.beginPath();
    c.moveTo(-0.56, -0.52);
    c.lineTo(0.56, -0.52);
    c.lineTo(0.48, -0.15);
    c.quadraticCurveTo(0, 0.07, -0.48, -0.15);
    c.closePath();
    c.fill();
    c.fillStyle = skin.stripe;
    c.beginPath();
    c.moveTo(-0.54, -0.42);
    c.lineTo(0.54, -0.42);
    c.lineTo(0.51, -0.32);
    c.lineTo(-0.51, -0.32);
    c.closePath();
    c.fill();
    c.fillStyle = "rgba(0,0,0,0.18)";
    c.beginPath();
    c.moveTo(-0.48, -0.15);
    c.quadraticCurveTo(0, 0.07, 0.48, -0.15);
    c.lineTo(0.4, -0.2);
    c.quadraticCurveTo(0, -0.02, -0.4, -0.2);
    c.fill();
    c.fillStyle = "#1e1e24";
    c.beginPath();
    c.roundRect(-0.24, -0.72, 0.48, 0.2, 0.08);
    c.fill();
    c.fillStyle = "#ff3b30";
    c.fillRect(-0.5, -0.5, 0.1, 0.06);
    c.fillRect(0.4, -0.5, 0.1, 0.06);

    // The rider: low and flat when ducking.
    const skinTone = "#c68642";
    if (o.duck) {
      c.fillStyle = "#1d2b4a";
      c.fillRect(-0.2, -0.86, 0.4, 0.16);
      c.fillStyle = skin.vest;
      c.beginPath();
      c.roundRect(-0.3, -1.12, 0.6, 0.3, 0.1);
      c.fill();
      c.strokeStyle = skinTone;
      c.lineWidth = 0.09;
      c.beginPath();
      c.moveTo(-0.28, -1.0);
      c.lineTo(-0.44, -0.93);
      c.moveTo(0.28, -1.0);
      c.lineTo(0.44, -0.93);
      c.stroke();
      c.fillStyle = skin.helmet;
      c.beginPath();
      c.arc(0, -1.22, 0.15, 0, TAU);
      c.fill();
    } else {
      c.fillStyle = "#1d2b4a";
      c.fillRect(-0.21, -0.98, 0.14, 0.32);
      c.fillRect(0.07, -0.98, 0.14, 0.32);
      c.fillStyle = skin.vest;
      c.beginPath();
      c.roundRect(-0.26, -1.42, 0.52, 0.5, 0.12);
      c.fill();
      c.strokeStyle = "rgba(0,0,0,0.25)";
      c.lineWidth = 0.035;
      c.beginPath();
      c.moveTo(-0.26, -1.2);
      c.lineTo(0.26, -1.2);
      c.moveTo(-0.26, -1.06);
      c.lineTo(0.26, -1.06);
      c.stroke();
      c.strokeStyle = skinTone;
      c.lineWidth = 0.1;
      c.lineCap = "round";
      c.beginPath();
      c.moveTo(-0.25, -1.34);
      c.lineTo(-0.42, -1.0);
      c.moveTo(0.25, -1.34);
      c.lineTo(0.42, -1.0);
      c.stroke();
      c.fillStyle = skin.helmet;
      c.beginPath();
      c.arc(0, -1.58, 0.16, 0, TAU);
      c.fill();
      c.fillStyle = "rgba(20,20,30,0.75)";
      c.fillRect(-0.15, -1.6, 0.3, 0.06);
    }
    c.strokeStyle = "#2a2a2a";
    c.lineWidth = 0.06;
    c.beginPath();
    c.moveTo(-0.46, o.duck ? -0.92 : -1.0);
    c.lineTo(0.46, o.duck ? -0.92 : -1.0);
    c.stroke();

    if (o.shield) {
      c.fillStyle = "rgba(140,225,255,0.14)";
      c.strokeStyle = "rgba(170,240,255,0.75)";
      c.lineWidth = 0.04;
      c.beginPath();
      c.arc(0, -0.85, 1.05, 0, TAU);
      c.fill();
      c.stroke();
    }
    c.restore();
  }

  // --- Screen effects ----------------------------------------------------------

  private drawSpeedLines(strength: number) {
    const { ctx, w, h } = this;
    const vx = w / 2;
    const vy = this.horizon;
    ctx.strokeStyle = `rgba(255,255,255,${0.25 * Math.min(1, strength)})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI - Math.PI;
      const angle = a < -Math.PI / 2 ? a + Math.PI * 1.5 : a + Math.PI * 0.5;
      const r0 = h * (0.35 + Math.random() * 0.3);
      const r1 = r0 + h * (0.15 + Math.random() * 0.2);
      ctx.beginPath();
      ctx.moveTo(vx + Math.cos(angle) * r0, vy + Math.sin(angle) * r0);
      ctx.lineTo(vx + Math.cos(angle) * r1, vy + Math.sin(angle) * r1);
      ctx.stroke();
    }
  }

  private drawPopups(game: Game) {
    const { ctx, w, h } = this;
    const colors = { good: "#ffffff", great: "#ffe066", bad: "#ff6b6b", gold: "#ffd23f" };
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const base = h * 0.52;
    const size = Math.max(20, Math.min(34, w * 0.06));
    game.popups.forEach((p, i) => {
      const age = p.t / POPUP_SECONDS;
      const pop = Math.min(1, p.t / 0.12);
      const y = base - (game.popups.length - 1 - i) * size * 1.2 - age * 26;
      ctx.globalAlpha = 1 - age * age;
      ctx.font = `900 ${Math.round(size * (0.7 + 0.3 * pop))}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(30,20,60,0.75)";
      ctx.strokeText(p.text, w / 2, y);
      ctx.fillStyle = colors[p.tone];
      ctx.fillText(p.text, w / 2, y);
    });
    ctx.globalAlpha = 1;
  }
}

