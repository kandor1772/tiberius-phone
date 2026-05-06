import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js";
import { StockfishAdapter } from "./stockfish-adapter.js";
import { emptyMemory, learnMemory, mergeMemorySources, TiberiusOverlay } from "./tiberius-overlay.js";

const PIECES = {
  wp: "♟", wn: "♞", wb: "♝", wr: "♜", wq: "♛", wk: "♚",
  bp: "♟", bn: "♞", bb: "♝", br: "♜", bq: "♛", bk: "♚",
};

const boardEl = document.getElementById("board");
const engineStatusEl = document.getElementById("engineStatus");
const newGameBtn = document.getElementById("newGameBtn");
const moveInput = document.getElementById("moveInput");
const playBtn = document.getElementById("playBtn");
const turnText = document.getElementById("turnText");
const evalText = document.getElementById("evalText");
const predictionTitle = document.getElementById("predictionTitle");
const predictionText = document.getElementById("predictionText");
const preserveText = document.getElementById("preserveText");
const tradeoffText = document.getElementById("tradeoffText");
const puzzleText = document.getElementById("puzzleText");

const chess = new Chess();
let overlay = new TiberiusOverlay();
let stockfish = new StockfishAdapter();
let selected = null;
let stockfishReady = false;
let engineThinking = false;
let sourceMemories = [];
let phoneMemory = emptyMemory({ source: "phone-local" });
let loadedMemorySources = [];
let failedMemorySources = [];
let trajectory = [];
let fullMemoryLoading = false;

const PHONE_MEMORY_KEY = "tiberius-phone-local-memory-v1";

function uci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function setThinking(thinking) {
  engineThinking = thinking;
  playBtn.disabled = thinking || chess.isGameOver() || chess.turn() !== "w";
  moveInput.disabled = playBtn.disabled;
}

function memorySummaryText() {
  const summary = overlay.sourceSummary();
  const failed = failedMemorySources.length ? ` ${failedMemorySources.length} source${failedMemorySources.length === 1 ? "" : "s"} unreachable.` : "";
  const loading = fullMemoryLoading ? " Loading full memory..." : "";
  return `Memory: ${summary.sources} source${summary.sources === 1 ? "" : "s"}, ${summary.globalMoves} learned patterns, ${summary.positions} exact positions, ${summary.learned} local moves.${loading}${failed}`;
}

function refreshEngineStatus() {
  const engine = stockfishReady
    ? "Running on phone with Stockfish worker + Tiberius overlay."
    : "Running on phone with Tiberius overlay. Stockfish WASM not bundled yet.";
  engineStatusEl.textContent = `${engine} ${memorySummaryText()}`;
}

function render() {
  boardEl.innerHTML = "";
  const files = ["a","b","c","d","e","f","g","h"];
  const ranks = ["8","7","6","5","4","3","2","1"];
  const legalTargets = selected
    ? chess.moves({ square: selected, verbose: true }).map(move => move.to)
    : [];
  const board = chess.board();
  for (let r = 0; r < 8; r += 1) {
    for (let f = 0; f < 8; f += 1) {
      const square = `${files[f]}${ranks[r]}`;
      const piece = board[r][f];
      const button = document.createElement("button");
      button.type = "button";
      button.className = `square ${((r + f) % 2 === 0) ? "light" : "dark"}`;
      if (selected === square) button.classList.add("selected");
      if (legalTargets.includes(square)) button.classList.add("target");
      button.dataset.square = square;
      if (piece) {
        const glyph = document.createElement("span");
        glyph.className = `piece piece-${piece.color === "w" ? "white" : "black"}`;
        glyph.textContent = PIECES[`${piece.color}${piece.type}`] || "";
        button.appendChild(glyph);
      }
      const coord = document.createElement("span");
      coord.className = "coord";
      coord.textContent = square;
      button.appendChild(coord);
      button.addEventListener("click", () => onSquare(square));
      boardEl.appendChild(button);
    }
  }
  turnText.textContent = chess.isGameOver()
    ? `Game over: ${chess.isCheckmate() ? "checkmate" : chess.isDraw() ? "draw" : "ended"}`
    : `${chess.turn() === "w" ? "White" : "Black"} to move`;
  setThinking(engineThinking);
}

