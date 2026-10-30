import "./style.css";
import { Sound } from "./audio.ts";
import { Autopilot, SHARP } from "./autopilot.ts";
import { Game, silentSfx, type HintId, type Outcome, type Sfx } from "./game.ts";
import { Input } from "./input.ts";
import { Renderer3D } from "./render3d.ts";
import { missionAt, progressOf, settle } from "./missions.ts";
import { loadSave, QUALITIES, skinById, writeSave, type Skin } from "./save.ts";
import { Ui, type Screen } from "./ui.ts";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const sound = new Sound();
const save = loadSave();
const renderer = new Renderer3D(canvas, save.quality);
const input = new Input(canvas);

/** The sounds, plus a buzz on phones for the moments you should feel. */
const buzz = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {}
};
const sfx: Sfx = {
  coin: (n) => sound.coin(n),
  jump: () => sound.jump(),
  ramp: () => sound.ramp(),
  land: (hard) => {
    if (hard) buzz(35);
    sound.land(hard);
  },
  duck: () => sound.duck(),
  lane: () => sound.lane(),
  spin: () => sound.spin(),
  trick: (n) => sound.trick(n),
  near: () => sound.near(),
  combo: (level) => sound.combo(level),
  bump: () => {
    buzz(60);
    sound.bump();
  },
  crash: () => {
    buzz([90, 50, 140]);
    sound.crash();
  },
  smash: () => {
    buzz(25);
    sound.smash();
  },
  power: (kind) => sound.power(kind),
  nitro: () => {
    buzz(40);
    sound.nitro();
  },
  shield: () => {
    buzz(50);
    sound.shield();
  },
  horn: () => sound.horn(),
  siren: (on) => sound.siren(on),
};

let screen: Screen = "title";
let garageFrom: Screen = "title";
let pilot = new Autopilot(SHARP);
let pilotWait = 0;
/** Missions already cheered for in this run (by slot). */
let announced = new Set<number>();
/** A finished run whose coins and missions are banked once the player moves on (they may continue). */
let pending: Outcome | null = null;
let revives = 0;
const reviveCost = () => 150 * 2 ** revives;
let game = demoGame();

const ui = new Ui({
  play: () => play(),
  pause: () => pause(),
  resume: () => resume(),
  restart: () => play(),
  menu: () => toMenu(),
  revive: () => revive(),
  quality: () => cycleQuality(),
  garage: () => openGarage(),
  closeGarage: () => {
    ui.renderTitle(save);
    show(garageFrom);
  },
  choose: (skin) => choose(skin),
  toggleMute: () => toggleMute(),
  nitro: () => input.push("nitro"),
});

/** Behind the menus, the game plays itself. */
function demoGame() {
  pilot = new Autopilot(SHARP);
  return new Game({ sfx: silentSfx });
}

function show(next: Screen) {
  screen = next;
  ui.setScreen(next);
}

function hintText(id: HintId): string | null {
  if (save.runs > 2) return null; // only for the first few runs
  const touch = input.touch;
  const texts: Record<HintId, string> = {
    lane: touch ? "Geser kiri / kanan untuk pindah jalur" : "← → (atau A / D) untuk pindah jalur",
    jump: touch ? "Geser ke atas untuk lompat" : "↑ atau Spasi untuk lompat",
    duck: touch ? "Geser ke bawah untuk merunduk" : "↓ untuk merunduk",
    ramp: "Ombak! Naiki rampnya untuk terbang",
    trick: touch
      ? "Ketuk layar untuk salto. Selesaikan sebelum mendarat!"
      : "Tekan ↑ / Spasi untuk salto. Selesaikan sebelum mendarat!",
    nitro: touch ? "Nitro penuh! Ketuk tombol NITRO" : "Nitro penuh! Tekan Shift",
    banana: "Banana boat lewat! Cari jalur yang kosong",
    traffic: "Jetski lain di depan: salip dari samping",
    police: touch
      ? "Polairud mengejar! Jangan menabrak, ketuk NITRO untuk kabur"
      : "Polairud mengejar! Jangan menabrak, tekan Shift (nitro) untuk kabur",
  };
  return texts[id];
}

function play() {
  commit();
  revives = 0;
  sound.unlock();
  sound.click();
  save.runs++;
  writeSave(save);
  game = new Game({
    sfx,
    onHint: (id) => {
      const text = hintText(id);
      if (text) ui.hint(text);
    },
  });
  announced = new Set();
  sound.intensity = 0;
  sound.startMusic();
  sound.startEngine();
  input.reset();
  input.enabled = true;
  ui.resetHud();
  show("playing");
}

function pause() {
  if (screen !== "playing") return;
  input.enabled = false;
  sound.suspend();
  show("paused");
}

function resume() {
  if (screen !== "paused") return;
  sound.resume();
  input.reset();
  input.enabled = true;
  show("playing");
}

function toMenu() {
  commit();
  sound.resume();
  sound.stopMusic();
  sound.stopEngine();
  input.enabled = false;
  game = demoGame();
  ui.renderTitle(save);
  ui.renderMissions(save.missions);
  show("title");
}

function finish() {
  pending = game.outcome;
  // What the run earns, shown now and banked when the player moves on.
  const preview = settle(structuredClone(save.missions), pending);
  sound.stopMusic(1.2);
  sound.stopEngine();
  input.enabled = false;
  ui.showOver(pending, game.cause, pending.score > save.best, preview.done, preview.reward, {
    cost: reviveCost(),
    coins: save.coins,
  });
  show("over");
}

