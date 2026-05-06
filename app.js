import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js";
import { StockfishAdapter } from "./stockfish-adapter.js?v=human-play-simple";
import { emptyMemory, learnMemory, mergeMemorySources, TiberiusOverlay } from "./tiberius-overlay.js?v=human-play-simple";
import { MultiplayerClient } from "./multiplayer-client.js?v=human-play-simple";

const PIECES = {
  wp: "♟", wn: "♞", wb: "♝", wr: "♜", wq: "♛", wk: "♚",
  bp: "♟", bn: "♞", bb: "♝", br: "♜", bq: "♛", bk: "♚",
};

const boardEl = document.getElementById("board");
const engineStatusEl = document.getElementById("engineStatus");
const statusEl = document.getElementById("status");
const newGameBtn = document.getElementById("newGameBtn");
const returnGameBtn = document.getElementById("returnGameBtn");
const newWhiteBtn = document.getElementById("newWhiteBtn");
const newBlackBtn = document.getElementById("newBlackBtn");
const concedeBtn = document.getElementById("concedeBtn");
const moveInput = document.getElementById("moveInput");
const playBtn = document.getElementById("playBtn");
const humanSideEl = document.getElementById("humanSide");
const tiberiusSideEl = document.getElementById("tiberiusSide");
const opponentLabelEl = document.getElementById("opponentLabel");
const turnText = document.getElementById("turnText");
const resultTextEl = document.getElementById("resultText");
const movesEl = document.getElementById("moves");
const saveStatusEl = document.getElementById("saveStatus");
const savedGamesEl = document.getElementById("savedGames");
const fenEl = document.getElementById("fen");
const strategyLabelEl = document.getElementById("strategyLabel");
const puzzleTitleEl = document.getElementById("puzzleTitle");
const puzzleTextEl = document.getElementById("puzzleText");
const whyTitleEl = document.getElementById("whyTitle");
const whyTextEl = document.getElementById("whyText");
const whenTextEl = document.getElementById("whenText");
const preserveText = document.getElementById("preserveText");
const tradeoffText = document.getElementById("tradeoffText");
const coachTextEl = document.getElementById("coachText");
const syncTextEl = document.getElementById("syncText");
const onlineNameInput = document.getElementById("onlineNameInput");
const challengeTargetInput = document.getElementById("challengeTargetInput");
const playHumanBtn = document.getElementById("playHumanBtn");
const incomingChallengeEl = document.getElementById("incomingChallenge");
const incomingTextEl = document.getElementById("incomingText");
const acceptChallengeBtn = document.getElementById("acceptChallengeBtn");
const declineChallengeBtn = document.getElementById("declineChallengeBtn");
const onlineStatusEl = document.getElementById("onlineStatus");

const chess = new Chess();
let overlay = new TiberiusOverlay();
let stockfish = new StockfishAdapter();
let selected = null;
let stockfishReady = false;
let stockfishBootPromise = null;
let engineThinking = false;
let sourceMemories = [];
let phoneMemory = emptyMemory({ source: "phone-local" });
let loadedMemorySources = [];
let failedMemorySources = [];
let trajectory = [];
let fullMemoryLoading = false;
let humanColor = "b";
let gameActive = true;
let gameResult = "";
let statusMessage = "New game started. You are black.";
let lastStrategy = "Balanced / not enough moves yet";
let gameSerial = 0;
let currentGameId = "";
let onlineGame = null;
let incomingChallenge = null;
let onlineNotice = "";

const PHONE_MEMORY_KEY = "tiberius-phone-local-memory-v1";
const PHONE_STATE_KEY = "tiberius-phone-state-v5-core";
const SAVED_GAMES_KEY = "tiberius-phone-saved-games-v1";
const PHONE_OUTBOX_KEY = "tiberius-phone-sync-outbox-v1";
const SYNC_ENDPOINTS = ["https://eltiburon.duckdns.org/api/phone-sync"];
const MULTIPLAYER_ENDPOINTS = ["https://eltiburon.duckdns.org/api/multiplayer"];
const multiplayer = new MultiplayerClient({ endpoints: MULTIPLAYER_ENDPOINTS });