function tryBoardMove(from, to) {
  const promotion = to.endsWith("8") ? "q" : undefined;
  try {
    return chess.move({ from, to, promotion });
  } catch (_err) {
    return null;
  }
}

function rememberMove(beforeFen, move) {
  trajectory.push({ fen: beforeFen, move: { ...move } });
}

function whiteScore() {
  if (chess.isCheckmate()) return chess.turn() === "w" ? 0 : 1;
  if (chess.isDraw()) return 0.5;
  return 0.5;
}

function bucketForPosition(fen, finalWhiteScore) {
  const side = fen.split(" ")[1];
  const score = side === "w" ? finalWhiteScore : finalWhiteScore === 0.5 ? 0.5 : 1 - finalWhiteScore;
  return score > 0.66 ? "w" : score >= 0.34 ? "d" : "l";
}

function rebuildOverlay() {
  overlay = new TiberiusOverlay(mergeMemorySources([...sourceMemories, phoneMemory]));
}

function addMemorySource(memory) {
  const group = memory?.meta?.group || memory?.meta?.url || `memory-${sourceMemories.length}`;
  sourceMemories = sourceMemories.filter(item => (item?.meta?.group || item?.meta?.url) !== group);
  sourceMemories.push(memory);
}

function savePhoneMemory() {
  try {
    localStorage.setItem(PHONE_MEMORY_KEY, JSON.stringify(phoneMemory));
  } catch (_err) {}
}

function completeGameLearning() {
  if (!chess.isGameOver() || !trajectory.length) return;
  const score = whiteScore();
  for (const item of trajectory) {
    learnMemory(phoneMemory, new Chess(item.fen), item.move, bucketForPosition(item.fen, score));
  }
  trajectory = [];
  savePhoneMemory();
  rebuildOverlay();
  refreshEngineStatus();
}

function onSquare(square) {
  if (engineThinking || chess.turn() !== "w" || chess.isGameOver()) return;
  const piece = chess.get(square);
  const ownPiece = piece && piece.color === "w";

  if (selected === square) {
    selected = null;
    render();
    return;
  }

  if (selected && ownPiece) {
    selected = square;
    render();
    return;
  }

  if (selected) {
    const beforeFen = chess.fen();
    const result = tryBoardMove(selected, square);
    selected = null;
    if (result) {
      rememberMove(beforeFen, result);
      afterHumanMove(result);
      return;
    }
  }

  selected = ownPiece ? square : null;
  render();
}

function predictionLine() {
  const pred = overlay.predictHumanMove(chess);
  if (!pred) {
    return "I do not have enough phone memory for this position yet. Make a move and Tiberius will keep learning the pattern locally.";
  }
  const pct = Math.round(pred.confidence * 100);
  const second = pred.next ? ` I also see ${pred.next} nearby in memory.` : "";
  return `My memory thinks your next move is ${pred.san} (${pred.uci}) with ${pct}% weighted confidence across ${pred.samples} learned pattern samples. That is not best-move advice. It is a behavioral prediction.${second}`;
}

function explainForHumanTurn() {
  predictionTitle.textContent = "What I Think You Will Do";
  predictionText.textContent = predictionLine();
  preserveText.textContent = "Stockfish, when available, stays hidden as the anchor. Tiberius overlays memory, structure, safety, and pressure without handing you the answer.";
  tradeoffText.textContent = "If you play the predicted move, you may be entering known territory. If you reject it, you still have to keep the position legal, safe, and coherent.";
  puzzleText.textContent = "Break the prediction: change pawn tension, improve king safety, block the prepared line, or force Tiberius to answer your threat.";
}

async function afterHumanMove(move) {
  render();
  predictionTitle.textContent = `You played ${move.san}`;
  predictionText.textContent = "Tiberius is checking Stockfish if present, then choosing an overlay move on the phone.";
  if (chess.isGameOver()) {
    completeGameLearning();
    render();
    return;
  }
  await engineMove();
}

