# Gaspol! Jetski Pantai

An endless lane runner on a jetski along a Bali beach at sunset. Dodge
outrigger boats and rocks, hop logs and nets, duck under flag lines and piers,
launch off wave ramps for backflips, and fire nitro to smash through it all.

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/, host it anywhere
npm test         # course solver and game rules
```

No assets: the scene is drawn on a canvas in pseudo-3D, and the music, engine
and effects are synthesised with Web Audio. The only thing fetched at runtime is
the font (Lilita One and Nunito from Google Fonts). Best score, coins, skins and
the sound setting are kept in this browser's `localStorage`.

## Controls

| | Keyboard | Touch |
|---|---|---|
| Change lane | ← → or A D | swipe left / right |
| Jump | ↑, W or Space | swipe up |
| Duck (slam down in the air) | ↓ or S | swipe down |
| Backflip off a ramp | ↑ or Space in the air | tap |
| Nitro | Shift, E or N | NITRO button |
| Pause / sound | Esc or P / M | buttons |

## Never impossible

The course is generated from hand-made patterns of three-lane rows, spaced in
seconds so they feel the same at any speed. `test/course.test.ts` has a solver
that plays hundreds of generated courses with perfect foresight and the real
physics from `src/config.ts`, and fails if any of them cannot be finished. It
accounts for the length of obstacles (you cannot move over while a boat is
still alongside), the arc of a ramp jump over a whole boat, and a person's
reaction time between lane changes.

Moving obstacles (the banana boat, other jetskis) keep themselves on schedule
for the moment the player reaches them, so a lane that was safe stays safe even
if nitro or a bump changes your speed. Nitro ends with a second of grace.

## How it fits together

- `src/config.ts`: physics, obstacle sizes, speed curve.
- `src/course.ts`: the pattern library and generator.
- `src/game.ts`: the simulation (no DOM): movement, collisions, scoring,
  combo, power-ups, nitro.
- `src/autopilot.ts`: a rider that plays by itself, for the title screen and
  balance checks.
- `src/render.ts`: the pseudo-3D renderer.
- `src/audio.ts`, `src/input.ts`, `src/ui.ts`, `src/save.ts`, `src/main.ts`.
