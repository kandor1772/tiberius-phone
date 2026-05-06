# Stockfish WASM Bundle

This directory bundles `stockfish@18.0.7` from npm under GPL-3.0.

Runtime files:

- `stockfish.js`: copied from `bin/stockfish-18-lite-single.js`
- `stockfish.wasm`: copied from `bin/stockfish-18-lite-single.wasm`
- `Copying.txt`: GPL-3.0 license text from the package
- `UPSTREAM_README.md`: upstream package README

Source package: https://www.npmjs.com/package/stockfish/v/18.0.7
Upstream repository: https://github.com/nmrugg/stockfish.js
Official Stockfish source: https://github.com/official-stockfish/Stockfish

No engine code was modified. Files were renamed only to match the app loader.