async function engineMove() {
  if (chess.isGameOver()) {
    completeGameLearning();
    render();
    return;
  }
  setThinking(true);
  let stockfishBest = null;
  if (stockfishReady) {
    const result = await stockfish.bestMove(chess.fen(), { depth: 10 });
    stockfishBest = result?.best || null;
  }
  const decision = overlay.chooseMove(chess, stockfishBest);
  if (!decision) {
    setThinking(false);
    render();
    return;
  }
  const before = chess.fen();
  const played = chess.move(decision.move);
  rememberMove(before, played);
  evalText.textContent = stockfishBest
    ? `Stockfish anchor available. Tiberius chose ${played.san}.`
    : `No Stockfish binary bundled yet. Tiberius chose ${played.san} from overlay heuristics.`;
  predictionTitle.textContent = `Tiberius played ${played.san}`;
  predictionText.textContent = predictionLine();
  preserveText.textContent = `It preserved overlay score ${decision.score.toFixed(3)} from ${before.split(" ")[0].slice(0, 18)}...`;
  tradeoffText.textContent = stockfishBest
    ? `Pure Stockfish anchor suggested ${stockfishBest}; Tiberius blended it with memory and structure.`
    : "This build is running the legal on-phone Tiberius overlay now. Drop in GPL Stockfish WASM to enable full Stockfish anchoring.";
  puzzleText.textContent = "Tiberius just predicted your behavior from memory. Make the board stop matching the habit it expects.";
  setThinking(false);
  completeGameLearning();
  render();
}

function submitMove() {
  if (engineThinking || chess.turn() !== "w") return;
  const text = moveInput.value.trim();
  if (!text) return;
  const beforeFen = chess.fen();
  const result = chess.move(text, { sloppy: true });
  if (!result) {
    predictionTitle.textContent = "Illegal move";
    predictionText.textContent = "Try SAN like Nf3 or UCI-like entry by tapping the board.";
    return;
  }
  rememberMove(beforeFen, result);
  moveInput.value = "";
  afterHumanMove(result);
}

async function fetchMemorySource(source) {
  const url = source.url;
  const response = await fetch(url, { cache: source.required ? "force-cache" : "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  let memory;
  if (source.compression === "gzip") {
    if (!("DecompressionStream" in window) || !response.body) {
      throw new Error("gzip memory source is not supported in this browser");
    }
    const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
    memory = JSON.parse(await new Response(stream).text());
  } else {
    memory = await response.json();
  }
  memory.meta ||= {};
  memory.meta.source_label = source.label || url;
  memory.meta.url = url;
  memory.meta.group = source.group || url;
  return memory;
}

async function loadManifest() {
  let manifest = { sources: [{ label: "Bundled Tiberius memory pack", url: "tiberius-memory-lite.json", required: true }] };
  try {
    manifest = await fetch("memory-sources.json", { cache: "no-store" }).then(r => r.json());
  } catch (_err) {}
  return manifest;
}

function loadPhoneMemory() {
  try {
    phoneMemory = JSON.parse(localStorage.getItem(PHONE_MEMORY_KEY)) || phoneMemory;
  } catch (_err) {
    phoneMemory = emptyMemory({ source: "phone-local" });
  }
  phoneMemory.meta ||= {};
  phoneMemory.meta.source_label = "Phone local learning";
}

async function loadMemoryPhase(manifest, phase) {
  const sources = (manifest.sources || []).filter(source => (source.phase || "initial") === phase);
  for (const source of sources) {
    try {
      const memory = await fetchMemorySource(source);
      addMemorySource(memory);
      loadedMemorySources.push(source.label || source.url);
    } catch (_err) {
      failedMemorySources.push(source.label || source.url);
      if (source.required) {
        addMemorySource(emptyMemory({ source_label: `${source.label || source.url} unavailable`, group: source.group || source.url }));
      }
    }
  }
  rebuildOverlay();
}

async function boot() {
  render();
  loadPhoneMemory();
  const manifest = await loadManifest();
  await loadMemoryPhase(manifest, "initial");
  refreshEngineStatus();
  explainForHumanTurn();
  render();

  stockfish.boot().then(ready => {
    stockfishReady = ready;
    refreshEngineStatus();
  });

  fullMemoryLoading = true;
  refreshEngineStatus();
  loadMemoryPhase(manifest, "deferred").then(() => {
    fullMemoryLoading = false;
    refreshEngineStatus();
    explainForHumanTurn();
    render();
  }).catch(() => {
    fullMemoryLoading = false;
    refreshEngineStatus();
  });
}

newGameBtn.addEventListener("click", () => {
  chess.reset();
  selected = null;
  trajectory = [];
  explainForHumanTurn();
  render();
});

playBtn.addEventListener("click", submitMove);
moveInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitMove();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