function uci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function colorName(color) {
  return color === "w" ? "white" : "black";
}

function tiberiusColor() {
  return humanColor === "w" ? "b" : "w";
}

function makeGameId() {
  return `game-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureGameId() {
  if (!currentGameId) currentGameId = makeGameId();
  return currentGameId;
}

function isHumanTurn() {
  return gameActive && !gameResult && chess.turn() === humanColor;
}

function isOnlineGame() {
  return Boolean(onlineGame?.id);
}

function setThinking(thinking) {
  engineThinking = thinking;
  playBtn.disabled = thinking || !isHumanTurn();
  moveInput.disabled = playBtn.disabled;
  concedeBtn.disabled = !gameActive || thinking || Boolean(gameResult);
  playHumanBtn.disabled = thinking || isOnlineGame();
  returnGameBtn.disabled = !latestReturnableGame();
  acceptChallengeBtn.disabled = !incomingChallenge || !gameActive || Boolean(gameResult);
  declineChallengeBtn.disabled = !incomingChallenge;
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
    : "Booting Stockfish worker before Tiberius moves.";
  engineStatusEl.textContent = `${engine} ${memorySummaryText()}`;
}

function startStockfishBoot() {
  if (!stockfishBootPromise) {
    stockfishBootPromise = stockfish.boot().then(ready => {
      stockfishReady = ready;
      refreshEngineStatus();
      return ready;
    }).catch(error => {
      stockfishReady = false;
      statusMessage = "Stockfish failed to boot; Tiberius is using overlay memory.";
      refreshEngineStatus();
      console.warn("Stockfish boot failed", error);
      return false;
    });
  }
  return stockfishBootPromise;
}

async function ensureStockfishReady() {
  if (stockfishReady) return true;
  statusMessage = "Tiberius is solving. Waiting for the Stockfish anchor...";
  refreshEngineStatus();
  render();
  return startStockfishBoot();
}

function squareColor(square) {
  const fileIndex = "abcdefgh".indexOf(square[0]);
  const rankIndex = Number(square[1]) - 1;
  return ((fileIndex + rankIndex) % 2 === 0) ? "dark" : "light";
}

function syncSummary() {
  const pending = readOutbox().length;
  syncTextEl.textContent = pending
    ? `Linked to Tiberius core. ${pending} game update${pending === 1 ? "" : "s"} queued until the core accepts them.`
    : "Linked to Tiberius core. All game updates are sent.";
}

function gameSnapshot() {
  const id = ensureGameId();
  return {
    id,
    active: gameActive && !gameResult,
    status: gameResult ? "complete" : gameActive ? "active" : "idle",
    game_id: onlineGame?.id || null,
    fen: chess.fen(),
    pgn: chess.pgn(),
    human_color: colorName(humanColor),
    opponent_color: colorName(tiberiusColor()),
    opponent: isOnlineGame() ? onlineGame.opponent : "Tiberius",
    result: gameResult,
    turn: colorName(chess.turn()),
    moves: chess.history(),
    updated_at: new Date().toISOString(),
  };
}

function onlineSummary() {
  const relay = multiplayer.connected ? "Relay connected" : "Relay not connected";
  const available = gameActive && !gameResult ? "available while playing" : "unavailable until a board is active";
  const opponent = onlineGame ? ` Online game vs ${onlineGame.opponent || "player"}.` : "";
  const notice = onlineNotice ? ` ${onlineNotice}` : "";
  onlineStatusEl.textContent = `${relay}. ${multiplayer.label()} is ${available}.${opponent}${notice}`;
  incomingChallengeEl.classList.toggle("hidden", !incomingChallenge);
  if (incomingChallenge) {
    incomingTextEl.textContent = `${incomingChallenge.from_name || incomingChallenge.from || "A player"} wants to interrupt this game.`;
  }
}

function render() {
  boardEl.innerHTML = "";
  const baseFiles = ["a","b","c","d","e","f","g","h"];
  const baseRanks = ["8","7","6","5","4","3","2","1"];
  const files = humanColor === "b" ? [...baseFiles].reverse() : baseFiles;
  const ranks = humanColor === "b" ? [...baseRanks].reverse() : baseRanks;
  const legalTargets = selected
    ? chess.moves({ square: selected, verbose: true }).map(move => move.to)
    : [];
  for (let r = 0; r < 8; r += 1) {
    for (let f = 0; f < 8; f += 1) {
      const square = `${files[f]}${ranks[r]}`;
      const piece = chess.get(square);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `square ${squareColor(square)}`;
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
  humanSideEl.textContent = colorName(humanColor);
  opponentLabelEl.textContent = isOnlineGame() ? "Opponent" : "Tiberius";
  tiberiusSideEl.textContent = isOnlineGame() ? `${onlineGame.opponent} (${colorName(tiberiusColor())})` : colorName(tiberiusColor());
  newWhiteBtn.classList.toggle("active-side", humanColor === "w");
  newBlackBtn.classList.toggle("active-side", humanColor === "b");
  newWhiteBtn.setAttribute("aria-pressed", String(humanColor === "w"));
  newBlackBtn.setAttribute("aria-pressed", String(humanColor === "b"));
  moveInput.placeholder = humanColor === "b" ? "black move: e7e5 or Nf6" : "white move: e2e4 or Nf3";
  turnText.textContent = colorName(chess.turn());
  resultTextEl.textContent = gameResult || (gameActive ? "In progress" : "Idle");
  movesEl.textContent = chess.history().length ? chess.history().join(" ") : "(none)";
  fenEl.textContent = chess.fen();
  strategyLabelEl.textContent = lastStrategy;
  statusEl.textContent = statusMessage;
  if (chess.isGameOver() && !gameResult) {
    gameResult = chess.isCheckmate() ? (chess.turn() === "w" ? "0-1" : "1-0") : "1/2-1/2";
    gameActive = false;
  }
  syncSummary();
  onlineSummary();
  renderSavedGames();
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

function readSavedGames() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_GAMES_KEY)) || [];
  } catch (_err) {
    return [];
  }
}

function writeSavedGames(games) {
  try {
    localStorage.setItem(SAVED_GAMES_KEY, JSON.stringify(games.slice(0, 40)));
  } catch (_err) {}
}

function gameRecord(reason = "progress") {
  const snapshot = gameSnapshot();
  return {
    ...snapshot,
    reason,
    saved_at: new Date().toISOString(),
    last_strategy: lastStrategy,
    status_message: statusMessage,
    trajectory,
    online_game: onlineGame,
  };
}

function upsertSavedGame(record) {
  const games = readSavedGames().filter(game => game.id !== record.id);
  writeSavedGames([record, ...games]);
}

function latestReturnableGame() {
  return readSavedGames().find(game => game.id !== currentGameId && game.status !== "complete") || null;
}

function saveState(reason = "progress", { sync = true } = {}) {
  const record = gameRecord(reason);
  try {
    localStorage.setItem(PHONE_STATE_KEY, JSON.stringify({
      gameId: currentGameId,
      fen: chess.fen(),
      humanColor,
      gameActive,
      gameResult,
      statusMessage,
      lastStrategy,
      history: chess.history(),
      trajectory,
      onlineGame,
    }));
  } catch (_err) {}
  upsertSavedGame(record);
  renderSavedGames();
  if (sync) queueSync("game_progress", { reason, game: record });
}

function loadSavedState() {
  try {
    const saved = JSON.parse(localStorage.getItem(PHONE_STATE_KEY));
    if (!saved) return false;
    currentGameId = saved.gameId || makeGameId();
    humanColor = saved.humanColor === "b" ? "b" : "w";
    gameActive = Boolean(saved.gameActive);
    gameResult = saved.gameResult || "";
    onlineGame = saved.onlineGame || null;
    statusMessage = saved.statusMessage || `Restored game. You are ${colorName(humanColor)}.`;
    lastStrategy = saved.lastStrategy || lastStrategy;
    trajectory = Array.isArray(saved.trajectory) ? saved.trajectory : [];
    if (Array.isArray(saved.history) && saved.history.length) {
      chess.reset();
      for (const move of saved.history) chess.move(move, { sloppy: true });
      if (saved.fen && chess.fen() !== saved.fen) chess.load(saved.fen);
    } else if (saved.fen) {
      chess.load(saved.fen);
    }
    return true;
  } catch (_err) {}
  return false;
}

function loadGameRecord(record) {
  if (!record?.id) return;
  gameSerial += 1;
  currentGameId = record.id;
  humanColor = record.human_color === "white" ? "w" : "b";
  gameActive = record.status !== "complete";
  gameResult = record.result || "";
  onlineGame = record.online_game || null;
  statusMessage = `Restored ${record.id}.`;
  lastStrategy = record.last_strategy || lastStrategy;
  trajectory = Array.isArray(record.trajectory) ? record.trajectory : [];
  selected = null;
  engineThinking = false;
  chess.reset();
  if (Array.isArray(record.moves) && record.moves.length) {
    for (const move of record.moves) chess.move(move, { sloppy: true });
    if (record.fen && chess.fen() !== record.fen) chess.load(record.fen);
  } else if (record.fen) {
    chess.load(record.fen);
  }
  saveState("resume", { sync: false });
  render();
}

function renderSavedGames() {
  if (!savedGamesEl || !saveStatusEl) return;
  const games = readSavedGames();
  saveStatusEl.textContent = `${ensureGameId()} saved locally. ${readOutbox().length} core update${readOutbox().length === 1 ? "" : "s"} queued.`;
  const returnable = latestReturnableGame();
  returnGameBtn.textContent = returnable ? "Return to Game" : "No Saved Game";
  savedGamesEl.innerHTML = "";
  for (const game of games.slice(0, 6)) {
    const row = document.createElement("div");
    row.className = "saved-game-row";
    const label = document.createElement("span");
    label.textContent = `${game.status || "active"} · ${game.moves?.length || 0} moves · ${new Date(game.saved_at || game.updated_at || Date.now()).toLocaleString()}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mini-action";
    button.textContent = game.id === currentGameId ? "Current" : "Resume";
    button.disabled = game.id === currentGameId;
    button.addEventListener("click", () => loadGameRecord(game));
    row.append(label, button);
    savedGamesEl.appendChild(row);
  }
}

