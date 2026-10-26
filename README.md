# Project Wingnut

An arcade jet-combat game that runs entirely in the browser, built with [three.js](https://threejs.org) and Web Audio.
You fly as Wingnut, with the Loose Screws squadron, for the Skerry League in the Galebreak Isles, across 21 missions.
The game has procedural terrain, sky, water and clouds, HDR post-processing, missiles and flares, AWACS radio calls
and an orchestral soundtrack. Everything is generated in code or embedded in the page.

**Play it here: https://danielhua.com/projectwingnut/**

Works in desktop and mobile browsers with WebGL 2. A gamepad is recommended.

To install it as an app that opens full screen: on iPhone or iPad, tap Share in Safari, then **Add to Home Screen**.
In Chrome or Edge, use **Install app** at the bottom of the title menu, or the browser's install option.

## Controls

The in-game **Controls** screen (Main menu › Controls) shows the same list.

### Gamepad (Mode 2, Xbox or PlayStation layout)

| Input | Action |
|---|---|
| Left stick ↑ / ↓ | Boost / airbrake |
| Left stick ← / → | Rudder |
| Right stick | Pitch and roll (pull back to climb) |
| LT | Missile |
| RT | Cannon |
| RB | Tap: next target. Hold: padlock view |
| LB | Look back |
| L3 (click left stick) | Flares |
| R3 (click right stick, hold) | AOA limiter off: the nose swings freely while the jet keeps its momentum |
| Start | Pause |

### Mouse and keyboard (mouse aim)

The jet flies toward the aim circle. The key preset is under Settings › Controls › Mouse keys.

| Input | Simple keys (default) | Advanced keys |
|---|---|---|
| Mouse | Aim | Aim |
| Left mouse / Space | Cannon | Cannon |
| Right mouse / F | Missile | Missile |
| W / S | Boost / airbrake | Pitch (S pulls up) |
| A / D | Roll | Roll |
| Q / E | Rudder | Rudder |
| Shift | Hard pull | Boost |
| H | – | Airbrake |
| X | Flares | Flares |
| Z (hold) | AOA limiter off (the nose swings to the aim) | same |
| Tab | Tap: next target. Hold: padlock view | same |
| C (hold) | Free look | Free look |
| V | Look back | Look back |
| P / Esc | Pause | Pause |
| U | Fullscreen | Fullscreen |

### Touch

On phones and tablets, on-screen sticks and buttons mirror the gamepad:

- Left stick: up to boost, down for airbrake, left and right for rudder.
- Right stick: pitch and roll.
- Buttons: missile, cannon, target (tap for the next target, hold for padlock view), flares, AOA limiter off (hold), look back and pause.

You can show or hide them under Settings › Controls › Touch controls.

## Building

Requirements: Node.js 18 or newer. `npm ci` installs the pinned build tool (esbuild). The game loads three.js from
cdnjs at runtime, so playing it needs network access.

```sh
npm ci
node tools/build.mjs --min
```

The build bundles `js/main.js` into `src/page.html` and writes:

- `dist/wingnut_local.html`: a standalone page you can open directly. This is the file GitHub Pages serves.
- `dist/wingnut.html`: the same page body without the `<html>`/`<head>` wrapper.
- `dev.html`: loads `js/main.js` unbundled, for quick iteration. Serve the repo root over HTTP to use it,
  for example with `python3 -m http.server`.

Pushing to `main` builds the game and deploys it to GitHub Pages (`.github/workflows/pages.yml`).

### Test and benchmark harness (optional)

`tools/check.mjs` (headless render check), `tools/perf.mjs` and `tools/bench_all.sh` (GPU benchmarks),
`tools/integration.sh`, the `tools/gpuprobe*.mjs` scripts and the `test_*.html` pages drive Google Chrome through
`puppeteer-core` against a local server (`tools/serve.sh`, port 8765). They were built for headless Chrome using the
hardware GPU under WSL2, so the Chrome path and GPU flags in `tools/lock.mjs` may need adjusting on other systems
(`WINGNUT_SW=1` switches to software rendering). Outputs and the lock that keeps one Chrome running at a time go to
`$WINGNUT_TMP`, which defaults to `wingnut/` under the system temp directory.

### Regenerating assets (optional)

The game ships with prebuilt audio: embedded in `js/sfx_data.js`, `js/music_data.js` and `js/awacs_clips.js`, and
streamed per mission from `assets/dialogue/` (story dialogue) and `assets/music/` (the Mainspring and night tracks).
You only need the generators in `tools/` if you want to change those assets:

- `tools/build_sfx.mjs`: downloads and processes the sound effects (needs ffmpeg).
- `tools/music/`: renders the soundtrack from VSCO 2 CE samples (needs ffmpeg).
- `tools/gen_awacs_tts.mjs` and `tools/build_awacs.mjs`: regenerate the AWACS voice clips. The raw TTS takes are not
  in the repo; `tools/gen_awacs_tts.mjs` regenerates them into `assets/awacs/raw/` (it reads `GEMINI_API_KEY` from your
  environment), then `tools/build_awacs.mjs --retrim` trims them into `assets/awacs/` and rebuilds `js/awacs_clips.js`.
- Story dialogue: `tools/dialogue_lines.mjs` is the script (voices and prompts in `tools/dialogue_voices.mjs`);
  `tools/gen_dialogue_tts.mjs` generates raw takes into `assets/dialogue/raw/`, `tools/build_dialogue.mjs` trims them into
  `assets/dialogue/` and rebuilds `js/dialogue_data.js`, and `tools/dialogue_check.mjs` checks that every line has a clip.

## Fan project notice

Project Wingnut is an **unofficial fan project** inspired by *Project Wingman*. It is **not affiliated with or
endorsed by** Sector D2, Humble Games or any other developer or publisher of Project Wingman. The setting, story,
names, aircraft and code are original.

## License

The code is released under the [MIT License](LICENSE). The sound effects, music, voice clips and other third-party
material keep their own licenses and are **not** covered by the MIT License. See [CREDITS.md](CREDITS.md).
