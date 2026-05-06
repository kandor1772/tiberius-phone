# Tiberius Phone PWA

This is the serverless phone build. It is meant to be hosted on a static host and installed with "Add to Home Screen".

What runs on the phone:

- Board UI
- Legal chess rules through chess.js
- Tiberius overlay logic ported to JavaScript
- Compact Tiberius memory pack
- Bundled Stockfish 18 lite single-threaded WASM worker
- Stockfish full-strength options: `UCI_LimitStrength=false`, `Skill Level=20`

Bundled engine:

- `vendor/stockfish/stockfish.js`
- `vendor/stockfish/stockfish.wasm`
- GPL/source notes in `LICENSES.md` and `vendor/stockfish/README.md`

Local test:

```bash
cd /Users/tiberius/Documents/Codex/2026-05-01/look-for-tiberius-on-my-desktop/phone_pwa
python3 -m http.server 8088
```

Then open:

```text
http://127.0.0.1:8088
```
