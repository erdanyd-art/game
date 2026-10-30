import "./style.css";
import { Sound } from "./audio.ts";
import { Autopilot, SHARP } from "./autopilot.ts";
import { Game, silentSfx, type HintId } from "./game.ts";
import { Input } from "./input.ts";
import { Renderer } from "./render.ts";
import { loadSave, skinById, writeSave, type Skin } from "./save.ts";
import { Ui, type Screen } from "./ui.ts";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const sound = new Sound();
const renderer = new Renderer(canvas);
const input = new Input(canvas);
const save = loadSave();

let screen: Screen = "title";
let garageFrom: Screen = "title";
let pilot = new Autopilot(SHARP);
let pilotWait = 0;
let game = demoGame();

const ui = new Ui({
  play: () => play(),
  pause: () => pause(),
  resume: () => resume(),
  restart: () => play(),
  menu: () => toMenu(),
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
  };
  return texts[id];
}

function play() {
  sound.unlock();
  sound.click();
  save.runs++;
  writeSave(save);
  game = new Game({
    sfx: sound,
    onHint: (id) => {
      const text = hintText(id);
      if (text) ui.hint(text);
    },
  });
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
  sound.resume();
  sound.stopMusic();
  sound.stopEngine();
  input.enabled = false;
  game = demoGame();
  ui.renderTitle(save);
  show("title");
}

function finish() {
  const outcome = game.outcome;
  const best = outcome.score > save.best;
  save.coins += outcome.coins;
  if (best) save.best = outcome.score;
  writeSave(save);
  sound.stopMusic(1.2);
  sound.stopEngine();
  input.enabled = false;
  ui.showOver(outcome, game.cause, best);
  show("over");
}

function openGarage() {
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

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

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
  requestAnimationFrame(frame);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});
window.addEventListener("blur", () => pause());

sound.setMuted(save.muted);
ui.setMuted(save.muted);
ui.renderTitle(save);
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
      play,
    },
  });
}
