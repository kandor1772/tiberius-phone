# Tiberius Phone PWA

Tiberius Phone is a serverless chess PWA built to run from a GitHub Pages portfolio link. It carries the board UI, Stockfish 18 WASM, a JavaScript Tiberius overlay, and the packaged Tiberius memory pack without requiring the Mac to be online.

Live app:

```text
https://kandor1772.github.io/tiberius-phone/
```

Download:

```text
https://github.com/kandor1772/tiberius-phone/archive/refs/heads/main.zip
```

Search/discovery:

- The public site includes browser metadata for Tiberius.
- `robots.txt` points crawlers to `sitemap.xml`.
- `DOWNLOAD.md` keeps the free download link visible in the repository.

What runs on the phone:

- Board UI
- Legal chess rules through chess.js
- Tiberius overlay logic ported to JavaScript
- Bundled Stockfish 18 lite single-threaded WASM worker
- Stockfish full-strength options: `UCI_LimitStrength=false`, `Skill Level=20`
- Full packaged Tiberius memory loaded from `tiberius-memory-full.json.gz`
- Lite memory fallback if the browser cannot load the compressed full pack
- Optional live memory sources from `memory-sources.json`
- Every active and completed game saved into browser local storage with FEN, PGN, move history, side, status, result, and timestamps
- Tiberius-core sync outbox for game progress, moves, concessions, and completed games
- Start as White, start as Black, concede, reset board, move list, FEN, and analysis panels
- Saved Games panel to resume recent games
- DuckDNS-style Black start: Tiberius waits for the Stockfish anchor before making White's first move
- Black-side board orientation uses the actual square lookup for each flipped coordinate, so the visible board and legal move targets match
- Online play panel with a selectable roster, seeded `RP` and `rick`, active/inactive player status, invite notifications, and one `Play Human` action

Game Persistence:

- The app keeps the current game and recent games locally so interrupted sessions can be resumed.
- Every progress update is also queued to `https://eltiburon.duckdns.org/api/phone-sync` for Tiberius core ingestion.
- If the core endpoint is offline, updates remain queued locally and retry on later app activity.

Multiplayer:

- The static app includes the client-side online play surface and relay calls.
- Live matchmaking requires a relay at `https://eltiburon.duckdns.org/api/multiplayer`.
- [MULTIPLAYER_RELAY.md](MULTIPLAYER_RELAY.md) documents the endpoint contract and large-traffic guardrails.

Bundled engine:

- `vendor/stockfish/stockfish.js`
- `vendor/stockfish/stockfish.wasm`
- GPL/source notes in `LICENSES.md` and `vendor/stockfish/README.md`

Memory:

- `tiberius-memory-full.json.gz`: compressed packaged Tiberius memory
- `tiberius-memory-lite.json`: fast fallback memory
- `memory-sources.json`: source manifest for packaged and optional live memories

Reconstruction:

- [PORTFOLIO_RECONSTRUCTION.md](PORTFOLIO_RECONSTRUCTION.md) documents the architecture, file map, local run commands, GitHub Pages deployment, memory provenance, and the sync contract needed for DuckDNS/cloud ingestion.

Local test:

```bash
cd /Users/tiberius/Documents/Codex/2026-05-01/look-for-tiberius-on-my-desktop/phone_pwa
python3 -m http.server 8088
```

Then open:

```text
http://127.0.0.1:8088
```

Static hosting:

This repository is configured for GitHub Pages from `main` at the repository root. Any static host can serve the same files.
