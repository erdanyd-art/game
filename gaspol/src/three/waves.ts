// Gerstner waves, shared by the ocean shader and by everything that floats.
// Coordinates here are the game's: x across the lanes, z forward.
// Amplitudes stay modest so the lanes keep reading clearly at speed.

export type Wave = { dirX: number; dirZ: number; k: number; omega: number; amp: number; steep: number };

const G = 9.81;

function wave(angleDeg: number, length: number, amp: number, steep: number): Wave {
  const a = (angleDeg * Math.PI) / 180;
  const k = (Math.PI * 2) / length;
  return { dirX: Math.sin(a), dirZ: Math.cos(a), k, omega: Math.sqrt(G * k), amp, steep };
}

export const WAVES: readonly Wave[] = [
  wave(12, 23, 0.24, 0.6),
  wave(-38, 13.5, 0.13, 0.55),
  wave(64, 8.2, 0.07, 0.5),
  wave(-72, 5.1, 0.04, 0.45),
  wave(146, 3.3, 0.022, 0.4),
];

const TAU = Math.PI * 2;

/**
 * Phase of each wave at local z = 0 when the scene's origin sits at game z `originZ`.
 * Done here in double precision: the GPU only ever sees small numbers.
 */
export function wavePhases(originZ: number, time: number, out: Float32Array) {
  WAVES.forEach((w, i) => {
    const p = (w.k * w.dirZ * originZ - w.omega * time) % TAU;
    out[i] = p < 0 ? p + TAU : p;
  });
  return out;
}

/** Height of the sea at a game position (horizontal drift of the crests is ignored). */
export function waveHeight(x: number, z: number, time: number) {
  let y = 0;
  for (const w of WAVES) y += w.amp * Math.sin(w.k * (w.dirX * x + w.dirZ * z) - w.omega * time);
  return y;
}

/** Surface slope at a game position: how a floating thing should pitch and roll. */
export function waveSlope(x: number, z: number, time: number) {
  let dx = 0;
  let dz = 0;
  for (const w of WAVES) {
    const c = w.amp * w.k * Math.cos(w.k * (w.dirX * x + w.dirZ * z) - w.omega * time);
    dx += c * w.dirX;
    dz += c * w.dirZ;
  }
  return { dx, dz };
}

/** GLSL for the same waves; local x and three.js z (= originZ - game z). */
export const WAVE_GLSL = /* glsl */ `
uniform float uPhase[${WAVES.length}];
const int WAVE_COUNT = ${WAVES.length};
const vec2 WAVE_DIR[${WAVES.length}] = vec2[](${WAVES.map((w) => `vec2(${w.dirX.toFixed(6)}, ${w.dirZ.toFixed(6)})`).join(", ")});
const float WAVE_K[${WAVES.length}] = float[](${WAVES.map((w) => w.k.toFixed(6)).join(", ")});
const float WAVE_A[${WAVES.length}] = float[](${WAVES.map((w) => w.amp.toFixed(6)).join(", ")});
const float WAVE_Q[${WAVES.length}] = float[](${WAVES.map((w) => w.steep.toFixed(6)).join(", ")});

// p: local position (three.js axes). Returns displaced position; writes the normal.
vec3 gerstner(vec3 p, out vec3 n, out float height) {
  vec3 q = p;
  vec3 g = vec3(0.0, 1.0, 0.0);
  height = 0.0;
  for (int i = 0; i < WAVE_COUNT; i++) {
    vec2 d = WAVE_DIR[i];
    float k = WAVE_K[i];
    float a = WAVE_A[i];
    float theta = k * (d.x * p.x - d.y * p.z) + uPhase[i];
    float s = sin(theta);
    float c = cos(theta);
    q.x += WAVE_Q[i] * a * d.x * c;
    q.z -= WAVE_Q[i] * a * d.y * c;
    q.y += a * s;
    height += a * s;
    g.x -= d.x * k * a * c;
    g.z += d.y * k * a * c;
    g.y -= WAVE_Q[i] * k * a * s;
  }
  n = normalize(g);
  return q;
}
`;
