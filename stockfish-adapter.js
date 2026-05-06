export class StockfishAdapter {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.pending = [];
    this.depth = 10;
  }

  async boot() {
    try {
      this.worker = new Worker("vendor/stockfish/stockfish.js");
    } catch (_err) {
      this.ready = false;
      return false;
    }
    this.worker.onmessage = event => this._onLine(String(event.data || ""));
    this.send("uci");
    this.send("isready");
    const ok = await new Promise(resolve => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.ready) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - started > 3000) {
          clearInterval(timer);
          resolve(false);
        }
      }, 50);
    });
    return ok;
  }

  send(line) {
    if (this.worker) this.worker.postMessage(line);
  }

  _onLine(line) {
    if (line === "readyok" || line.startsWith("uciok")) {
      this.ready = true;
    }
    const current = this.pending[0];
    if (!current) return;
    current.lines.push(line);
    if (line.startsWith("bestmove ")) {
      this.pending.shift();
      const best = line.split(/\s+/)[1] || "";
      current.resolve({ best, lines: current.lines });
    }
  }

  async bestMove(fen, { depth = this.depth, movetime = null } = {}) {
    if (!this.worker || !this.ready) return null;
    const result = new Promise(resolve => this.pending.push({ resolve, lines: [] }));
    this.send(`position fen ${fen}`);
    if (movetime) {
      this.send(`go movetime ${Math.max(10, Math.floor(movetime))}`);
    } else {
      this.send(`go depth ${Math.max(1, depth)}`);
    }
    return result;
  }
}
