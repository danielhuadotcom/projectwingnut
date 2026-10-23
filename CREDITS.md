# Credits

Project Wingnut's code is released under the MIT License (see [LICENSE](LICENSE)).
**Third-party and generated assets listed below keep their own licenses and are not covered by the MIT License.**
This includes the copies of those assets embedded as base64 in `js/sfx_data.js`, `js/music_data.js` and
`js/awacs_clips.js`.

## Engine

- **three.js** r170 (https://threejs.org), MIT License, Copyright © 2010-2024 three.js authors.
  Loaded at runtime from cdnjs (`three.module.min.js` 0.170.0); not redistributed in this repository.

## Sound effects

All shipped sound effects (`assets/sfx/*.ogg`, embedded in `js/sfx_data.js`) are modified derivatives of the
sources below (trimmed, mixed, pitch-shifted, EQ'd, loudness-normalised, looped, re-encoded). The full per-file
source table is in [assets/sfx/LICENSES.md](assets/sfx/LICENSES.md).

### CC BY (attribution required)

- "Saab J35D Draken – start engine and taxiing" by Work With Sounds / Torsten Nilsson (provided to Wikimedia
  Commons with Wikimedia Sverige), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Source: https://commons.wikimedia.org/wiki/File:WWS_SaabJ35DDrakenstartengineandtaxiing.ogg.
  Modified; used for `assets/sfx/engine_turbine.ogg`.
- "Canadian CF 18 maneuvers (Quinte International Air Show, CFB Trenton, 2016)" by lonemonk
  (https://freesound.org/people/lonemonk/), licensed under
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
  Source: https://commons.wikimedia.org/wiki/File:Canadian_CF_18_maneuvers.wav.
  Modified; used for `assets/sfx/afterburner.ogg`.

### CC0 1.0 (public domain dedication)

- Eurofighter Typhoon field recording ("ED-R 401 MVPA North East") by editoredr401 (freesound.org / Wikimedia Commons)
- "25 CC0 bang / firework SFX" by rubberduck (OpenGameArt.org)
- "Chunky Explosion" by Joth (OpenGameArt.org)
- "Battle at sea" by Thimras (OpenGameArt.org)
- "Sci-Fi Sounds" and "Impact Sounds" by Kenney (kenney.nl)
- "Metal Impact Sounds" by Brian MacIntosh / BMacZero (OpenGameArt.org)
- "Flare ignition" by qubodup (OpenGameArt.org)
- "Male Grunt/Yelling sounds" by HaelDB (OpenGameArt.org; dual-licensed, used under CC0)

The Wilhelm-style easter egg is made from the HaelDB CC0 scream, not the 1951 Warner Bros. recording.
Warning tones and fallback sounds are synthesized at runtime with the Web Audio API.

## Music

- "Ceiling Unlimited" is an original theme composed in code for Project Wingnut (`tools/music/`).
- It is rendered from samples of **VSCO 2 Community Edition** by Versilian Studios LLC / Sam Gossner, with
  Ivy Audio / Simon Dalzell, licensed under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
  Homepage: http://vis.versilstudios.net/vsco-community.html. Source: https://github.com/sgossner/VSCO-2-CE.
  The samples themselves aren't in this repository. `tools/music/fetch_samples.mjs` downloads them at build time.
  See [tools/music/LICENSES.txt](tools/music/LICENSES.txt).

## Voice

- The AWACS radio calls (`assets/awacs/`, embedded in `js/awacs_clips.js`) were generated with
  **Google Gemini text-to-speech** (Gemini API, prebuilt voice "Ludo") from original lines written for this game
  (`tools/awacs_lines.mjs`). Use of the generated audio is subject to Google's Gemini API terms.

## Mission data

- The per-mission enemy counts and compositions, and some unit performance figures, are adapted from community
  documentation on the **Project Wingman Wiki** (https://projectwingman.wiki.gg), scaled down for performance.
  The wiki's content is licensed under
  [Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/) unless otherwise
  noted. The game uses the numbers only (counts, compositions, performance figures).

## Disclaimer

Project Wingnut is an unofficial fan project inspired by Project Wingman. It is not affiliated with or endorsed
by Sector D2, Humble Games or any other developer or publisher of Project Wingman. The setting, story, names,
aircraft, music and code are original.
