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
  const file = squareFile(square);
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

function mirrorPlacement(placement) {
  const swapColor = char => {
    const lower = char.toLowerCase();
    if (!"pnbrqk".includes(lower)) return char;
    return char === lower ? char.toUpperCase() : lower;
  };
  return placement
    .split("/")
    .reverse()
    .map(rank => rank.split("").map(swapColor).join(""))
    .join("/");
}

function mirrorCastling(castling) {
  if (!castling || castling === "-") return "-";
  let out = "";
  if (castling.includes("k")) out += "K";
  if (castling.includes("q")) out += "Q";
  if (castling.includes("K")) out += "k";
  if (castling.includes("Q")) out += "q";
  return out || "-";
}

function positionKey(chess) {
  const parts = chess.fen().split(" ");
  if (chess.turn() === "w") return parts.slice(0, 4).join(" ");
  const ep = parts[3] && parts[3] !== "-" ? mirrorSquare(parts[3]) : "-";
  return [mirrorPlacement(parts[0]), "w", mirrorCastling(parts[2]), ep].join(" ");
}

function patternKey(chess, move) {
  const piece = (move.piece || "?").toUpperCase();
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

function mergeRecord(target, source) {
  if (!source) return;
  target.w = Number(target.w || 0) + Number(source.w || 0);
  target.d = Number(target.d || 0) + Number(source.d || 0);
  target.l = Number(target.l || 0) + Number(source.l || 0);
}

export function emptyMemory(meta = {}) {
  return { meta, global_moves: {}, positions: {}, outcomes: {}, transitions: {} };
}

export function mergeMemorySources(sources) {
  const merged = emptyMemory({ sources: [] });
  for (const source of sources.filter(Boolean)) {
    const sourceMeta = source.meta || {};
    merged.meta.sources.push(sourceMeta.source_label || sourceMeta.source || sourceMeta.url || "memory");
    merged.meta.local_learned_positions = Number(merged.meta.local_learned_positions || 0) + Number(sourceMeta.local_learned_positions || 0);
    merged.meta.human_observed_moves = Number(merged.meta.human_observed_moves || 0) + Number(sourceMeta.human_observed_moves || 0);
    for (const [key, rec] of Object.entries(source.global_moves || {})) {
      merged.global_moves[key] ||= { w: 0, d: 0, l: 0 };
      mergeRecord(merged.global_moves[key], rec);
    }
    for (const [fen, moves] of Object.entries(source.positions || {})) {
      merged.positions[fen] ||= {};
      for (const [uci, rec] of Object.entries(moves || {})) {
        merged.positions[fen][uci] ||= { w: 0, d: 0, l: 0 };
        mergeRecord(merged.positions[fen][uci], rec);
      }
    }
  }
  merged.meta.source_label = `${merged.meta.sources.length} memory source${merged.meta.sources.length === 1 ? "" : "s"}`;
  return merged;
}

export function learnMemory(memory, chessBefore, move, bucket = "d") {
  const safeBucket = ["w", "d", "l"].includes(bucket) ? bucket : "d";
  memory.positions ||= {};
  memory.global_moves ||= {};
  memory.meta ||= {};

  const pkey = positionKey(chessBefore);
  const uci = canonicalMove(chessBefore, move);
  memory.positions[pkey] ||= {};
  memory.positions[pkey][uci] ||= { w: 0, d: 0, l: 0 };
  memory.positions[pkey][uci][safeBucket] += 1;

  const gkey = patternKey(chessBefore, move);
  memory.global_moves[gkey] ||= { w: 0, d: 0, l: 0 };
  memory.global_moves[gkey][safeBucket] += 1;
  memory.meta.local_learned_positions = Number(memory.meta.local_learned_positions || 0) + 1;
}

export class TiberiusOverlay {
  constructor(memory) {
    this.memory = memory || { global_moves: {}, positions: {}, meta: {} };
  }

  sourceSummary() {
    const meta = this.memory.meta || {};
    const sources = Array.isArray(meta.sources) ? meta.sources.length : 1;
    const globalMoves = Object.keys(this.memory.global_moves || {}).length;
    const positions = Object.keys(this.memory.positions || {}).length;
    const learned = Number(meta.local_learned_positions || 0);
    const observed = Number(meta.human_observed_moves || 0);
    return {
      sources,
      globalMoves,
      positions,
      learned,
      observed,
      label: meta.source_label || meta.source || "memory",
    };
  }

  predictHumanMove(chess) {
    const moves = chess.moves({ verbose: true });
    const weighted = [];
    const exact = this.memory.positions?.[positionKey(chess)] || {};
    for (const move of moves) {
      const posRec = exact[canonicalMove(chess, move)];
      const patRec = this.memory.global_moves?.[patternKey(chess, move)];
      const recs = [posRec, patRec].filter(Boolean);
      const n = recs.reduce((sum, rec) => sum + Number(rec?.w || 0) + Number(rec?.d || 0) + Number(rec?.l || 0), 0);
      if (n <= 0) continue;
      const value = recs.reduce((sum, rec) => sum + memoryValue(rec), 0) / recs.length;
      const exactBoost = posRec ? 2.25 : 1;
      weighted.push({ move, n, value, weight: exactBoost * n * Math.exp(1.75 * value) });
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
      const exact = this.memory.positions?.[positionKey(chess)] || {};
      const posRec = exact[canonicalMove(chess, move)];
      const patRec = this.memory.global_moves?.[patternKey(chess, move)];
      let prior = 1;
      if (posRec || patRec) {
        const posWeight = posRec ? 2 : 0;
        const patWeight = patRec ? 1 : 0;
        const value = ((posRec ? posWeight * memoryValue(posRec) : 0) + (patRec ? patWeight * memoryValue(patRec) : 0)) / (posWeight + patWeight);
        prior = Math.exp(1.75 * value);
      }
      const tactical = move.captured ? 1.15 : move.san.includes("+") ? 1.3 : 1;
      const sfBoost = stockfishBest && moveUci(move) === stockfishBest ? 1.35 : 1;
      return { move, score: kernel(target, sig) * prior * tactical * sfBoost, sig };
    }).sort((a, b) => b.score - a.score);
    return ranked[0];
  }

  learnMove(chessBefore, move, bucket = "d") {
    learnMemory(this.memory, chessBefore, move, bucket);
  }
}
