import { COMBO_STEP, type Game, type Outcome } from "./game.ts";
import { describe, missionAt, type Mission, type MissionState } from "./missions.ts";
import { SKINS, type Save, type Skin } from "./save.ts";

export type Screen = "title" | "garage" | "playing" | "paused" | "over";

export type UiHandlers = {
  play: () => void;
  pause: () => void;
  resume: () => void;
  restart: () => void;
  menu: () => void;
  revive: () => void;
  quality: () => void;
  garage: () => void;
  closeGarage: () => void;
  choose: (skin: Skin) => void;
  toggleMute: () => void;
  nitro: () => void;
};

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

const POWER_LABEL = { magnet: "Magnet", shield: "Pelampung", double: "Skor ×2" } as const;
const POWER_TIME = { magnet: 8, shield: 20, double: 10 } as const;

/** A jetski seen from behind, in the skin's colours, for the garage. */
function preview(skin: Skin): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 88");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `
    <ellipse cx="50" cy="82" rx="40" ry="5" fill="rgba(255,255,255,0.35)"/>
    <path d="M18 56 H82 L76 74 Q50 86 24 74 Z" fill="${skin.hull}"/>
    <path d="M19 61 H81 L79 66 H21 Z" fill="${skin.stripe}"/>
    <rect x="37" y="48" width="26" height="10" rx="4" fill="#1e1e24"/>
    <rect x="35" y="22" width="30" height="28" rx="8" fill="${skin.vest}"/>
    <path d="M22 40 L36 28 M78 40 L64 28" stroke="#c68642" stroke-width="6" stroke-linecap="round"/>
    <path d="M20 40 H80" stroke="#2a2a2a" stroke-width="4" stroke-linecap="round"/>
    <circle cx="50" cy="14" r="10" fill="${skin.helmet}"/>
    <rect x="41" y="12" width="18" height="4" rx="2" fill="rgba(20,20,30,0.75)"/>`;
  return svg;
}

export class Ui {
  private readonly screens = {
    title: el("screen-title"),
    garage: el("screen-garage"),
    paused: el("screen-pause"),
    over: el("screen-over"),
  };
  private readonly hud = el("hud");
  private readonly score = el("hud-score");
  private readonly distance = el("hud-distance");
  private readonly mult = el("hud-mult");
  private readonly coins = el("hud-coins");
  private readonly powers = el("hud-powers");
  private readonly nitro = el("nitro");
  private readonly nitroFill = el("nitro-fill");
  private readonly nitroButton = el<HTMLButtonElement>("btn-nitro");
  private readonly hintBox = el("hint");
  private shown = { score: -1, distance: -1, mult: 1, coins: -1, powers: "", nitro: -1, ready: false };
  private hints: string[] = [];
  private hintTimer = 0;
  private readonly handlers: UiHandlers;

  constructor(handlers: UiHandlers) {
    this.handlers = handlers;
    const wire = (id: string, action: () => void) =>
      el(id).addEventListener("click", (e) => {
        // Never keep focus on a button: Space is also the jump key.
        (e.currentTarget as HTMLElement).blur();
        action();
      });
    wire("btn-play", handlers.play);
    wire("btn-garage", handlers.garage);
    wire("btn-sound", handlers.toggleMute);
    wire("btn-garage-back", handlers.closeGarage);
    wire("btn-pause", handlers.pause);
    wire("btn-mute", handlers.toggleMute);
    wire("btn-resume", handlers.resume);
    wire("btn-restart", handlers.restart);
    wire("btn-quit", handlers.menu);
    wire("btn-again", handlers.play);
    wire("btn-revive", handlers.revive);
    wire("btn-quality", handlers.quality);
    wire("btn-over-garage", handlers.garage);
    wire("btn-over-menu", handlers.menu);
    // pointerdown, not click: on a phone the nitro button must react instantly.
    this.nitroButton.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handlers.nitro();
    });

    const touch = matchMedia("(pointer: coarse)").matches;
    document.body.classList.toggle("touch", touch);
    el("controls").innerHTML = touch
      ? "Geser <strong>kiri/kanan</strong> pindah jalur · geser <strong>atas</strong> lompat · geser <strong>bawah</strong> merunduk · <strong>ketuk</strong> di udara untuk salto"
      : "<kbd>←</kbd> <kbd>→</kbd> pindah jalur · <kbd>↑</kbd>/<kbd>Spasi</kbd> lompat (salto di udara) · <kbd>↓</kbd> merunduk · <kbd>Shift</kbd> nitro · <kbd>Esc</kbd> jeda";
  }

  setScreen(screen: Screen) {
    this.screens.title.hidden = screen !== "title";
    this.screens.garage.hidden = screen !== "garage";
    this.screens.paused.hidden = screen !== "paused";
    this.screens.over.hidden = screen !== "over";
    this.hud.hidden = !(screen === "playing" || screen === "paused");
    if (screen !== "playing") this.clearHints();
    const focus = { title: "btn-play", garage: "btn-garage-back", playing: null, paused: "btn-resume", over: "btn-again" }[screen];
    if (screen === "over" && !el<HTMLButtonElement>("btn-revive").disabled && !el("btn-revive").hidden) {
      el("btn-revive").focus({ preventScroll: true });
      return;
    }
    if (focus) el(focus).focus({ preventScroll: true });
  }

  renderTitle(save: Save) {
    el("title-best").textContent = save.best.toLocaleString("id-ID");
    el("title-coins").textContent = save.coins.toLocaleString("id-ID");
  }

  setMuted(muted: boolean) {
    const button = el("btn-mute");
    button.setAttribute("aria-pressed", String(muted));
    button.setAttribute("aria-label", muted ? "Nyalakan suara" : "Matikan suara");
    el("btn-sound").textContent = muted ? "Suara: mati" : "Suara: nyala";
  }

  renderGarage(save: Save) {
    el("garage-coins").textContent = save.coins.toLocaleString("id-ID");
    el("skins").replaceChildren(
      ...SKINS.map((skin) => {
        const item = document.createElement("li");
        item.className = "skin";
        const chosen = save.skin === skin.id;
        const owned = save.owned.includes(skin.id);
        item.classList.toggle("chosen", chosen);
        const name = document.createElement("span");
        name.className = "skin-name";
        name.textContent = skin.name;
        const button = document.createElement("button");
        button.type = "button";
        if (chosen) {
          button.textContent = "Dipakai";
          button.disabled = true;
        } else if (owned) {
          button.textContent = "Pakai";
        } else {
          button.textContent = `Beli · ${skin.price}`;
          button.disabled = save.coins < skin.price;
          button.title = button.disabled ? `Butuh ${skin.price - save.coins} koin lagi` : "";
        }
        button.addEventListener("click", () => this.handlers.choose(skin));
        item.append(preview(skin), name, button);
        return item;
      }),
    );
  }

  /** The three current goals, with how far each has got. */
  renderMissions(state: MissionState) {
    el("missions").replaceChildren(
      ...state.active.map((slot) => {
        const m = missionAt(slot.n);
        const li = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = describe(m);
        const reward = document.createElement("b");
        reward.textContent = `+${m.reward}`;
        li.append(text, reward);
        if (m.total && slot.progress > 0) {
          const bar = document.createElement("i");
          bar.style.width = `${Math.min(100, (slot.progress / m.target) * 100)}%`;
          li.append(bar);
        }
        return li;
      }),
    );
  }

  setQuality(quality: "auto" | "high" | "low") {
    el("btn-quality").textContent = `Grafis: ${{ auto: "Otomatis", high: "Tinggi", low: "Rendah" }[quality]}`;
  }

  showOver(
    outcome: Outcome,
    cause: string,
    best: boolean,
    done: Mission[] = [],
    reward = 0,
    revive: { cost: number; coins: number } = { cost: 0, coins: 0 },
  ) {
    const again = el<HTMLButtonElement>("btn-revive");
    again.hidden = revive.cost === 0;
    again.disabled = revive.coins < revive.cost;
    again.textContent = revive.coins < revive.cost ? `Lanjut · ${revive.cost} koin (kurang)` : `LANJUT · ${revive.cost} koin`;
    const missions = el("over-missions");
    missions.hidden = done.length === 0;
    missions.replaceChildren(
      ...done.map((m) => {
        const li = document.createElement("li");
        li.textContent = `✓ ${describe(m)}`;
        return li;
      }),
    );
    if (done.length) {
      const total = document.createElement("li");
      total.className = "reward";
      total.textContent = `Hadiah misi +${reward} koin`;
      missions.append(total);
    }
    el("over-cause").textContent = cause;
    el("over-score").textContent = outcome.score.toLocaleString("id-ID");
    el("over-best").hidden = !best;
    const stats: [string, string][] = [
      ["Jarak", `${outcome.distance.toLocaleString("id-ID")} m`],
      ["Koin", `+${outcome.coins}`],
      ["Salto", String(outcome.tricks)],
      ["Nyaris", String(outcome.nearMisses)],
      ["Lolos polisi", String(outcome.escapes)],
      ["Kombo terbaik", `×${Math.min(3, 1 + Math.floor(outcome.bestCombo / COMBO_STEP) * 0.5)}`],
    ];
    el("over-stats").replaceChildren(
      ...stats.map(([label, value]) => {
        const row = document.createElement("div");
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        row.append(dt, dd);
        return row;
      }),
    );
  }

  /** Writes to the DOM only when something changed: this runs every frame. */
  updateHud(game: Game) {
    const p = game.player;
    const score = Math.round(game.score);
    if (score !== this.shown.score) {
      this.score.textContent = score.toLocaleString("id-ID");
      this.shown.score = score;
    }
    const distance = Math.floor(p.z);
    if (distance !== this.shown.distance) {
      this.distance.textContent = `${distance.toLocaleString("id-ID")} m`;
      this.shown.distance = distance;
    }
    if (game.multiplier !== this.shown.mult) {
      this.mult.hidden = game.multiplier <= 1;
      this.mult.textContent = `×${game.multiplier}`;
      this.mult.classList.remove("bump");
      void this.mult.offsetWidth;
      this.mult.classList.add("bump");
      this.shown.mult = game.multiplier;
    }
    if (game.coinsRun !== this.shown.coins) {
      this.coins.textContent = String(game.coinsRun);
      this.shown.coins = game.coinsRun;
    }
    const active = (["magnet", "shield", "double"] as const).filter((k) => p[k] > 0);
    const key = active.map((k) => `${k}${Math.ceil((p[k] / POWER_TIME[k]) * 20)}`).join(",");
    if (key !== this.shown.powers) {
      this.powers.replaceChildren(
        ...active.map((k) => {
          const li = document.createElement("li");
          li.textContent = POWER_LABEL[k];
          const bar = document.createElement("i");
          bar.style.width = `${(p[k] / POWER_TIME[k]) * 100}%`;
          li.append(bar);
          return li;
        }),
      );
      this.shown.powers = key;
    }
    const nitro = p.boost > 0 ? p.boost / 4 : p.nitro;
    const level = Math.round(nitro * 100);
    if (level !== this.shown.nitro) {
      this.nitroFill.style.width = `${level}%`;
      this.shown.nitro = level;
    }
    const ready = p.nitro >= 1 && p.boost <= 0;
    if (ready !== this.shown.ready) {
      this.nitro.classList.toggle("ready", ready);
      this.nitroButton.disabled = !ready;
      this.shown.ready = ready;
    }
  }

  resetHud() {
    this.shown = { score: -1, distance: -1, mult: 0, coins: -1, powers: "-", nitro: -1, ready: true };
  }

  hint(text: string) {
    if (this.hints.includes(text)) return;
    this.hints.push(text);
    if (this.hints.length === 1) this.showNextHint();
  }

  clearHints() {
    window.clearTimeout(this.hintTimer);
    this.hints = [];
    this.hintBox.classList.remove("show");
  }

  private showNextHint() {
    const text = this.hints[0];
    if (text === undefined) return;
    this.hintBox.textContent = text;
    this.hintBox.classList.add("show");
    this.hintTimer = window.setTimeout(() => {
      this.hintBox.classList.remove("show");
      this.hintTimer = window.setTimeout(() => {
        this.hints.shift();
        this.showNextHint();
      }, 300);
    }, 2600);
  }
}
