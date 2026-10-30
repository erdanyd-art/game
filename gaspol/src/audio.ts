import type { PowerKind } from "./course.ts";
import type { Sfx } from "./game.ts";

// Everything is synthesised: a tropical beat, a jetski engine that follows the
// throttle, and the effects. Notes are MIDI numbers.

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
const BPM = 118;
const EIGHTH = 60 / BPM / 2;

// I–vi–IV–V in C, one bar each: root, then the chord tones for the off-beat stabs.
const PROGRESSION = [
  { root: 48, chord: [60, 64, 67] },
  { root: 45, chord: [57, 60, 64] },
  { root: 41, chord: [57, 60, 65] },
  { root: 43, chord: [59, 62, 67] },
];
// A marimba hook over two bars, in eighths (null: rest).
const HOOK: (number | null)[] = [
  72, null, 76, 79, 81, null, 79, 76,
  74, null, 72, null, 69, 72, null, null,
  72, null, 76, 79, 84, null, 81, 79,
  76, 79, 76, 74, 72, null, null, null,
];
const BASS_STEPS = [0, null, 0, 12, null, 7, 0, null];

const MASTER = 0.8;

type Buses = { ctx: AudioContext; music: GainNode; sfx: GainNode };

export class Sound implements Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engine: { osc: OscillatorNode; sub: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; water: GainNode } | null = null;
  private muted = false;
  private scheduler = 0;
  private start = 0;
  private step = 0;
  /** 0: drums and bass, 1: plus chords, 2: plus the hook. */
  intensity = 0;
  boosted = false;

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: "interactive" });
    } catch {
      return;
    }
    this.ctx = ctx;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.ratio.value = 4;
    compressor.connect(ctx.destination);
    this.master = gain(ctx, this.muted ? 0 : MASTER, compressor);
    this.music = gain(ctx, 0.5, this.master);
    this.sfx = gain(ctx, 0.75, this.master);
    this.noise = makeNoise(ctx);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : MASTER, this.ctx.currentTime, 0.02);
  }

  suspend() {
    if (this.ctx?.state === "running") void this.ctx.suspend();
  }

  resume() {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  startMusic() {
    this.stopMusic(0.05);
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    b.music.gain.cancelScheduledValues(t);
    b.music.gain.setValueAtTime(0.5, t);
    this.start = t + 0.1;
    this.step = 0;
    this.scheduler = window.setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stopMusic(fade = 0.6) {
    window.clearInterval(this.scheduler);
    this.scheduler = 0;
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    b.music.gain.cancelScheduledValues(t);
    b.music.gain.setValueAtTime(b.music.gain.value, t);
    b.music.gain.linearRampToValueAtTime(0, t + fade);
  }

  // --- Engine ----------------------------------------------------------------

  startEngine() {
    const b = this.buses();
    if (!b || this.engine || !this.noise) return;
    const { ctx } = b;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    filter.Q.value = 3;
    const out = gain(ctx, 0, this.sfx!);
    out.gain.setTargetAtTime(0.05, ctx.currentTime, 0.2);
    filter.connect(out);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const sub = ctx.createOscillator();
    sub.type = "square";
    osc.connect(filter);
    sub.connect(gain(ctx, 0.5, filter));
    const rush = ctx.createBufferSource();
    rush.buffer = this.noise;
    rush.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1300;
    band.Q.value = 0.7;
    const water = gain(ctx, 0.05, this.sfx!);
    rush.connect(band).connect(water);
    for (const node of [osc, sub, rush]) node.start();
    this.engine = { osc, sub, filter, gain: out, water };
  }

  /** Called every frame: pitch follows speed, revs up in the air, the water hiss stops. */
  setEngine(speed: number, airborne: boolean, boost: boolean) {
    const e = this.engine;
    const ctx = this.ctx;
    if (!e || !ctx) return;
    const t = ctx.currentTime;
    const freq = (55 + speed * 2.1 + (boost ? 30 : 0)) * (airborne ? 1.3 : 1);
    e.osc.frequency.setTargetAtTime(freq, t, 0.08);
    e.sub.frequency.setTargetAtTime(freq / 2, t, 0.08);
    e.filter.frequency.setTargetAtTime(airborne ? 1600 : 700 + speed * 15, t, 0.1);
    e.water.gain.setTargetAtTime(airborne ? 0.005 : 0.05, t, 0.05);
  }

  stopEngine() {
    const e = this.engine;
    const ctx = this.ctx;
    if (!e || !ctx) return;
    const t = ctx.currentTime;
    e.gain.gain.setTargetAtTime(0, t, 0.15);
    e.water.gain.setTargetAtTime(0, t, 0.15);
    for (const node of [e.osc, e.sub]) node.stop(t + 1);
    this.engine = null;
  }

  // --- Sfx ---------------------------------------------------------------------

  coin(streak: number) {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    // A run of coins climbs the scale.
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
    const note = 84 + scale[Math.min(scale.length - 1, streak - 1)];
    this.pluck("square", midi(note), t, 0.06, 0.1, b.sfx);
    this.pluck("sine", midi(note + 7), t + 0.05, 0.08, 0.12, b.sfx);
  }

  jump() {
    const b = this.buses();
    if (!b) return;
    this.sweep("sine", 300, 700, b.ctx.currentTime, 0.15, 0.12, b.sfx);
  }

  ramp() {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    this.sweep("sawtooth", 200, 900, t, 0.35, 0.08, b.sfx);
    this.noiseBurst(t, 0.4, "bandpass", 900, 0.8, 0.15, b.sfx, 3000);
  }

  land(hard: boolean) {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    this.noiseBurst(t, hard ? 0.45 : 0.25, "lowpass", hard ? 900 : 1400, 0.7, hard ? 0.4 : 0.22, b.sfx, 300);
    if (hard) this.sweep("sine", 120, 50, t, 0.25, 0.3, b.sfx);
  }

  duck() {
    const b = this.buses();
    if (!b) return;
    this.noiseBurst(b.ctx.currentTime, 0.15, "highpass", 2500, 0.7, 0.08, b.sfx);
  }

  lane() {
    const b = this.buses();
    if (!b) return;
    this.noiseBurst(b.ctx.currentTime, 0.18, "bandpass", 2200, 1.2, 0.1, b.sfx, 900);
  }

  spin() {
    const b = this.buses();
    if (!b) return;
    this.noiseBurst(b.ctx.currentTime, 0.35, "bandpass", 600, 2, 0.12, b.sfx, 2400);
  }

  trick(spins: number) {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    [72, 76, 79, 84, 88].slice(0, 2 + spins).forEach((n, i) => this.pluck("triangle", midi(n), t + i * 0.07, 0.16, 0.35, b.sfx));
  }

  near() {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    this.noiseBurst(t, 0.3, "bandpass", 3000, 1, 0.14, b.sfx, 500);
    this.pluck("square", midi(88), t + 0.05, 0.05, 0.1, b.sfx);
  }

  combo(level: number) {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    const top = 72 + Math.round((level - 1) * 8);
    [top, top + 4, top + 7, top + 12].forEach((n, i) => this.pluck("square", midi(n), t + i * 0.05, 0.07, 0.15, b.sfx));
  }

  bump() {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    this.sweep("square", 160, 60, t, 0.18, 0.2, b.sfx);
    this.noiseBurst(t, 0.2, "lowpass", 600, 1, 0.25, b.sfx);
  }

  crash() {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    this.noiseBurst(t, 1.2, "lowpass", 2500, 0.5, 0.6, b.sfx, 200);
    this.sweep("sawtooth", 220, 40, t, 0.8, 0.25, b.sfx);
    this.stopEngine();
  }

  smash() {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    this.noiseBurst(t, 0.35, "bandpass", 700, 0.6, 0.35, b.sfx, 250);
    this.sweep("square", 300, 80, t, 0.2, 0.1, b.sfx);
  }

  power(kind: PowerKind) {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    const base = { magnet: 67, shield: 64, double: 72, nitro: 60 }[kind];
    [0, 4, 7, 12, 16].forEach((d, i) => this.pluck("triangle", midi(base + d), t + i * 0.05, 0.14, 0.25, b.sfx));
  }

  nitro() {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    this.sweep("sawtooth", 150, 1200, t, 0.6, 0.15, b.sfx);
    this.noiseBurst(t, 0.9, "bandpass", 500, 0.8, 0.3, b.sfx, 5000);
  }

  shield() {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    this.sweep("sine", 900, 200, t, 0.3, 0.25, b.sfx);
    this.noiseBurst(t, 0.25, "highpass", 3000, 0.7, 0.2, b.sfx);
  }

  horn() {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    for (const [at, len] of [
      [0, 0.18],
      [0.25, 0.35],
    ]) {
      for (const f of [330, 415]) this.pluck("sawtooth", f, t + at, 0.06, len, b.sfx, 1200);
    }
  }

  click() {
    const b = this.buses();
    if (!b) return;
    this.pluck("triangle", midi(84), b.ctx.currentTime, 0.08, 0.08, b.sfx);
  }

  // --- Music -------------------------------------------------------------------

  private schedule() {
    const b = this.buses();
    if (!b) return;
    const horizon = b.ctx.currentTime + 0.15;
    while (this.start + this.step * EIGHTH < horizon) {
      this.playStep(this.step, this.start + this.step * EIGHTH, b.music);
      this.step++;
    }
  }

  private playStep(step: number, t: number, out: AudioNode) {
    const inBar = step % 8;
    const bar = Math.floor(step / 8) % PROGRESSION.length;
    const { root, chord } = PROGRESSION[bar];
    const onBeat = inBar % 2 === 0;
    if (onBeat) this.kick(t, out);
    if (inBar === 2 || inBar === 6) this.clap(t, out);
    if (!onBeat || this.boosted) this.hat(t, out, onBeat ? 0.03 : 0.06);
    const bass = BASS_STEPS[inBar];
    if (bass !== null) this.pluck("sawtooth", midi(root + bass), t, 0.16, 0.2, out, 500);
    if (this.intensity >= 1 && !onBeat) {
      for (const n of chord) this.pluck("triangle", midi(n), t, 0.05, 0.12, out, 2200);
    }
    if (this.intensity >= 2) {
      const note = HOOK[step % HOOK.length];
      if (note !== null) {
        this.pluck("sine", midi(note), t, 0.14, 0.35, out);
        this.pluck("sine", midi(note + 12), t, 0.03, 0.12, out);
      }
    }
  }

  private kick(t: number, out: AudioNode) {
    this.sweep("sine", 130, 42, t, 0.28, 0.55, out);
  }

  private clap(t: number, out: AudioNode) {
    for (const d of [0, 0.012, 0.024]) this.noiseBurst(t + d, 0.12, "bandpass", 1600, 1.2, 0.18, out);
  }

  private hat(t: number, out: AudioNode, peak: number) {
    this.noiseBurst(t, 0.05, "highpass", 7500, 0.7, peak, out);
  }

  // --- Building blocks -----------------------------------------------------------

  private pluck(type: OscillatorType, freq: number, at: number, peak: number, length: number, out: AudioNode, cutoff?: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, at + length);
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = cutoff;
      o.connect(f).connect(g);
    } else {
      o.connect(g);
    }
    g.connect(out);
    o.start(at);
    o.stop(at + length + 0.02);
  }

  private sweep(type: OscillatorType, from: number, to: number, at: number, length: number, peak: number, out: AudioNode) {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, at);
    o.frequency.exponentialRampToValueAtTime(to, at + length);
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + length);
    o.connect(g).connect(out);
    o.start(at);
    o.stop(at + length + 0.02);
  }

  private noiseBurst(
    at: number,
    length: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    peak: number,
    out: AudioNode,
    sweepTo?: number,
  ) {
    const { ctx, noise } = this;
    if (!ctx || !noise) return;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, at);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + length);
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + length);
    src.connect(f).connect(g).connect(out);
    src.start(at, Math.random() * 1.5);
    src.stop(at + length + 0.02);
  }

  private buses(): Buses | null {
    return this.ctx && this.music && this.sfx ? { ctx: this.ctx, music: this.music, sfx: this.sfx } : null;
  }
}

function gain(ctx: AudioContext, value: number, to?: AudioNode): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  if (to) g.connect(to);
  return g;
}

function makeNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