function readOutbox() {
  try {
    return JSON.parse(localStorage.getItem(PHONE_OUTBOX_KEY)) || [];
  } catch (_err) {
    return [];
  }
}

function writeOutbox(events) {
  try {
    localStorage.setItem(PHONE_OUTBOX_KEY, JSON.stringify(events.slice(-2000)));
  } catch (_err) {}
}

function queueSync(type, payload = {}) {
  const snapshot = gameSnapshot();
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    payload,
    game_id: snapshot.id,
    game: snapshot,
    fen: chess.fen(),
    pgn: chess.pgn(),
    human_color: colorName(humanColor),
    tiberius_color: colorName(tiberiusColor()),
    result: gameResult,
    created_at: new Date().toISOString(),
    source: "tiberius-phone-github-pages",
  };
  writeOutbox([...readOutbox(), event]);
  flushSync();
  syncSummary();
}

async function flushSync() {
  const events = readOutbox();
  if (!events.length) {
    syncSummary();
    return;
  }
  for (const endpoint of SYNC_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });
      if (!response.ok) continue;
      writeOutbox([]);
      syncSummary();
      return;
    } catch (_err) {}
  }
  syncSummary();
}

function enterOnlineGame(game) {
  if (!game?.id) return;
  gameSerial += 1;
  onlineGame = {
    id: game.id,
    opponent: game.opponent_name || game.opponent || "player",
    color: game.color === "b" ? "b" : "w",
  };
  humanColor = onlineGame.color;
  if (game.fen) {
    chess.load(game.fen);
  } else {
    chess.reset();
  }
  gameActive = true;
  gameResult = "";
  selected = null;
  engineThinking = false;
  statusMessage = `Online game started against ${onlineGame.opponent}.`;
  onlineNotice = "Tiberius paused; waiting on human moves.";
  saveState();
  render();
}

