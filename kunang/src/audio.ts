import type { Judgement } from "./beat.ts";
import type { Sfx } from "./game.ts";

// Idealised slendro: five near-equal steps to the octave, as on a Javanese gamelan.
const BASE = 146.83; // D3
const slendro = (step: number) => BASE * Math.pow(2, step / 5);

// The skeleton melody (balungan) the saron plays, one note per beat.
// A gong opens every cycle of 16, a smaller kempul marks each group of 4.
const MELODY = [2, 1, 2, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 3, 1, 0];

const MUSIC_LEVEL = 0.6;
const MASTER_LEVEL = 0.9;

type Bus = { ctx: AudioContext; music: GainNode; sfx: GainNode };

export class Sound implements Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted = false;
  private start = 0;
  private spb = 1;
  private nextBeat = 0;
  private scheduler = 0;
  private drone: { gain: GainNode; oscillators: OscillatorNode[] } | null = null;
  private lastEat = 0;

  /** Browsers only allow audio after a gesture, so call this from a click or key handler. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: "interactive" });
    } catch {
      return; // No audio: the game still runs on the performance clock.
    }
    this.ctx = ctx;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.ratio.value = 4;
    compressor.connect(ctx.destination);
    this.master = gainNode(ctx, this.muted ? 0 : MASTER_LEVEL, compressor);
    this.music = gainNode(ctx, MUSIC_LEVEL, this.master);
    this.sfx = gainNode(ctx, 0.8, this.master);
    this.noise = makeNoise(ctx);
    this.startAmbience(gainNode(ctx, 0.5, this.master));
  }

  /**
   * Seconds on the clock the player is hearing right now. A sound scheduled for
   * time T is heard once now() reaches T, so beats, visuals and judging all agree.
   */
  now(): number {
    const ctx = this.ctx;
    if (!ctx) return performance.now() / 1000;
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  /** Starts the gamelan; returns when beat 0 is heard, on the now() clock. */
  startMusic(bpm: number): number {
    this.stopMusic(0.05);
    const bus = this.bus();
    if (!bus) return this.now() + 0.6;
    const { ctx, music } = bus;
    const t = ctx.currentTime;
    music.gain.cancelScheduledValues(t);
    music.gain.setValueAtTime(MUSIC_LEVEL, t);
    this.spb = 60 / bpm;
    this.start = t + 0.6;
    this.nextBeat = 0;
    this.startDrone(this.start);
    this.scheduler = window.setInterval(() => this.schedule(), 25);
    this.schedule();
    return this.start;
  }

  stopMusic(fade = 0.8) {
    window.clearInterval(this.scheduler);
    this.scheduler = 0;
    const bus = this.bus();
    if (!bus) return;
    const t = bus.ctx.currentTime;
    bus.music.gain.cancelScheduledValues(t);
    bus.music.gain.setValueAtTime(bus.music.gain.value, t);
    bus.music.gain.linearRampToValueAtTime(0, t + fade);
    if (this.drone) {
      this.drone.gain.gain.cancelScheduledValues(t);
      this.drone.gain.gain.setValueAtTime(this.drone.gain.gain.value, t);
      this.drone.gain.gain.linearRampToValueAtTime(0, t + fade);
      for (const o of this.drone.oscillators) o.stop(t + fade + 0.05);
      this.drone = null;
    }
  }

  /** Freezes the audio clock, and with it the beat. */
  suspend() {
    if (this.ctx?.state === "running") void this.ctx.suspend();
  }

  resume() {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, this.ctx.currentTime, 0.02);
    }
  }

  // --- Sfx ---------------------------------------------------------------

  flash(judgement: Judgement, combo: number) {
    const bus = this.bus();
    if (!bus) return;
    const t = bus.ctx.currentTime;
    if (judgement === "miss") {
      this.noiseBurst(t, 0.18, "lowpass", 300, 1, 0.3, bus.sfx);
      this.tone("sine", 130, 55, t, 0.2, 0.22, bus.sfx);
      return;
    }
    // Each hit in a combo climbs the scale.
    const step = 7 + Math.min(combo, 12);
    this.bell(slendro(step), t, judgement === "perfect" ? 0.26 : 0.16, 1.4, bus.sfx);
    if (judgement === "perfect") this.bell(slendro(step + 5), t, 0.07, 0.9, bus.sfx);
  }

  recruit(count: number) {
    const bus = this.bus();
    if (!bus) return;
    const t = bus.ctx.currentTime + 0.05;
    const notes = Math.min(4, 1 + Math.floor(count / 3));
    for (let i = 0; i < notes; i++) this.bell(slendro(13 + i * 2), t + i * 0.07, 0.07, 0.6, bus.sfx);
  }

  eat() {
    const bus = this.bus();
    if (!bus) return;
    const t = bus.ctx.currentTime;
    if (t - this.lastEat < 0.07) return; // a bat swallowing several in a row is one sound
    this.lastEat = t;
    this.tone("sine", 1200, 160, t, 0.18, 0.2, bus.sfx);
    this.tone("triangle", 600, 90, t, 0.12, 0.08, bus.sfx);
  }

  croak() {
    const bus = this.bus();
    if (!bus) return;
    const { ctx, sfx } = bus;
    const t = ctx.currentTime;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 650;
    filter.Q.value = 7;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    // A ratchet of short pulses reads as a croak.
    for (let i = 0; i < 5; i++) {
      const at = t + i * 0.055;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(0.2, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0005, at + 0.05);
    }
    filter.connect(gain).connect(sfx);
    for (const freq of [88, 131]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq;
      o.connect(filter);
      o.start(t);
      o.stop(t + 0.32);
    }
  }

  screech() {
    const bus = this.bus();
    if (!bus) return;
    const t = bus.ctx.currentTime;
    for (let i = 0; i < 3; i++) this.tone("sine", 3200, 5200, t + i * 0.08, 0.06, 0.05, bus.sfx);
  }

  scare() {
    const bus = this.bus();
    if (!bus) return;
    this.noiseBurst(bus.ctx.currentTime, 0.3, "bandpass", 700, 2, 0.12, bus.sfx, 3200);
  }

  win() {
    const bus = this.bus();
    if (!bus) return;
    const t = bus.ctx.currentTime;
    [5, 7, 9, 10, 12, 14, 15].forEach((step, i) => this.bell(slendro(step), t + i * 0.12, 0.14, 1.6, bus.sfx));
    this.gong(t + 0.9, 62, 0.4, 4.5, bus.sfx);
  }

  lose() {
    const bus = this.bus();
    if (!bus) return;
    const t = bus.ctx.currentTime;
    [9, 7, 5, 2].forEach((step, i) => this.bell(slendro(step), t + i * 0.28, 0.1, 1.4, bus.sfx));
    this.gong(t + 1.1, 52, 0.3, 4, bus.sfx);
  }

  /** A soft tick for menu buttons. */
  click() {
    const bus = this.bus();
    if (!bus) return;
    this.bell(slendro(10), bus.ctx.currentTime, 0.05, 0.4, bus.sfx);
  }

  // --- Music -------------------------------------------------------------

  private schedule() {
    const bus = this.bus();
    if (!bus) return;
    // Look a little ahead: timers are jittery, the audio clock is not.
    const horizon = bus.ctx.currentTime + 0.15;
    while (this.start + this.nextBeat * this.spb < horizon) {
      this.playBeat(this.nextBeat, this.start + this.nextBeat * this.spb, bus.music);
      this.nextBeat++;
    }
  }

  private playBeat(beat: number, at: number, out: AudioNode) {
    this.bell(slendro(MELODY[beat % MELODY.length] + 5), at, 0.15, 1.1, out);
    if (beat % 16 === 0) this.gong(at, 62, 0.34, 4, out);
    else if (beat % 4 === 0) this.gong(at, 124, 0.12, 1.6, out);
  }

  private startDrone(at: number) {
    const bus = this.bus();
    if (!bus) return;
    const { ctx, music } = bus;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.05, at + 3);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 500;
    filter.connect(gain).connect(music);
    const oscillators = [slendro(-5), slendro(-2)].map((freq) => {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = freq;
      o.connect(filter);
      o.start(at);
      return o;
    });
    this.drone = { gain, oscillators };
  }

  private startAmbience(out: GainNode) {
    const { ctx, noise } = this;
    if (!ctx || !noise) return;
    // Crickets: band-passed noise chopped by a fast square wave, swelling slowly.
    const crickets = ctx.createBufferSource();
    crickets.buffer = noise;
    crickets.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 4700;
    band.Q.value = 10;
    const chirp = gainNode(ctx, 0.035);
    const chop = ctx.createOscillator();
    chop.type = "square";
    chop.frequency.value = 15;
    chop.connect(gainNode(ctx, 0.035, chirp.gain));
    const swell = gainNode(ctx, 0.6, out);
    const breathe = ctx.createOscillator();
    breathe.frequency.value = 0.13;
    breathe.connect(gainNode(ctx, 0.4, swell.gain));
    crickets.connect(band).connect(chirp).connect(swell);

    // Water: slow, low-passed noise.
    const water = ctx.createBufferSource();
    water.buffer = noise;
    water.loop = true;
    water.playbackRate.value = 0.6;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 420;
    water.connect(low).connect(gainNode(ctx, 0.08, out));

    for (const source of [crickets, chop, breathe, water]) source.start();
  }

  // --- Instruments -------------------------------------------------------

  /** A struck bronze key: a few inharmonic partials, the fundamental doubled a few hertz apart. */
  private bell(freq: number, at: number, peak: number, decay: number, out: AudioNode) {
    const ctx = this.ctx;
    if (!ctx) return;
    const partials: [number, number][] = [
      [1, 1],
      [2.76, 0.28],
      [5.4, 0.1],
    ];
    for (const [ratio, amp] of partials) {
      const length = decay / (1 + (ratio - 1) * 0.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak * amp, at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, at + length);
      g.connect(out);
      // Ombak: gamelan instruments come in pairs tuned slightly apart, so notes shimmer.
      for (const detune of ratio === 1 ? [0, 4.5] : [0]) {
        const o = ctx.createOscillator();
        o.frequency.value = freq * ratio + detune;
        o.connect(g);
        o.start(at);
        o.stop(at + length + 0.05);
      }
    }
  }

  private gong(at: number, freq: number, peak: number, decay: number, out: AudioNode) {
    const ctx = this.ctx;
    if (!ctx) return;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1200;
    filter.connect(out);
    const partials: [number, number][] = [
      [1, 1],
      [2, 0.45],
      [3.01, 0.2],
      [4.2, 0.08],
    ];
    for (const [ratio, amp] of partials) {
      const length = decay / ratio ** 0.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak * amp, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + length);
      g.connect(filter);
      for (const detune of ratio === 1 ? [0, 0.9] : [0]) {
        const o = ctx.createOscillator();
        o.frequency.value = freq * ratio + detune;
        o.connect(g);
        o.start(at);
        o.stop(at + length + 0.05);
      }
    }
  }

  private tone(type: OscillatorType, from: number, to: number, at: number, length: number, peak: number, out: AudioNode) {
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
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, at);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, at + length);
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(filter).connect(g).connect(out);
    source.start(at, Math.random() * 2);
    source.stop(at + length + 0.02);
  }

  private bus(): Bus | null {
    return this.ctx && this.music && this.sfx ? { ctx: this.ctx, music: this.music, sfx: this.sfx } : null;
  }
}

function gainNode(ctx: AudioContext, value: number, to?: AudioNode | AudioParam): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  // connect() has separate overloads for nodes and params, so narrow first.
  if (to instanceof AudioNode) g.connect(to);
  else if (to) g.connect(to);
  return g;
}

function makeNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
