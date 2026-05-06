# Licenses

This phone-carried build is designed to run without the Mac server.

## Stockfish

Stockfish is licensed under GPL-3.0. If a Stockfish JavaScript/WASM/native binary is distributed with this app, the app distribution must include:

- GPL-3.0 license text.
- A pointer to the exact Stockfish source used to build the binary.
- Any local changes made to Stockfish, also under GPL-3.0.

Official source: https://github.com/official-stockfish/Stockfish

This repository currently includes only an adapter stub at `stockfish-adapter.js`. Put the actual GPL-compliant Stockfish build in `vendor/stockfish/` before publishing engine-enabled builds.

## chess.js

The browser chess rules are loaded from chess.js. Include its license/source when vendoring it for a fully offline package.

Source: https://github.com/jhlywa/chess.js

## Tiberius

The Tiberius overlay and memory files are project-owned. Choose and publish a license before distributing modified source publicly.
