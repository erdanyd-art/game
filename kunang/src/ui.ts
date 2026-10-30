import type { Game, Outcome } from "./game.ts";
import { NIGHTS, STAR_THRESHOLDS, type Night } from "./nights.ts";
import { isUnlocked, type Progress } from "./progress.ts";

export type Screen = "title" | "playing" | "paused" | "result";

const STAR_PATH = "M12 2.5l2.9 6.2 6.8.7-5.1 4.6 1.5 6.7L12 17.3l-6.1 3.4 1.5-6.7-5.1-4.6 6.8-.7z";
const SVG = "http://www.w3.org/2000/svg";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

function star(earned: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (earned) svg.classList.add("earned");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", STAR_PATH);
  svg.append(path);
  return svg;
}

function lockIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("lock");
  svg.innerHTML = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
  return svg;
}

const RESULT_COPY: Record<Outcome["kind"], { title: string; line: (o: Outcome) => string }> = {
  home: {
    title: "Pohon menyala",
    line: (o) => `${o.delivered} dari ${o.total} kunang-kunang pulang.`,
  },
  dark: {
    title: "Cahaya padam",
    line: () => "Semua kunang-kunang hilang ditelan malam.",
  },
  dawn: {
    title: "Fajar tiba",
    line: () => "Matahari terbit sebelum kawananmu sampai di pohon.",
  },
};

export type UiHandlers = {
  pick: (night: Night) => void;
  pause: () => void;
  resume: () => void;
  restart: () => void;
  menu: () => void;
  next: () => void;
  toggleMute: () => void;
};

/** The DOM side of the game: menus, HUD, hints. The canvas never holds text you must read. */
export class Ui {
  private readonly screens = {
    title: el("screen-title"),
    paused: el("screen-pause"),
    result: el("screen-result"),
  };
  private readonly hud = el("hud");
  private readonly count = el("hud-count");
  private readonly sync = el("hud-sync");
  private readonly combo = el("hud-combo");
  private readonly progress = el("hud-progress");
  private readonly dawn = el("hud-dawn");
  private readonly hintBox = el("hint");
  private readonly intro = el("intro");
  private readonly muteButton = el<HTMLButtonElement>("btn-mute");
  private readonly soundButton = el<HTMLButtonElement>("btn-sound");
  private shown = { count: -1, combo: -1, sync: -1, progress: -1, dawn: "" };
  private hints: string[] = [];
  private hintTimer = 0;
  private introTimer = 0;

  constructor(handlers: UiHandlers) {
    el("nights").addEventListener("click", (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>("button[data-night]");
      if (button && !button.disabled) handlers.pick(NIGHTS[Number(button.dataset.night)]);
    });
    const wire = (id: string, action: () => void) =>
      el(id).addEventListener("click", (e) => {
        // Buttons must not keep focus, or Space (the flash key) would press them again.
        (e.currentTarget as HTMLElement).blur();
        action();
      });
    wire("btn-resume", handlers.resume);
    wire("btn-restart", handlers.restart);
    wire("btn-quit", handlers.menu);
    wire("btn-next", handlers.next);
    wire("btn-retry", handlers.restart);
    wire("btn-menu", handlers.menu);
    wire("btn-pause", handlers.pause);
    wire("btn-mute", handlers.toggleMute);
    wire("btn-sound", handlers.toggleMute);

    const touch = matchMedia("(pointer: coarse)").matches;
    el("controls").innerHTML = touch
      ? "Geser sisi <strong>kiri</strong> layar untuk bergerak · ketuk sisi <strong>kanan</strong> untuk berkedip"
      : "<kbd>Mouse</kbd> atau <kbd>WASD</kbd> memandu · <kbd>Klik</kbd> atau <kbd>Spasi</kbd> berkedip · <kbd>Esc</kbd> jeda · <kbd>M</kbd> suara";
  }

  setScreen(screen: Screen) {
    this.screens.title.hidden = screen !== "title";
    this.screens.paused.hidden = screen !== "paused";
    this.screens.result.hidden = screen !== "result";
    this.hud.hidden = screen === "title" || screen === "result";
    document.body.classList.toggle("playing", screen === "playing");
    if (screen !== "playing") this.hideIntro();
    const focus = { title: null, playing: null, paused: "btn-resume", result: "btn-next" }[screen];
    if (focus) {
      const button = el<HTMLButtonElement>(focus);
      (button.hidden ? el<HTMLButtonElement>("btn-retry") : button).focus({ preventScroll: true });
    }
  }

