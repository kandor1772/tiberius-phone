const PLAYER_KEY = "tiberius-phone-player-v1";

function stableId() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_KEY));
    if (saved?.id) return saved;
  } catch (_err) {}
  const player = {
    id: `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
  };
  try {
    localStorage.setItem(PLAYER_KEY, JSON.stringify(player));
  } catch (_err) {}
  return player;
}

export class MultiplayerClient {
  constructor({ endpoints = [] } = {}) {
    this.endpoints = endpoints;
    this.player = stableId();
    this.connected = false;
    this.lastError = "";
  }

  setName(name) {
    this.player.name = String(name || "").trim().slice(0, 32);
    try {
      localStorage.setItem(PLAYER_KEY, JSON.stringify(this.player));
    } catch (_err) {}
  }

  label() {
    return this.player.name || this.player.id;
  }

  async request(path, payload = {}, timeoutMs = 3200) {
    const body = {
      player: this.player,
      client: "tiberius-phone-github-pages",
      payload,
    };
    for (const endpoint of this.endpoints) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${endpoint}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) {
          this.lastError = `${response.status} ${response.statusText}`;
          continue;
        }
        this.connected = true;
        this.lastError = "";
        return response.json().catch(() => ({}));
      } catch (error) {
        clearTimeout(timer);
        this.lastError = error?.name === "AbortError" ? "relay timeout" : "relay unavailable";
      }
    }
    this.connected = false;
    return null;
  }

  heartbeat(state) {
    return this.request("/heartbeat", state, 2600);
  }

  challenge({ target = "", random = false, game }) {
    return this.request("/challenge", { target, random, game });
  }

  poke({ target = "", random = false, game }) {
    return this.request("/poke", { target, random, game });
  }

  respond({ challengeId, accept }) {
    return this.request("/challenge/respond", { challengeId, accept });
  }

  move({ gameId, move, fen, pgn }) {
    return this.request("/game/move", { gameId, move, fen, pgn }, 2600);
  }
}
