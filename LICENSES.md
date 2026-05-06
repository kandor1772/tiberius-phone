# Licenses

This phone-carried build is designed to run without the Mac server.

## Stockfish

Stockfish is licensed under GPL-3.0. If a Stockfish JavaScript/WASM/native binary is distributed with this app, the app distribution must include:

- GPL-3.0 license text.
- A pointer to the exact Stockfish source used to build the binary.
- Any local changes made to Stockfish, also under GPL-3.0.

Official source: https://github.com/official-stockfish/Stockfish

This repository bundles `stockfish@18.0.7` from npm, licensed GPL-3.0. The phone build uses the lite single-threaded browser engine:

- `vendor/stockfish/stockfish.js`, copied from `bin/stockfish-18-lite-single.js`
- `vendor/stockfish/stockfish.wasm`, copied from `bin/stockfish-18-lite-single.wasm`
- `vendor/stockfish/Copying.txt`, GPL-3.0 license text
- `vendor/stockfish/UPSTREAM_README.md`, upstream package README

Source package: https://www.npmjs.com/package/stockfish/v/18.0.7
Upstream repository: https://github.com/nmrugg/stockfish.js
Official Stockfish source: https://github.com/official-stockfish/Stockfish

No local changes were made to the Stockfish engine files. They were renamed only so the PWA adapter can load `vendor/stockfish/stockfish.js` and its adjacent `stockfish.wasm`.

## chess.js

The browser chess rules are loaded from chess.js. Include its license/source when vendoring it for a fully offline package.

Source: https://github.com/jhlywa/chess.js

## Tiberius

The Tiberius overlay and memory files are project-owned. Choose and publish a license before distributing modified source publicly.
