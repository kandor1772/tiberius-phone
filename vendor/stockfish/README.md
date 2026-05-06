# Stockfish WASM Slot

Put a GPL-compliant browser Stockfish build here:

- `stockfish.js`
- `stockfish.wasm` if required by that build
- the GPL-3.0 license text
- a source/build notice for the exact binary

The phone app will detect `stockfish.js` automatically. Until it is present, Tiberius still runs the JavaScript overlay and memory predictor on the phone, but the Stockfish anchor is disabled.
