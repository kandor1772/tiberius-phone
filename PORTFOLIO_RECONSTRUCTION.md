# Portfolio Reconstruction

This document is the reconstruction trail for the Tiberius phone build. A portfolio visitor should be able to understand what was built, how it runs, what is bundled, what still needs a server endpoint, and how to host or rebuild it.

## Live Artifact

- Portfolio app: `https://kandor1772.github.io/tiberius-phone/`
- Repository: `https://github.com/kandor1772/tiberius-phone`
- Hosting model: static GitHub Pages from `main` at repository root

## What This App Is

Tiberius Phone is a static installable chess PWA. It runs in the browser on a phone or desktop without the Mac server being on.

It contains:

- a playable chess board with stable coordinates and responsive scaling
- side selection: start as White or Black
- board orientation for the chosen side
- concede and reset board controls
- move input by text or board taps
- move list, FEN, result, turn, human side, and Tiberius side panels
- Stockfish 18 lite single-threaded WASM bundled locally
- a JavaScript Tiberius overlay
- full packaged Tiberius memory as a compressed JSON file
- a lite memory fallback for fast boot
- browser local storage for continuing games and learning completed phone games
- a DuckDNS-linked sync outbox that queues events until a compatible receiver exists

## File Map

Core app:

- `index.html`: static app shell and analysis/control panels
- `style.css`: board, controls, and DuckDNS-style visual treatment
- `app.js`: game state, side switching, Stockfish boot, memory loading, local persistence, and sync outbox
- `tiberius-overlay.js`: JavaScript Tiberius move scoring, memory matching, prediction, and local learning
- `stockfish-adapter.js`: UCI worker adapter for Stockfish
- `sw.js`: service worker and offline cache
- `manifest.webmanifest`: installable PWA manifest
- `icon.svg`: app icon

Memory:

- `tiberius-memory-full.json.gz`: full packaged Tiberius memory, compressed for mobile delivery
- `tiberius-memory-lite.json`: small fallback memory pack
- `memory-sources.json`: memory source manifest

Stockfish:

- `vendor/stockfish/stockfish.js`: browser Stockfish worker script
- `vendor/stockfish/stockfish.wasm`: Stockfish WASM engine
- `vendor/stockfish/Copying.txt`: GPL-3.0 license
- `vendor/stockfish/README.md`: local source/bundle notice
- `vendor/stockfish/UPSTREAM_README.md`: upstream package README

Docs:

- `README.md`: quick project summary
- `LICENSES.md`: license and source notes
- `PORTFOLIO_RECONSTRUCTION.md`: this reconstruction record

## Runtime Model

Boot sequence:

1. Render the board immediately.
2. Load phone-local saved game and local learned memory.
3. Load `tiberius-memory-lite.json` so predictions work quickly.
4. Boot Stockfish WASM in a web worker.
5. Load `tiberius-memory-full.json.gz` in the background.
6. Replace the packaged lite memory with the full packaged memory once decompression/parsing finishes.
7. Try optional live memory sources listed in `memory-sources.json`.

The status line reports the current truth, for example:

```text
Running on phone with Stockfish worker + Tiberius overlay. Memory: 2 sources, 496 learned patterns, 380994 exact positions, 0 local moves. 1 source unreachable.
```

## Memory Provenance

The full memory pack was generated from the packaged local Tiberius memory:

```text
/Users/tiberius/Desktop/Chess/Tiberius/Tiberius_5/reports/Tiberius_quantum_memory.json
```

That source contained:

- `496` global move pattern records
- `380,994` exact position records
- outcome and transition tables

The phone app currently consumes:

- global move pattern records
- exact position move records
- phone-local completed-game updates

The compressed GitHub Pages artifact is:

```text
tiberius-memory-full.json.gz
```

It is intentionally loaded after the board renders so the phone does not appear frozen while parsing the large memory file.

## Stockfish Provenance

The browser engine bundle is `stockfish@18.0.7`, GPL-3.0.

The app uses the lite single-threaded WASM flavor:

- source package: `https://www.npmjs.com/package/stockfish/v/18.0.7`
- upstream project: `https://github.com/nmrugg/stockfish.js`
- official Stockfish source: `https://github.com/official-stockfish/Stockfish`

Runtime UCI settings:

```text
UCI_LimitStrength=false
Skill Level=20
```

## DuckDNS Link And Sync Truth

The app is directly linked to DuckDNS through a queued sync outbox. It attempts to POST phone events to:

```text
https://eltiburon.duckdns.org/api/phone-sync
```

Events include:

- `new_game`
- `move`
- `concede`
- `game_complete`

Each event carries:

- FEN
- PGN
- human color
- Tiberius color
- result if known
- event payload
- creation timestamp
- source id

Important constraint:

DuckDNS points at the Mac-hosted Tiberius server. If the Mac is off, DuckDNS cannot receive writes unless a separate always-on cloud endpoint exists. The phone app therefore keeps events in local storage until a receiver accepts them.

To make sync work while the Mac is off, add a cloud receiver with the same `/api/phone-sync` contract, then have both the Mac-side DuckDNS app and the phone app read/write that shared store.

## Local Run

From the repository root:

```bash
python3 -m http.server 8088
```

Open:

```text
http://127.0.0.1:8088
```

## GitHub Pages Deployment

This project is deployed as static files from `main` at `/`.

To publish updates:

```bash
git status -sb
git add README.md PORTFOLIO_RECONSTRUCTION.md index.html style.css app.js tiberius-overlay.js stockfish-adapter.js sw.js memory-sources.json manifest.webmanifest icon.svg LICENSES.md vendor/stockfish tiberius-memory-lite.json tiberius-memory-full.json.gz
git commit -m "Update Tiberius phone portfolio build"
git push
```

GitHub Pages then serves:

```text
https://kandor1772.github.io/tiberius-phone/
```

## Rebuild The Full Memory Pack

If the packaged Tiberius memory changes locally, regenerate the compressed portfolio pack:

```bash
gzip -c /Users/tiberius/Desktop/Chess/Tiberius/Tiberius_5/reports/Tiberius_quantum_memory.json > tiberius-memory-full.json.gz
```

Then commit and push the updated artifact.

## What Is Not In This Static Repo

This repo does not include the packaged desktop Tiberius app, private local runner scripts, local Stockfish executables, launchd/Caddy configuration, or the Mac-side DuckDNS server code.

Those pieces are not needed to run the phone app from GitHub Pages. They are only needed for local Mac-hosted Tiberius and live bidirectional memory ingestion.