function applyRemoteMove(event) {
  if (!onlineGame || event.game_id !== onlineGame.id || !event.move) return;
  const beforeFen = chess.fen();
  const move = typeof event.move === "string" ? event.move : event.move.san || event.move.uci;
  if (!move) return;
  const played = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)
    ? chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })
    : chess.move(move, { sloppy: true });
  if (!played) return;
  rememberMove(beforeFen, played);
  statusMessage = `${onlineGame.opponent} played ${played.san}.`;
  finishIfGameOver();
  saveState();
  render();
}

function handleOnlineResponse(data) {
  if (!data) {
    onlineNotice = "Relay unavailable; online play needs the multiplayer endpoint to answer.";
    render();
    return;
  }
  if (Array.isArray(data.incoming) && data.incoming.length) {
    incomingChallenge = data.incoming[0];
  }
  if (Array.isArray(data.events)) {
    for (const event of data.events) {
      if (event.type === "move") applyRemoteMove(event);
      if (event.type === "challenge") incomingChallenge = event;
    }
  }
  if (data.game) enterOnlineGame(data.game);
  onlineNotice = data.message || onlineNotice;
  render();
}

async function heartbeatOnline() {
  const data = await multiplayer.heartbeat(gameSnapshot());
  handleOnlineResponse(data);
}

