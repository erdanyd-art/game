import * as THREE from "three";
import { createRng } from "../rng.ts";

// Every texture is generated at startup: no image files to download.

type Wave2 = { kx: number; ky: number; amp: number; phase: number };

/** Random sinusoids with whole-number frequencies: they tile seamlessly. */
function tileableWaves(count: number, maxFreq: number, seed: number, falloff: number): Wave2[] {
  const rng = createRng(seed);
  const waves: Wave2[] = [];
  while (waves.length < count) {
    const kx = Math.round((rng() * 2 - 1) * maxFreq);
    const ky = Math.round((rng() * 2 - 1) * maxFreq);
    if (kx === 0 && ky === 0) continue;
    waves.push({ kx, ky, amp: 1 / Math.pow(Math.hypot(kx, ky), falloff), phase: rng() * Math.PI * 2 });
  }
  return waves;
}

function repeat(texture: THREE.Texture, colour = true) {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  if (colour) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Small ripples for the ocean: a seamless normal map from analytic slopes. */
export function waterNormals(size = 256): THREE.DataTexture {
  const waves = tileableWaves(48, 14, 7, 1.25);
  const data = new Uint8Array(size * size * 4);
  const tau = (Math.PI * 2) / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0;
      let dy = 0;
      for (const w of waves) {
        const c = Math.cos(tau * (w.kx * x + w.ky * y) + w.phase) * w.amp;
        dx += c * w.kx;
        dy += c * w.ky;
      }
      const nx = -dx * 0.06;
      const ny = -dy * 0.06;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return repeat(texture, false) as THREE.DataTexture;
}

/** Cellular-looking foam pattern, seamless, in the red channel. */
export function foamTexture(size = 256): THREE.DataTexture {
  const waves = tileableWaves(40, 18, 21, 0.9);
  const data = new Uint8Array(size * size * 4);
  const tau = (Math.PI * 2) / size;
  let min = Infinity;
  let max = -Infinity;
  const raw = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 0;
      for (const w of waves) h += Math.sin(tau * (w.kx * x + w.ky * y) + w.phase) * w.amp;
      // Folding the field makes thin bright ridges, like streaks of foam.
      const v = 1 - Math.abs(h);
      raw[y * size + x] = v;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  for (let i = 0; i < raw.length; i++) {
    const v = Math.pow((raw[i] - min) / (max - min), 3);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v * 255;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return repeat(texture, false) as THREE.DataTexture;
}

function canvas(size: number, paint: (g: CanvasRenderingContext2D, rng: () => number) => void, seed = 1) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  paint(c.getContext("2d")!, createRng(seed));
  return new THREE.CanvasTexture(c);
}

export function sandTexture() {
  return repeat(
    canvas(512, (g, rng) => {
      g.fillStyle = "#d8b98e";
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 26000; i++) {
        const l = 60 + rng() * 30;
        g.fillStyle = `hsla(${32 + rng() * 10}, ${30 + rng() * 25}%, ${l}%, ${0.25 + rng() * 0.35})`;
        g.fillRect(rng() * 512, rng() * 512, 1 + rng() * 2, 1 + rng() * 2);
      }
      // Wind ripples.
      g.strokeStyle = "rgba(120,90,55,0.08)";
      g.lineWidth = 3;
      for (let y = 0; y < 512; y += 14) {
        g.beginPath();
        for (let x = 0; x <= 512; x += 16) g.lineTo(x, y + Math.sin((x / 512) * Math.PI * 4 + y) * 4);
        g.stroke();
      }
    }),
  );
}

export function barkTexture() {
  return repeat(
    canvas(256, (g, rng) => {
      g.fillStyle = "#6e4e33";
      g.fillRect(0, 0, 256, 256);
      for (let y = 0; y < 256; y += 9 + Math.floor(rng() * 6)) {
        g.fillStyle = `rgba(40,25,15,${0.35 + rng() * 0.3})`;
        g.fillRect(0, y, 256, 2 + rng() * 2);
        g.fillStyle = `rgba(160,125,90,${0.15 + rng() * 0.15})`;
        g.fillRect(0, y + 3, 256, 1);
      }
      for (let i = 0; i < 3000; i++) {
        g.fillStyle = `rgba(${rng() < 0.5 ? "30,20,10" : "150,120,90"},${rng() * 0.25})`;
        g.fillRect(rng() * 256, rng() * 256, 1 + rng() * 3, 1);
      }
    }, 3),
  );
}

