const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const EXTENDED_CENTER = new Set(["c3","d3","e3","f3","c4","d4","e4","f4","c5","d5","e5","f5","c6","d6","e6","f6"]);

function tanh(x) {
  return Math.tanh(x);
}

function squareFile(square) {
  return "abcdefgh".indexOf(square[0]);
}

function squareRank(square) {
  return Number(square[1]) - 1;
}

function mirrorSquare(square) {
  const file = 7 - squareFile(square);
  const rank = 7 - squareRank(square);
  return "abcdefgh"[file] + String(rank + 1);
}

function moveUci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function canonicalMove(chess, move) {
  if (chess.turn() === "w") return moveUci(move);
  return `${mirrorSquare(move.from)}${mirrorSquare(move.to)}${move.promotion || ""}`;
}

function patternKey(chess, move) {
  const piece = move.piece || "?";
  const capture = move.captured ? "x" : "-";
  let from = move.from;
  let to = move.to;
  if (chess.turn() === "b") {
    from = mirrorSquare(from);
    to = mirrorSquare(to);
  }
  const fileDelta = squareFile(to) - squareFile(from);
  const rankDelta = squareRank(to) - squareRank(from);
  const promo = move.promotion || "";
  const check = move.san && move.san.includes("+") ? "+" : "";
  return `${piece}${capture}${fileDelta >= 0 ? "+" : ""}${fileDelta},${rankDelta >= 0 ? "+" : ""}${rankDelta}${promo}${check}`;
}

function material(chess, color) {
  let own = 0;
  let opp = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const val = PIECE_VALUE[piece.type] || 0;
      if (piece.color === color) own += val;
      else opp += val;
    }
  }
  return tanh((own - opp) / 900);
}

function centerControl(chess, color) {
  let own = 0;
  let opp = 0;
  for (const move of chess.moves({ verbose: true })) {
    if (EXTENDED_CENTER.has(move.to)) own += move.color === color ? 1 : 0;
  }
  const fen = chess.fen();
  const clone = new chess.constructor(fen);
  clone.load(fen.replace(/ [wb] /, color === "w" ? " b " : " w "));
  for (const move of clone.moves({ verbose: true })) {
    if (EXTENDED_CENTER.has(move.to)) opp += 1;
  }
  return tanh((own - opp) / 10);
}

function mobility(chess, color) {
  const fen = chess.fen();
  const ownBoard = new chess.constructor(fen);
  ownBoard.load(fen.replace(/ [wb] /, color === "w" ? " w " : " b "));
  const oppBoard = new chess.constructor(fen);
  oppBoard.load(fen.replace(/ [wb] /, color === "w" ? " b " : " w "));
  return tanh((ownBoard.moves().length - oppBoard.moves().length) / 20);
}

function signatureAfter(chess, move, perspective) {
  const clone = new chess.constructor(chess.fen());
  clone.move(move);
  return [
    material(clone, perspective),
    mobility(clone, perspective),
    centerControl(clone, perspective),
    0,
    move.captured ? 0.35 : 0,
    move.san && move.san.includes("+") ? 0.55 : 0,
    clone.inCheck() ? (clone.turn() === perspective ? -1 : 1) : 0,
  ];
}

function kernel(target, sig) {
  let dist = 0;
  for (let i = 0; i < target.length; i += 1) dist += (target[i] - sig[i]) ** 2;
  return Math.exp(-2.5 * dist);
}

function memoryValue(record) {
  const w = Number(record?.w || 0);
  const d = Number(record?.d || 0);
  const l = Number(record?.l || 0);
  const n = w + d + l;
  return ((w + 0.5 * d + 0.5) / (n + 1)) * 2 - 1;
}

export class TiberiusOverlay {
  constructor(memory) {
    this.memory = memory || { global_moves: {}, positions: {} };
  }

  predictHumanMove(chess) {
    const moves = chess.moves({ verbose: true });
    const weighted = [];
    for (const move of moves) {
      const rec = this.memory.global_moves?.[patternKey(chess, move)];
      const n = Number(rec?.w || 0) + Number(rec?.d || 0) + Number(rec?.l || 0);
      if (n <= 0) continue;
      weighted.push({ move, n, value: memoryValue(rec), weight: n * Math.exp(1.75 * memoryValue(rec)) });
    }
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (!weighted.length || total <= 0) return null;
    weighted.sort((a, b) => b.weight - a.weight);
    const top = weighted[0];
    return {
      san: top.move.san,
      uci: moveUci(top.move),
      confidence: top.weight / total,
      samples: Math.round(weighted.reduce((sum, item) => sum + item.n, 0)),
      next: weighted[1] ? weighted[1].move.san : "",
    };
  }

  chooseMove(chess, stockfishBest = null) {
    const moves = chess.moves({ verbose: true });
    if (!moves.length) return null;
    const perspective = chess.turn();
    const ideal = [0.85, 0.45, 0.35, 0.75, 0.65, 0.35, 0.55];
    let target = ideal;
    if (stockfishBest) {
      const sf = moves.find(m => moveUci(m) === stockfishBest);
      if (sf) {
        const sfSig = signatureAfter(chess, sf, perspective);
        target = ideal.map((v, i) => 0.65 * sfSig[i] + 0.35 * v);
      }
    }
    const ranked = moves.map(move => {
      const sig = signatureAfter(chess, move, perspective);
      const rec = this.memory.global_moves?.[patternKey(chess, move)];
      const prior = rec ? Math.exp(1.75 * memoryValue(rec)) : 1;
      const tactical = move.captured ? 1.15 : move.san.includes("+") ? 1.3 : 1;
      const sfBoost = stockfishBest && moveUci(move) === stockfishBest ? 1.35 : 1;
      return { move, score: kernel(target, sig) * prior * tactical * sfBoost, sig };
    }).sort((a, b) => b.score - a.score);
    return ranked[0];
  }
}
