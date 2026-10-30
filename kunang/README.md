# Kunang

A rhythm game about fireflies. Lead a swarm up a mangrove river at night and
bring the light home to the Firefly Tree before dawn.

Fireflies talk by flashing. Flash on the beat of the gamelan and the whole
swarm flashes as one: wild fireflies nearby start to trust you and join, and a
flash right on the beat ("Pas!") dazzles the frogs and bats that hunt the
swarm. Predators strike on the beat too, so there is always one beat to answer.

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/, host it anywhere
npm test         # unit tests for the pure logic
```

No assets, no backend: every sound is synthesised with Web Audio (a saron and
gong tuned to the slendro scale) and every shape is drawn on a canvas.
Progress (stars per night, sound on or off) is kept in this browser's
`localStorage`.

## Controls

| | Move | Flash |
|---|---|---|
| Mouse | the swarm follows the cursor | click |
| Keyboard | WASD or arrows | Space (also J, K, F) |
| Touch | drag on the left half | tap the right half |

Esc or P pauses, M toggles sound.

## How it fits together

- `src/game.ts` is the whole simulation: swarm, flashes, trust, frogs, bats,
  winning and losing. It has no DOM access and takes its clock as a parameter,
  so it runs in Node as well as the browser.
- `src/beat.ts` judges a tap against the nearest beat.
- `src/level.ts` builds each night's river from a fixed seed, so a night is
  the same every time you play it.
- `src/audio.ts` plays the music and effects. Its `now()` is the clock the
  player hears, and beats, visuals and judging all use it.
- `src/render.ts` draws the world, then a darkness layer with holes cut out
  wherever there is light.
- `src/ui.ts` and `index.html` hold the menus and HUD; `src/main.ts` connects
  everything.

The five nights are tuned in `src/nights.ts`. Balance was checked by having
simulated players of different timing accuracy play every night.