export function plankTexture() {
  return repeat(
    canvas(256, (g, rng) => {
      for (let i = 0; i < 8; i++) {
        const tone = 95 + rng() * 40;
        g.fillStyle = `rgb(${tone + 30},${tone - 5},${tone - 45})`;
        g.fillRect(0, i * 32, 256, 30);
        for (let k = 0; k < 40; k++) {
          g.strokeStyle = `rgba(60,35,15,${rng() * 0.25})`;
          g.beginPath();
          const y = i * 32 + rng() * 30;
          g.moveTo(0, y);
          g.bezierCurveTo(80, y + rng() * 4 - 2, 170, y + rng() * 4 - 2, 256, y);
          g.stroke();
        }
        g.fillStyle = "rgba(25,15,8,0.8)";
        g.fillRect(0, i * 32 + 30, 256, 2);
      }
    }, 5),
  );
}

export function thatchTexture() {
  return repeat(
    canvas(256, (g, rng) => {
      g.fillStyle = "#b8925a";
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 1400; i++) {
        const x = rng() * 256;
        const y = rng() * 256;
        g.strokeStyle = `rgba(${rng() < 0.5 ? "90,60,25" : "230,200,140"},${0.2 + rng() * 0.4})`;
        g.lineWidth = 1 + rng();
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + rng() * 4 - 2, y + 18 + rng() * 20);
        g.stroke();
      }
    }, 9),
  );
}

export function chevronTexture() {
  const texture = canvas(256, (g) => {
    g.fillStyle = "#ff9500";
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = "#1b1b1b";
    for (let i = 0; i < 4; i++) {
      const y = 20 + i * 62;
      g.beginPath();
      g.moveTo(20, y + 34);
      g.lineTo(128, y);
      g.lineTo(236, y + 34);
      g.lineTo(236, y + 56);
      g.lineTo(128, y + 22);
      g.lineTo(20, y + 56);
      g.closePath();
      g.fill();
    }
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.lineWidth = 6;
    g.strokeRect(3, 3, 250, 250);
  });
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A palm frond: leaflets along a midrib, on transparency. */
export function frondTexture() {
  const texture = canvas(256, (g, rng) => {
    g.clearRect(0, 0, 256, 256);
    g.strokeStyle = "#4f6b2a";
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(128, 0);
    g.lineTo(128, 256);
    g.stroke();
    for (let y = 6; y < 250; y += 7) {
      const t = y / 256;
      const reach = 118 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (0.75 + rng() * 0.25);
      for (const side of [-1, 1]) {
        const shade = 70 + rng() * 40;
        g.strokeStyle = `rgb(${shade * 0.55},${shade + 40},${shade * 0.35})`;
        g.lineWidth = 3.5;
        g.beginPath();
        g.moveTo(128, y);
        g.quadraticCurveTo(128 + side * reach * 0.5, y + 6, 128 + side * reach, y + 22);
        g.stroke();
      }
    }
  }, 11);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function netTexture() {
  const texture = canvas(128, (g) => {
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = "rgba(30,40,40,0.85)";
    g.lineWidth = 2;
    for (let i = 0; i <= 128; i += 16) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, 128);
      g.moveTo(0, i);
      g.lineTo(128, i);
      g.stroke();
    }
  });
  return repeat(texture);
}

export function signTexture(text: string, bg: string, fg: string) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = fg;
  g.font = "bold 34px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 128, 34);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A soft cloud: many overlapping puffs, fuller on top, flatter underneath. */
export function cloudTexture(seed: number) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const g = c.getContext("2d")!;
  const rng = createRng(seed);
  for (let i = 0; i < 70; i++) {
    const x = 60 + rng() * 392;
    const spread = 1 - Math.abs(x - 256) / 256;
    const y = 170 - rng() * 110 * spread;
    const r = 18 + rng() * 52 * (0.4 + spread);
    const puff = g.createRadialGradient(x, y, 0, x, y, r);
    puff.addColorStop(0, `rgba(255,255,255,${0.16 + rng() * 0.14})`);
    puff.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = puff;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // A flat, fading base.
  const fade = g.createLinearGradient(0, 150, 0, 215);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(1, "rgba(0,0,0,1)");
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = fade;
  g.fillRect(0, 150, 512, 106);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Foam hugging something in the water: a speckled ring that fades out. */
export function foamRingTexture() {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const rng = createRng(31);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x / size - 0.5;
      const dy = y / size - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const ring = Math.exp(-(((r - 0.62) / 0.2) ** 2)) * (r < 1 ? 1 : 0);
      const speckle = 0.45 + 0.55 * Math.sin(x * 0.9 + rng() * 2) * Math.sin(y * 0.8 + rng() * 2);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.max(0, Math.min(255, ring * (0.4 + speckle * 0.6) * 255));
    }
  }
  g.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
