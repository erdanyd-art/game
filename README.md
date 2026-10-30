# Games

Two browser games, each in its own folder with its own README, tests and build.
No backend and no image or audio files: everything is drawn on a canvas and
synthesised with Web Audio.

| | |
|---|---|
| [**Gaspol! Jetski Pantai**](gaspol/) | A fast jetski lane runner along a Bali beach at sunset: dodge outrigger boats, hop logs, duck under piers, backflip off wave ramps, fire nitro. |
| [**Kunang**](kunang/) | A rhythm game: lead a swarm of fireflies up a mangrove river, flashing on the beat of a gamelan to call wild fireflies and dazzle predators. |

## Run one

```sh
cd gaspol        # or: cd kunang
npm install
npm run dev
```

`npm test` runs that game's tests; `npm run build` makes a static site in `dist/`.