async function sendChallenge(random) {
  const target = random ? "" : challengeTargetInput.value.trim();
  onlineNotice = random ? "Looking for a random human player..." : `Looking for ${target || "player"}...`;
  render();
  const data = await multiplayer.challenge({ target, random, game: gameSnapshot() });
  handleOnlineResponse(data);
}

function playHuman() {
  saveState("human_matchmaking");
  const target = challengeTargetInput.value.trim();
  sendChallenge(!target);
}

async function answerChallenge(accept) {
  if (!incomingChallenge) return;
  const challengeId = incomingChallenge.id || incomingChallenge.challenge_id;
  onlineNotice = accept ? "Accepting challenge..." : "Declining challenge.";
  const data = await multiplayer.respond({ challengeId, accept });
  if (!accept) incomingChallenge = null;
  handleOnlineResponse(data);
}

function finishIfGameOver() {
  if (!chess.isGameOver() || gameResult) return;
  gameResult = chess.isCheckmate() ? (chess.turn() === "w" ? "0-1" : "1-0") : "1/2-1/2";
  gameActive = false;
  statusMessage = `Game over: ${gameResult}.`;
  queueSync("game_complete", {});
}

function completeGameLearning(force = false) {
  if (!trajectory.length || (!force && !chess.isGameOver() && !gameResult)) return;
  const score = gameResult === "1-0" ? 1 : gameResult === "0-1" ? 0 : whiteScore();
  for (const item of trajectory) {
    learnMemory(phoneMemory, new Chess(item.fen), item.move, bucketForPosition(item.fen, score));
  }
  trajectory = [];
  savePhoneMemory();
  rebuildOverlay();
  refreshEngineStatus();
}

