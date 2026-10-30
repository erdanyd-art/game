# Gaspol! Jetski Pantai

An endless lane runner on a jetski along a Bali beach at sunset, in real 3D.
Dodge outrigger boats and rocks, hop logs and nets, duck under flag lines and
piers, launch off wave ramps for backflips, and fire nitro to smash through it all.

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/, host it anywhere
npm test         # course solver and game rules
```

Rendered with [three.js](https://threejs.org): a Gerstner-wave ocean on the
physical material (it reflects the sunset sky and catches the sun), foam on the
crests and the shore, a spray and splash particle system, a foam wake, shadows
and bloom. Every model and texture is generated in code and every sound is
synthesised with Web Audio: the engine and its impeller whine, water rushing
under the hull, hull slaps, splashes, wind in the air, surf and seagulls. The
only thing fetched at runtime is the font (Lilita One and Nunito from Google
Fonts). Quality adapts: fewer pixels if frames run long, lighter settings on phones. Best score, coins, skins and
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

## Chases and missions

Ride recklessly (close calls, nitro smashes, bumping boats) and the water police,
Polairud, come after you; a patrol may also spot you on a long run. They start
50 m back and close in slowly, surging on every bump; a rear-view mirror shows
them coming. Fire nitro to pull away or ride clean until they give up. Three
missions at a time (flips, close calls, escapes, distance, combos...) pay coins
for the garage.

Add `?fps` to the address to see frame times while playing.

## Never impossible

The course is generated from hand-made patterns of three-lane rows, spaced in
seconds so they feel the same at any speed. `test/course.test.ts` has a solver
that plays hundreds of generated courses with perfect foresight and the real
physics from `src/config.ts`, and fails if any of them cannot be finished. It
accounts for the length of obstacles (you cannot move over while a boat is
still alongside), the arc of a ramp jump over a whole boat, and a person's
reaction time between lane changes.

Ramps are forgiving on purpose. One launches you while any of the hull is over
it, or as soon as you swerve onto it from the next lane, and boats beside it are
brushed past on the way up. Because that means a launch can come up to 5 m
later, the solver checks every ramp jump for both its earliest and its latest
launch. Pressing down above a wall ducks on landing instead of dropping you
onto it. Each ramp has a striped gate over it, so it can be seen from far off.

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
- `src/render3d.ts`: the 3D scene: camera, sky, lights, beach, and the models
  that follow the simulation. `src/three/` holds the ocean, the waves (shared
  by the shader and by everything that floats), models, textures and effects.
- `src/audio.ts`, `src/input.ts`, `src/ui.ts`, `src/save.ts`, `src/main.ts`.