/** Banks a finished run: coins, mission rewards, best score. */
function commit() {
  if (!pending) return;
  const missions = settle(save.missions, pending);
  save.coins += pending.coins + missions.reward;
  save.best = Math.max(save.best, pending.score);
  pending = null;
  writeSave(save);
  ui.renderTitle(save);
  ui.renderMissions(save.missions);
}

/** Pays coins to carry on the same run from where it ended. */
function revive() {
  if (!pending || screen !== "over" || save.coins < reviveCost()) return;
  save.coins -= reviveCost();
  revives++;
  writeSave(save);
  pending = null;
  game.revive();
  sound.startMusic();
  sound.startEngine();
  if (game.police.active) sound.siren(true);
  input.reset();
  input.enabled = true;
  ui.resetHud();
  show("playing");
}

function cycleQuality() {
  save.quality = QUALITIES[(QUALITIES.indexOf(save.quality) + 1) % QUALITIES.length];
  writeSave(save);
  // The renderer is built for one quality: start it afresh.
  location.reload();
}

/** Cheers a mission the moment it is done; the coins are paid at the end of the run. */
function checkMissions() {
  const outcome = game.outcome;
  save.missions.active.forEach((slot, i) => {
    if (announced.has(i)) return;
    const mission = missionAt(slot.n);
    if (progressOf(slot, outcome) < mission.target) return;
    announced.add(i);
    game.announce(`Misi selesai! +${mission.reward} koin`);
    sound.power("double");
  });
}

function openGarage() {
  commit();
  if (screen === "title" || screen === "over") garageFrom = screen;
  sound.unlock();
  ui.renderGarage(save);
  show("garage");
}

function choose(skin: Skin) {
  if (!save.owned.includes(skin.id)) {
    if (save.coins < skin.price) return;
    save.coins -= skin.price;
    save.owned.push(skin.id);
    sound.power("double");
  } else {
    sound.click();
  }
  save.skin = skin.id;
  writeSave(save);
  ui.renderGarage(save);
}

function toggleMute() {
  sound.unlock();
  save.muted = !save.muted;
  sound.setMuted(save.muted);
  ui.setMuted(save.muted);
  writeSave(save);
}

// Frame pacing. Timestamps from the browser jitter; a lightly smoothed step reads
// as smoother motion. On a 120 Hz screen that cannot be held, render every other
// refresh: a steady 60 beats lurching between 120 and 60.
let last = performance.now();
let lastTick = last;
let step = 1 / 60;
let halfRate = false;
let skip = false;
const ticks: number[] = [];
const gaps: number[] = [];
function frame(now: number) {
  requestAnimationFrame(frame);
  ticks.push(now - lastTick);
  lastTick = now;
  if (halfRate && (skip = !skip)) return;
  const raw = Math.min(0.05, (now - last) / 1000);
  gaps.push(now - last);
  last = now;
  step += (raw - step) * 0.3;
  const dt = step;
  if (ticks.length >= 240) {
    ticks.sort((a, b) => a - b);
    const refresh = ticks[ticks.length >> 1];
    const missed = gaps.filter((g) => g > refresh * 1.5).length / gaps.length;
    if (!halfRate && refresh < 11 && missed > 0.12 && screen === "playing") halfRate = true;
    ticks.length = 0;
    gaps.length = 0;
  }

  if (input.consumeMute()) toggleMute();
  const pauseKey = input.consumePause();
  if (screen === "playing" && pauseKey) pause();
  else if (screen === "paused" && pauseKey) resume();
  else if (screen === "garage" && pauseKey) show(garageFrom);
  if (input.consumeConfirm() && (screen === "title" || screen === "over")) play();

  if (screen === "playing") {
    for (const action of input.take()) game.act(action);
    game.update(dt);
    const p = game.player;
    sound.setEngine(p.speed, p.air !== "none", p.boost > 0);
    sound.intensity = p.z > 1000 ? 2 : p.z > 300 ? 1 : 0;
    sound.boosted = p.boost > 0;
    if (game.police.active) sound.setSiren(Math.min(1, Math.max(0, 1 - (game.police.gap - 5) / 45)));
    checkMissions();
    if (game.state === "over") finish();
  } else if (screen !== "paused") {
    // The demo keeps riding behind the menus; the crashed run stays on the result screen.
    if (screen !== "over") {
      pilotWait -= dt;
      const action = pilotWait <= 0 ? pilot.decide(game) : null;
      if (action) {
        game.act(action);
        pilotWait = 0.08;
      }
      if (game.state === "over" || game.player.z > 3000) game = demoGame();
      game.popups = []; // the demo's cheers would talk over the menu
    }
    game.update(dt);
  }

  renderer.draw(game, skinById(save.skin), screen === "paused" ? 0 : dt);
  if (screen === "playing" || screen === "paused") ui.updateHud(game);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  pause();
  commit(); // never lose a finished run's coins to a closed tab
});
window.addEventListener("pagehide", () => commit());
window.addEventListener("blur", () => pause());

sound.setMuted(save.muted);
ui.setMuted(save.muted);
ui.setQuality(save.quality);
ui.renderTitle(save);
ui.renderMissions(save.missions);
show("title");
requestAnimationFrame(frame);

// Test hook for the browser checks; not in the production build.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __gaspol: {
      get game() {
        return game;
      },
      get screen() {
        return screen;
      },
      save,
      sound,
      renderer,
      play,
    },
  });
}
