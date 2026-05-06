# Tiberius Phone PWA

Tiberius Phone is a serverless chess PWA built to run from a GitHub Pages portfolio link. It carries the board UI, Stockfish 18 WASM, a JavaScript Tiberius overlay, and the packaged Tiberius memory pack without requiring the Mac to be online.

Live app:

```text
https://kandor1772.github.io/tiberius-phone/
```

What runs on the phone:

- Board UI
- Legal chess rules through chess.js
- Tiberius overlay logic ported to JavaScript
- Bundled Stockfish 18 lite single-threaded WASM worker
- Stockfish full-strength options: `UCI_LimitStrength=false`, `Skill Level=20`
- Full packaged Tiberius memory loaded from `tiberius-memory-full.json.gz`
- Lite memory fallback if the browser cannot load the compressed full pack
- Optional live memory sources from `memory-sources.json`
- Completed phone games learned into browser local storage
- DuckDNS-linked sync outbox for future shared Tiberius memory ingestion
- Start as White, start as Black, concede, reset board, move list, FEN, and analysis panels
- DuckDNS-style Black start: Tiberius waits for the Stockfish anchor before making White's first move
- Black-side board orientation uses the actual square lookup for each flipped coordinate, so the visible board and legal move targets match
- Online challenge panel for random/specific players, poke/tap requests, anonymous identity, and interrupt-to-accept flow

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