  renderNights(progress: Progress) {
    const list = el("nights");
    list.replaceChildren(
      ...NIGHTS.map((night, i) => {
        const open = isUnlocked(progress, i);
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "night";
        button.dataset.night = String(i);
        button.disabled = !open;
        const stars = progress.stars[i];
        button.setAttribute(
          "aria-label",
          open ? `Malam ${night.number}: ${night.name}. ${stars} dari 3 bintang.` : `Malam ${night.number}: terkunci`,
        );

        const number = document.createElement("span");
        number.className = "night-number";
        number.textContent = String(night.number);
        const text = document.createElement("span");
        text.className = "night-text";
        const name = document.createElement("span");
        name.className = "night-name";
        name.textContent = night.name;
        const tagline = document.createElement("span");
        tagline.className = "night-tagline";
        tagline.textContent = open ? night.tagline : "Selesaikan malam sebelumnya";
        text.append(name, tagline);
        button.append(number, text);

        if (open) {
          const row = document.createElement("span");
          row.className = "stars";
          for (let s = 0; s < 3; s++) row.append(star(s < stars));
          button.append(row);
        } else {
          button.append(lockIcon());
        }
        item.append(button);
        return item;
      }),
    );
  }

  setMuted(muted: boolean) {
    this.muteButton.setAttribute("aria-pressed", String(muted));
    this.muteButton.setAttribute("aria-label", muted ? "Nyalakan suara" : "Matikan suara");
    this.soundButton.textContent = muted ? "Suara: mati" : "Suara: nyala";
  }

  /** Writes to the DOM only when a value changed: this runs every frame. */
  updateHud(game: Game) {
    const count = game.outcome?.kind === "home" ? game.outcome.delivered : game.swarmSize;
    if (count !== this.shown.count) {
      if (count < this.shown.count) {
        this.count.classList.remove("drop");
        void this.count.offsetWidth; // restart the animation
        this.count.classList.add("drop");
      }
      this.count.textContent = String(count);
      this.shown.count = count;
    }
    if (game.combo !== this.shown.combo) {
      this.combo.textContent = game.combo >= 2 ? `Kombo ×${game.combo}` : "";
      this.shown.combo = game.combo;
    }
    const sync = Math.round(game.sync * 100);
    if (sync !== this.shown.sync) {
      this.sync.style.width = `${sync}%`;
      this.shown.sync = sync;
    }
    const progress = Math.round(game.progress * 1000) / 10;
    if (progress !== this.shown.progress) {
      this.progress.style.width = `${progress}%`;
      this.shown.progress = progress;
    }
    const left = Math.max(0, Math.ceil(game.level.night.dawnSeconds - game.time));
    const dawn = `Fajar dalam ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (dawn !== this.shown.dawn) {
      this.dawn.textContent = dawn;
      this.dawn.classList.toggle("soon", left <= 25);
      this.shown.dawn = dawn;
    }
  }

  resetHud() {
    this.shown = { count: -1, combo: -1, sync: -1, progress: -1, dawn: "" };
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

  showIntro(night: Night) {
    el("intro-night").textContent = `Malam ${night.number}`;
    el("intro-name").textContent = night.name;
    el("intro-tag").textContent = night.tagline;
    this.intro.classList.add("show");
    window.clearTimeout(this.introTimer);
    this.introTimer = window.setTimeout(() => this.hideIntro(), 2600);
  }

  showResult(outcome: Outcome, night: Night, hasNext: boolean) {
    const copy = RESULT_COPY[outcome.kind];
    el("result-night").textContent = `Malam ${night.number} · ${night.name}`;
    const won = outcome.kind === "home";
    el("result-title").textContent =
      won && outcome.stars === 0 ? "Belum cukup terang" : won && !hasNext ? "Semua malam terang" : copy.title;
    const stars = el("result-stars");
    stars.hidden = !won;
    stars.replaceChildren(...[0, 1, 2].map((i) => star(i < outcome.stars)));
    stars.setAttribute("aria-label", `${outcome.stars} dari 3 bintang`);
    stars.setAttribute("role", "img");
    let line = copy.line(outcome);
    if (won && outcome.stars === 0) {
      line += ` Bawa pulang ${Math.ceil(outcome.total * STAR_THRESHOLDS[0])} untuk bintang pertama.`;
    }
    el("result-line").textContent = line;
    const stats: [string, number][] = [
      ["Kombo terbaik", outcome.bestCombo],
      ["Tepat", outcome.perfect],
      ["Meleset", outcome.miss],
      ["Dimangsa", outcome.eaten],
    ];
    el("result-stats").replaceChildren(
      ...stats.map(([label, value]) => {
        const row = document.createElement("div");
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = String(value);
        row.append(dt, dd);
        return row;
      }),
    );
    el("btn-next").hidden = !(won && hasNext && outcome.stars > 0);
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
      }, 450);
    }, 4800);
  }

  private hideIntro() {
    window.clearTimeout(this.introTimer);
    this.intro.classList.remove("show");
  }
}
