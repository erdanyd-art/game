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
  private engine: {
    osc: OscillatorNode;
    second: OscillatorNode;
    sub: OscillatorNode;
    whine: OscillatorNode;
    whineGain: GainNode;
    body: BiquadFilterNode;
    out: GainNode;
    rushBand: BiquadFilterNode;
    water: GainNode;
    hiss: GainNode;
    wind: GainNode;
    windBand: BiquadFilterNode;
    sources: AudioScheduledSourceNode[];
    lastSlap: number;
    lastTime: number;
  } | null = null;
  private muted = false;
  private sirenNodes: { gain: GainNode; sources: OscillatorNode[] } | null = null;
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
    this.music = gain(ctx, 0.32, this.master);
    this.sfx = gain(ctx, 0.85, this.master);
    this.noise = makeNoise(ctx);
    this.startShore(ctx);
  }

  /** Waves breaking on the beach, rising and falling, and a seagull now and then. */
  private startShore(ctx: AudioContext) {
    if (!this.noise || !this.sfx) return;
    const surf = ctx.createBufferSource();
    surf.buffer = this.noise;
    surf.loop = true;
    surf.playbackRate.value = 0.5;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 700;
    const swell = gain(ctx, 0.035, this.sfx);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    lfo.connect(gain(ctx, 0.03, swell.gain));
    surf.connect(low).connect(swell);
    surf.start();
    lfo.start();
    const gull = () => {
      this.seagull();
      window.setTimeout(gull, 6000 + Math.random() * 10000);
    };
    window.setTimeout(gull, 3000);
  }

  private seagull() {
    const b = this.buses();
    if (!b || b.ctx.state !== "running") return;
    const t = b.ctx.currentTime;
    const calls = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < calls; i++) {
      const at = t + i * (0.22 + Math.random() * 0.1);
      const o = b.ctx.createOscillator();
      o.type = "sawtooth";
      const base = 1300 + Math.random() * 300;
      o.frequency.setValueAtTime(base * 1.4, at);
      o.frequency.exponentialRampToValueAtTime(base, at + 0.18);
      const f = b.ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 2200;
      f.Q.value = 2;
      const g = b.ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.03, at + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      o.connect(f).connect(g).connect(b.sfx);
      o.start(at);
      o.stop(at + 0.22);
    }
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
    b.music.gain.setValueAtTime(0.32, t);
    this.start = t + 0.1;
    this.step = 0;
    this.scheduler = window.setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stopMusic(fade = 0.6) {
    this.siren(false);
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
    const now = ctx.currentTime;
    const out = gain(ctx, 0, this.sfx!);
    out.gain.setTargetAtTime(0.06, now, 0.25);
    // Harmonics through a soft clipper: the rasp of a small two-stroke.
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClip(2.5);
    const body = ctx.createBiquadFilter();
    body.type = "lowpass";
    body.frequency.value = 1400;
    body.Q.value = 1.2;
    shaper.connect(body).connect(out);
    const pre = gain(ctx, 0.6, shaper);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const second = ctx.createOscillator();
    second.type = "sawtooth";
    const sub = ctx.createOscillator();
    sub.type = "square";
    osc.connect(gain(ctx, 0.5, pre));
    second.connect(gain(ctx, 0.25, pre));
    sub.connect(gain(ctx, 0.35, pre));
    // Firing pulses: the engine's putter rides on the tone.
    const flutter = ctx.createOscillator();
    flutter.frequency.value = 18;
    flutter.connect(gain(ctx, 0.018, out.gain));
    // The impeller's whine, high and thin.
    const whine = ctx.createOscillator();
    whine.type = "sine";
    const whineGain = gain(ctx, 0.012, this.sfx!);
    whine.connect(whineGain);

    // Water rushing under the hull and spray hissing off it.
    const rush = ctx.createBufferSource();
    rush.buffer = this.noise;
    rush.loop = true;
    const rushBand = ctx.createBiquadFilter();
    rushBand.type = "bandpass";
    rushBand.Q.value = 0.6;
    const water = gain(ctx, 0, this.sfx!);
    rush.connect(rushBand).connect(water);
    const hissSource = ctx.createBufferSource();
    hissSource.buffer = this.noise;
    hissSource.loop = true;
    hissSource.playbackRate.value = 1.3;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = "highpass";
    hissFilter.frequency.value = 3500;
    const hiss = gain(ctx, 0, this.sfx!);
    hissSource.connect(hissFilter).connect(hiss);
    // Wind, heard only in the air.
    const windSource = ctx.createBufferSource();
    windSource.buffer = this.noise;
    windSource.loop = true;
    windSource.playbackRate.value = 0.8;
    const windBand = ctx.createBiquadFilter();
    windBand.type = "bandpass";
    windBand.frequency.value = 800;
    windBand.Q.value = 1.4;
    const wind = gain(ctx, 0, this.sfx!);
    windSource.connect(windBand).connect(wind);

    for (const node of [osc, second, sub, flutter, whine, rush, hissSource, windSource]) node.start();
    this.engine = { osc, second, sub, whine, whineGain, body, out, rushBand, water, hiss, wind, windBand, sources: [osc, second, sub, flutter, whine, rush, hissSource, windSource], lastSlap: now, lastTime: now };
  }

  /** Called every frame: revs follow speed and leap when the jet leaves the water; water sounds follow the hull. */
  setEngine(speed: number, airborne: boolean, boost: boolean) {
    const e = this.engine;
    const ctx = this.ctx;
    if (!e || !ctx) return;
    const t = ctx.currentTime;
    const dt = Math.min(0.1, t - e.lastTime);
    e.lastTime = t;
    const f = (34 + speed * 1.75 + (boost ? 16 : 0)) * (airborne ? 1.35 : 1);
    e.osc.frequency.setTargetAtTime(f, t, airborne ? 0.12 : 0.08);
    e.second.frequency.setTargetAtTime(f * 2.01, t, 0.08);
    e.sub.frequency.setTargetAtTime(f / 2, t, 0.08);
    e.whine.frequency.setTargetAtTime(f * 6.2, t, 0.1);
    e.whineGain.gain.setTargetAtTime(airborne ? 0.02 : 0.008 + speed * 0.0002, t, 0.1);
    e.body.frequency.setTargetAtTime(airborne ? 2400 : 900 + speed * 22, t, 0.1);
    const pace = Math.min(1, speed / 40);
    e.rushBand.frequency.setTargetAtTime(380 + speed * 18, t, 0.1);
    e.water.gain.setTargetAtTime(airborne ? 0 : 0.05 + pace * 0.09, t, 0.05);
    e.hiss.gain.setTargetAtTime(airborne ? 0.004 : 0.012 + pace * 0.03, t, 0.05);
    e.wind.gain.setTargetAtTime(airborne ? 0.05 + pace * 0.06 : 0.008 * pace, t, 0.12);
    e.windBand.frequency.setTargetAtTime(airborne ? 650 + Math.random() * 500 : 900, t, 0.3);
    // The hull slapping the chop, more often the faster we go.
    if (!airborne && dt > 0 && Math.random() < dt * (1.1 + speed * 0.07)) this.slap(0.4 + Math.random() * 0.6 * pace);
  }

  stopEngine() {
    const e = this.engine;
    const ctx = this.ctx;
    if (!e || !ctx) return;
    const t = ctx.currentTime;
    for (const g of [e.out, e.water, e.hiss, e.wind, e.whineGain]) g.gain.setTargetAtTime(0, t, 0.15);
    for (const node of e.sources) node.stop(t + 1);
    this.engine = null;
  }

  /** A short wet thump of the hull on a wave. */
  private slap(strength: number) {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    this.noiseBurst(t, 0.12, "lowpass", 300 + strength * 300, 0.8, 0.14 * strength, b.sfx);
    this.sweep("sine", 95, 45, t, 0.1, 0.12 * strength, b.sfx);
  }

  /** A splash: thump, the wet "sploosh" of displaced water, then falling spray. */
  splash(strength: number) {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    this.sweep("sine", 110, 38, t, 0.3, 0.35 * strength, b.sfx);
    this.noiseBurst(t, 0.55 + strength * 0.25, "lowpass", 2400, 0.9, 0.45 * strength, b.sfx, 220);
    this.noiseBurst(t + 0.05, 0.9 + strength * 0.4, "highpass", 2800, 0.5, 0.12 * strength, b.sfx);
    // Droplets pattering back down.
    for (let i = 0; i < 6; i++) {
      this.noiseBurst(t + 0.2 + Math.random() * 0.5, 0.05, "bandpass", 2500 + Math.random() * 2500, 3, 0.05 * strength, b.sfx);
    }
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
    this.splash(hard ? 1 : 0.6);
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
    this.noiseBurst(t, 0.3, "bandpass", 900, 0.8, 0.4, b.sfx, 200);
    this.splash(1.5);
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

  /** A two-tone wail; louder as the police close in (see setSiren). */
  siren(on: boolean) {
    const b = this.buses();
    if (!b) return;
    const t = b.ctx.currentTime;
    if (!on) {
      if (this.sirenNodes) {
        this.sirenNodes.gain.gain.setTargetAtTime(0, t, 0.3);
        for (const o of this.sirenNodes.sources) o.stop(t + 1.5);
        this.sirenNodes = null;
      }
      return;
    }
    if (this.sirenNodes) return;
    const { ctx } = b;
    const gainNode = gain(ctx, 0, b.sfx);
    gainNode.gain.setTargetAtTime(0.03, t, 0.4);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 900;
    band.Q.value = 0.8;
    band.connect(gainNode);
    const tone = ctx.createOscillator();
    tone.type = "triangle";
    tone.frequency.value = 760;
    // The wail: pitch swept up and down by a slow oscillator.
    const sweep = ctx.createOscillator();
    sweep.frequency.value = 0.6;
    sweep.connect(gain(ctx, 170, tone.frequency));
    tone.connect(band);
    tone.start();
    sweep.start();
    this.sirenNodes = { gain: gainNode, sources: [tone, sweep] };
  }

  /** 0 when far, 1 when right behind. */
  setSiren(closeness: number) {
    if (!this.sirenNodes || !this.ctx) return;
    this.sirenNodes.gain.gain.setTargetAtTime(0.012 + 0.07 * closeness, this.ctx.currentTime, 0.2);
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

function gain(ctx: AudioContext, value: number, to?: AudioNode | AudioParam): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  // connect() has separate overloads for nodes and params, so narrow first.
  if (to instanceof AudioNode) g.connect(to);
  else if (to) g.connect(to);
  return g;
}

/** A tanh-like curve for a WaveShaper: drive adds grit. */
function softClip(drive: number) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

function makeNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