function onSquare(square) {
  if (engineThinking || !isHumanTurn() || chess.isGameOver()) return;
  const piece = chess.get(square);
  const ownPiece = piece && piece.color === humanColor;

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
  if (!gameActive || gameResult) {
    puzzleTitleEl.textContent = "Current puzzle";
    puzzleTextEl.textContent = "Start a new game and Tiberius will turn each position into a solvable plan.";
    whyTitleEl.textContent = "Why this works best";
    whyTextEl.textContent = "Tiberius will explain her move after she plays it.";
    whenTextEl.textContent = "Waiting for a move...";
    preserveText.textContent = "Waiting for a move...";
    tradeoffText.textContent = "Waiting for a move...";
    coachTextEl.textContent = "Try to find the move that improves your pieces without loosening your structure.";
    return;
  }
  const side = colorName(chess.turn());
  puzzleTitleEl.textContent = isHumanTurn() ? "Your move" : "Tiberius is solving";
  puzzleTextEl.textContent = isHumanTurn()
    ? `${side[0].toUpperCase()}${side.slice(1)} to move. Find the cleanest improving move: gain space, improve a piece, or answer the threat without creating a new weakness.`
    : `${side[0].toUpperCase()}${side.slice(1)} to move. Tiberius is looking for the strongest low-waste future, not just a flashy move.`;
  whyTitleEl.textContent = "Why this works best";
  whyTextEl.textContent = predictionLine();
  whenTextEl.textContent = "Tiberius takes control if your move lets the hidden line stay stable or improves its eval on the next refresh.";
  preserveText.textContent = "This position is being judged by Stockfish search first: eval, forced line, king exposure, material safety, and whether the best reply is forcing.";
  tradeoffText.textContent = "If you reject the predicted pattern, Tiberius has to recalculate from the new board. If you play into it, you may be entering known territory.";
  coachTextEl.textContent = "Puzzle for you: do not ask for the engine move. Ask what kind of position would make its prediction wrong: safer king, changed pawn tension, blocked line, or forcing counter-threat.";
}

