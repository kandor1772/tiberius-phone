import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js";
import { StockfishAdapter } from "./stockfish-adapter.js";
import { TiberiusOverlay } from "./tiberius-overlay.js";

const PIECES = {
  wp: "♙", wn: "♘", wb: "♗", wr: "♖", wq: "♕", wk: "♔",
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

function uci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function setThinking(thinking) {
  engineThinking = thinking;
  playBtn.disabled = thinking || chess.isGameOver() || chess.turn() !== "w";
  moveInput.disabled = playBtn.disabled;
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
      if (piece) button.textContent = PIECES[`${piece.color}${piece.type}`] || "";
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

function onSquare(square) {
  if (engineThinking || chess.turn() !== "w" || chess.isGameOver()) return;
  if (selected) {
    const promotion = square.endsWith("8") ? "q" : undefined;
    const result = chess.move({ from: selected, to: square, promotion });
    selected = null;
    if (result) {
      afterHumanMove(result);
      return;
    }
  }
  const piece = chess.get(square);
  selected = piece && piece.color === "w" ? square : null;
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
  await engineMove();
}

async function engineMove() {
  if (chess.isGameOver()) {
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
  render();
}

function submitMove() {
  if (engineThinking || chess.turn() !== "w") return;
  const text = moveInput.value.trim();
  if (!text) return;
  const result = chess.move(text, { sloppy: true });
  if (!result) {
    predictionTitle.textContent = "Illegal move";
    predictionText.textContent = "Try SAN like Nf3 or UCI-like entry by tapping the board.";
    return;
  }
  moveInput.value = "";
  afterHumanMove(result);
}

async function boot() {
  try {
    const memory = await fetch("tiberius-memory-lite.json", { cache: "force-cache" }).then(r => r.json());
    overlay = new TiberiusOverlay(memory);
  } catch (_err) {
    overlay = new TiberiusOverlay();
  }
  stockfishReady = await stockfish.boot();
  engineStatusEl.textContent = stockfishReady
    ? "Running on phone with Stockfish worker + Tiberius overlay."
    : "Running on phone with Tiberius overlay. Stockfish WASM not bundled yet.";
  explainForHumanTurn();
  render();
}

newGameBtn.addEventListener("click", () => {
  chess.reset();
  selected = null;
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
