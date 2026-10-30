import "./style.css";
import { Sound } from "./audio.ts";
import { Game, silentSfx, type HintId, type Steering } from "./game.ts";
import { Input } from "./input.ts";
import { createLevel } from "./level.ts";
import { NIGHTS, type Night } from "./nights.ts";
import { isUnlocked, loadProgress, saveProgress } from "./progress.ts";
import { Renderer } from "./render.ts";
import { Ui, type Screen } from "./ui.ts";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const sound = new Sound();
const renderer = new Renderer(canvas);
const input = new Input(canvas, () => sound.now());
const progress = loadProgress();

let screen: Screen = "title";
let night: Night = NIGHTS[0];
let game = demoGame();
let musicPlaying = false;

const ui = new Ui({
  pick: (picked) => play(picked),
  pause: () => pause(),
  resume: () => resume(),
  restart: () => play(night),
  menu: () => toMenu(),
  next: () => {
    const next = NIGHTS[night.number];
    if (next) play(next);
  },
  toggleMute: () => toggleMute(),
});

/** The title screen's backdrop: a swarm drifting upriver on its own, in silence. */
function demoGame() {
  return new Game(createLevel(NIGHTS[0]), { clock: () => performance.now() / 1000, sfx: silentSfx, demo: true });
}

function hintText(id: HintId): string | null {
  const touch = input.touch;
  const first = night.number === 1;
  switch (id) {
    case "move":
      if (!first) return null;
      return touch
        ? "Geser jempol di sisi kiri layar untuk memandu kawanan."
        : "Gerakkan mouse (atau WASD) untuk memandu kawanan.";
    case "rhythm":
      if (!first) return null;
      return touch
        ? "Ketuk sisi kanan tepat saat lingkaran menyentuh tepi cahayamu, seirama gamelan."
        : "Klik atau tekan Spasi tepat saat lingkaran menyentuh tepi cahayamu, seirama gamelan.";
    case "call":
      return first
        ? "Kunang-kunang liar! Berkedip seirama di dekat mereka. Makin tepat, makin cepat mereka percaya dan ikut."
        : null;
    case "grow":
      return first ? "Kawanan makin besar, cahaya makin luas." : null;
    case "miss":
      return first ? "Kedipan meleset membuat beberapa kunang-kunang tercerai. Panggil lagi mereka." : null;
    case "frog":
      return night.number <= 2
        ? "Katak! Ia menyerang tepat di ketukan. Keluar dari lingkaran merah, atau kedip \"Pas!\" untuk menyilaukannya."
        : null;
    case "bat":
      return night.number === 3
        ? "Kelelawar menukik dari gelap, juga di ketukan. Matanya membesar dulu; kedip \"Pas!\" untuk mengusirnya."
        : null;
    case "tree":
      return first ? "Pohon Kunang di depan. Bawa kawananmu masuk!" : null;
  }
}

function play(picked: Night) {
  sound.unlock();
  sound.click();
  night = picked;
  game = new Game(createLevel(picked), {
    clock: () => sound.now(),
    sfx: sound,
    onHint: (id) => {
      const text = hintText(id);
      if (text) ui.hint(text);
    },
  });
  game.setBeat(sound.startMusic(picked.bpm), 60 / picked.bpm);
  musicPlaying = true;
  renderer.snap(game);
  input.reset();
  input.enabled = true;
  ui.clearHints();
  ui.resetHud();
  ui.setScreen("playing");
  ui.showIntro(picked);
  screen = "playing";
}

function pause() {
  if (screen !== "playing") return;
  screen = "paused";
  input.enabled = false;
  sound.suspend();
  ui.setScreen("paused");
}

function resume() {
  if (screen !== "paused") return;
  sound.resume();
  input.reset();
  input.enabled = true;
  screen = "playing";
  ui.setScreen("playing");
}

function toMenu() {
  sound.resume();
  sound.stopMusic();
  musicPlaying = false;
  input.enabled = false;
  ui.clearHints();
  game = demoGame();
  renderer.snap(game);
  ui.renderNights(progress);
  ui.setScreen("title");
  screen = "title";
}

function finish() {
  const outcome = game.outcome;
  if (!outcome) return;
  if (musicPlaying) sound.stopMusic(1.6);
  musicPlaying = false;
  input.enabled = false;
  const index = night.number - 1;
  if (outcome.kind === "home") {
    progress.stars[index] = Math.max(progress.stars[index], outcome.stars);
    saveProgress(progress);
  }
  ui.clearHints();
  ui.renderNights(progress);
  ui.showResult(outcome, night, index + 1 < NIGHTS.length && isUnlocked(progress, index + 1));
  ui.setScreen("result");
  screen = "result";
}

function toggleMute() {
  sound.unlock();
  progress.muted = !progress.muted;
  sound.setMuted(progress.muted);
  ui.setMuted(progress.muted);
  saveProgress(progress);
}

function steering(): Steering | null {
  const steer = input.steer();
  if (!steer) return null;
  if (steer.kind === "direction") return steer;
  const world = renderer.screenToWorld(steer.sx, steer.sy);
  return { kind: "point", x: world.x, y: world.y };
}

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (input.consumeMute()) toggleMute();
  const pauseKey = input.consumePause();
  if (screen === "playing" && pauseKey) pause();
  else if (screen === "paused" && pauseKey) resume();

  if (screen === "playing") {
    for (const time of input.takeFlashes()) game.flash(time);
    game.update(dt, steering());
    // A loss silences the gamelan at once; a homecoming lets it ring until the result.
    if (game.outcome && game.outcome.kind !== "home" && musicPlaying) {
      sound.stopMusic(1.2);
      musicPlaying = false;
    }
    if (game.finished) finish();
  } else if (screen !== "paused") {
    game.update(dt, null);
    if (game.demoDone) {
      game = demoGame();
      renderer.snap(game);
    }
  }

  renderer.follow(game, screen === "paused" ? 0 : dt);
  const view = input.view();
  renderer.draw(game, { playing: screen === "playing", cursor: view.cursor, stick: view.stick, touch: view.touch });
  if (screen === "playing" || screen === "paused") ui.updateHud(game);
  document.body.classList.toggle("touch", view.touch);
  requestAnimationFrame(frame);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});
window.addEventListener("blur", () => pause());

sound.setMuted(progress.muted);
ui.setMuted(progress.muted);
ui.renderNights(progress);
ui.setScreen("title");
renderer.snap(game);
requestAnimationFrame(frame);

// Test hook for the browser checks; not part of the production build.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __kunang: {
      get game() {
        return game;
      },
      get screen() {
        return screen;
      },
      sound,
      progress,
      play: (index: number) => play(NIGHTS[index]),
    },
  });
}