async function afterHumanMove(move) {
  render();
  whyTitleEl.textContent = `After your ${move.san}`;
  whyTextEl.textContent = isOnlineGame()
    ? "Move sent to the online relay. Tiberius is paused while the other player answers."
    : "Tiberius has calculated a reply and is predicting the kind of move you are likely to allow next.";
  whenTextEl.textContent = "Tiberius takes control if your move lets the hidden line stay stable or improves its eval on the next refresh.";
  if (chess.isGameOver()) {
    finishIfGameOver();
    completeGameLearning();
    saveState();
    render();
    return;
  }
  if (isOnlineGame()) {
    onlineNotice = `Sent ${move.san}; waiting for ${onlineGame.opponent}.`;
    await multiplayer.move({ gameId: onlineGame.id, move: { san: move.san, uci: uci(move) }, fen: chess.fen(), pgn: chess.pgn() });
    saveState();
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
  const serial = gameSerial;
  setThinking(true);
  render();
  const ready = await ensureStockfishReady();
  if (serial !== gameSerial || isHumanTurn() || !gameActive || gameResult) {
    setThinking(false);
    render();
    return;
  }
  let stockfishBest = null;
  if (ready) {
    const result = await stockfish.bestMove(chess.fen(), { depth: 10 });
    stockfishBest = result?.best || null;
  }
  if (serial !== gameSerial || isHumanTurn() || !gameActive || gameResult) {
    setThinking(false);
    render();
    return;
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
  statusMessage = stockfishBest
    ? `Stockfish anchor available. Tiberius chose ${played.san}.`
    : `Tiberius chose ${played.san} from overlay memory after Stockfish was unavailable.`;
  whyTitleEl.textContent = `Tiberius chose ${played.san}`;
  whyTextEl.textContent = `${predictionLine()} Separately, Stockfish/Tiberius is preserving a hidden search line from the current board.`;
  whenTextEl.textContent = "Tiberius takes control when the opponent plays into the hidden prediction or when their reply worsens the eval. If they break the prediction, the next search has to prove control again from the new board.";
  preserveText.textContent = `It preserved overlay score ${decision.score.toFixed(3)} from ${before.split(" ")[0].slice(0, 18)}...`;
  tradeoffText.textContent = stockfishBest
    ? `Pure Stockfish anchor suggested ${stockfishBest}; Tiberius blended it with memory and structure.`
    : "Stockfish did not return an anchor, so this move came from packaged Tiberius memory and legal overlay search.";
  coachTextEl.textContent = "Puzzle for the opponent: Tiberius just named what it thinks you will do. If it is right, ask whether you are walking into habit. If it is wrong, make the move that changes the position class without hanging the eval.";
  lastStrategy = stockfishBest && uci(played) === stockfishBest ? "Stockfish anchored / memory blended" : "Memory overlay deviation";
  setThinking(false);
  finishIfGameOver();
  completeGameLearning();
  saveState();
  queueSync("move", { san: played.san, uci: uci(played), by: "tiberius" });
  render();
}

function submitMove() {
  if (engineThinking || !isHumanTurn()) return;
  const text = moveInput.value.trim();
  if (!text) return;
  const beforeFen = chess.fen();
  const result = chess.move(text, { sloppy: true });
  if (!result) {
    whyTitleEl.textContent = "Illegal move";
    whyTextEl.textContent = "Try SAN like Nf3, UCI like e2e4, or tap a piece and target square on the board.";
    return;
  }
  rememberMove(beforeFen, result);
  statusMessage = `You played ${result.san}.`;
  saveState();
  queueSync("move", { san: result.san, uci: uci(result), by: "human" });
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
  onlineNameInput.value = multiplayer.player.name || "";
  render();
  loadPhoneMemory();
  const restored = loadSavedState();
  if (!restored) {
    humanColor = "b";
    gameActive = true;
    gameResult = "";
    statusMessage = "New game started. You are black.";
    saveState();
  }
  const manifest = await loadManifest();
  await loadMemoryPhase(manifest, "initial");
  refreshEngineStatus();
  explainForHumanTurn();
  render();

  startStockfishBoot();

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

  flushSync();
  heartbeatOnline();
  setInterval(heartbeatOnline, 25000);
  if (gameActive && !gameResult && !isHumanTurn()) {
    engineMove();
  }
}

function startNewGame(color) {
  gameSerial += 1;
  currentGameId = makeGameId();
  chess.reset();
  humanColor = color === "b" ? "b" : "w";
  gameActive = true;
  gameResult = "";
  onlineGame = null;
  statusMessage = `New game started. You are ${colorName(humanColor)}.`;
  lastStrategy = "Balanced / not enough moves yet";
  selected = null;
  trajectory = [];
  moveInput.value = "";
  explainForHumanTurn();
  saveState();
  queueSync("new_game", { human_color: colorName(humanColor) });
  render();
  if (!isHumanTurn()) engineMove();
}

function concedeGame() {
  if (!gameActive || gameResult || engineThinking) return;
  gameResult = humanColor === "w" ? "0-1" : "1-0";
  gameActive = false;
  onlineGame = null;
  statusMessage = "You conceded.";
  completeGameLearning(true);
  saveState();
  queueSync("concede", {});
  render();
}

newWhiteBtn.addEventListener("click", () => startNewGame("w"));
newBlackBtn.addEventListener("click", () => startNewGame("b"));
concedeBtn.addEventListener("click", concedeGame);
newGameBtn.addEventListener("click", () => startNewGame(humanColor));
returnGameBtn.addEventListener("click", () => {
  const game = latestReturnableGame();
  if (game) loadGameRecord(game);
});
onlineNameInput.addEventListener("change", () => {
  multiplayer.setName(onlineNameInput.value);
  heartbeatOnline();
  render();
});
challengeTargetInput.addEventListener("input", () => render());
playHumanBtn.addEventListener("click", playHuman);
acceptChallengeBtn.addEventListener("click", () => answerChallenge(true));
declineChallengeBtn.addEventListener("click", () => answerChallenge(false));

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
