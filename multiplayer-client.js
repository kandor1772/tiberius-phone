const PLAYER_KEY = "tiberius-phone-player-v1";
const NTFY_SEEN_KEY = "tiberius-phone-ntfy-seen-v1";
const NTFY_BASE = "https://ntfy.sh";
const NTFY_PREFIX = "tiberius-phone-chess-v1";

function canonicalHandle(name) {
  const handle = safeTopicPart(name).replace(/^-+|-+$/g, "").slice(0, 32);
  return handle.length >= 2 ? handle : "";
}

function normalizePlayerIdentity(player, { preserveAliases = true } = {}) {
  const name = String(player?.name || "").trim().slice(0, 32);
  const handle = canonicalHandle(name);
  const id = handle || player?.id || `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const deviceId = player?.device_id || player?.deviceId || `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const aliases = new Set(preserveAliases && Array.isArray(player?.aliases) ? player.aliases : []);
  if (preserveAliases && player?.id && player.id !== id) aliases.add(player.id);
  return {
    id,
    name,
    handle: handle || "",
    device_id: deviceId,
    aliases: [...aliases].slice(0, 8),
  };
}

function safeTopicPart(value) {
  return String(value || "anon").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 48) || "anon";
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function mergeLists(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const item of list || []) {
      const id = item?.id || item?.challenge_id || item?.game_id || JSON.stringify(item);
      const key = `${item?.type || ""}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function seenKeyFor(playerId) {
  return `${NTFY_SEEN_KEY}:${safeTopicPart(playerId)}`;
}

function readSeen(playerId) {
  try {
    return JSON.parse(localStorage.getItem(seenKeyFor(playerId))) || {};
  } catch (_err) {
    return {};
  }
}

function writeSeen(playerId, seen) {
  try {
    localStorage.setItem(seenKeyFor(playerId), JSON.stringify(seen));
  } catch (_err) {}
}

function stableId() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_KEY));
    if (saved?.id) {
      const normalized = normalizePlayerIdentity(saved);
      localStorage.setItem(PLAYER_KEY, JSON.stringify(normalized));
      return normalized;
    }
  } catch (_err) {}
  const player = normalizePlayerIdentity({});
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
    this.transport = "";
    this.incomingById = new Map();
    this.gamesById = new Map();
  }

  setName(name) {
    this.player = normalizePlayerIdentity({ ...this.player, name }, { preserveAliases: false });
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
        this.transport = endpoint.includes("127.0.0.1") || endpoint.includes("localhost") ? "local relay" : "DuckDNS relay";
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

  rememberIncoming(data) {
    for (const challenge of data?.incoming || []) {
      const id = challenge.id || challenge.challenge_id;
      if (id) this.incomingById.set(id, challenge);
    }
  }

  topicFor(id) {
    return `${NTFY_PREFIX}-${safeTopicPart(id)}`;
  }

  topicsForPlayer() {
    return unique([
      this.player.id,
      this.player.handle,
      this.player.name,
      ...(this.player.aliases || []),
    ]).map(id => this.topicFor(id));
  }

  async publishNtfy(target, message) {
    const topic = this.topicFor(target);
    const response = await fetch(`${NTFY_BASE}/${topic}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Title": "Tiberius",
        "Tags": "chess",
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json().catch(() => ({}));
  }

  async pollNtfy() {
    const seen = readSeen(this.player.id);
    const incoming = [];
    const events = [];
    for (const topic of this.topicsForPlayer()) {
      const response = await fetch(`${NTFY_BASE}/${topic}/json?poll=1&since=30m`, { cache: "no-store" });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const text = await response.text();
      const seenForTopic = new Set(seen[topic] || []);
      for (const line of text.split(/\n+/)) {
        if (!line.trim()) continue;
        let envelope;
        try {
          envelope = JSON.parse(line);
        } catch (_err) {
          continue;
        }
        if (envelope.event !== "message" || seenForTopic.has(envelope.id)) continue;
        seenForTopic.add(envelope.id);
        let message;
        try {
          message = JSON.parse(envelope.message || "{}");
        } catch (_err) {
          continue;
        }
        if (message.from_device && message.from_device === this.player.device_id) continue;
        if (message.kind === "challenge") {
          const challenge = {
            id: message.id,
            challenge_id: message.id,
            from: message.from,
            from_name: message.from_name || message.from,
            target: message.target,
            target_name: message.target_name || message.target,
            created_at: message.created_at,
            transport: "ntfy",
          };
          this.incomingById.set(challenge.id, challenge);
          incoming.push(challenge);
        } else if (message.kind === "game_start" && message.game) {
          this.gamesById.set(message.game.id, message.game);
          events.push({ type: "game_start", game: message.game });
        } else if (message.kind === "move") {
          events.push({ type: "move", game_id: message.game_id, move: message.move, fen: message.fen, pgn: message.pgn });
        } else if (message.kind === "forfeit") {
          events.push({ type: "forfeit", game_id: message.game_id, from: message.from, reason: message.reason });
        }
      }
      seen[topic] = [...seenForTopic].slice(-200);
    }
    writeSeen(this.player.id, seen);
    this.connected = true;
    this.transport = "public ntfy relay";
    this.lastError = "";
    return {
      ok: true,
      players: [
        { id: "raypalmer", name: "RayPalmer", active: true, available: true, seeded: true },
        { id: "rick", name: "rick", active: true, available: true, seeded: true },
      ],
      incoming,
      events,
      message: "Relay connected.",
    };
  }

  async heartbeat(state) {
    const [relayResult, ntfyResult] = await Promise.allSettled([
      this.request("/heartbeat", state, 1200),
      this.pollNtfy(),
    ]);
    const relayData = relayResult.status === "fulfilled" ? relayResult.value : null;
    const ntfyData = ntfyResult.status === "fulfilled" ? ntfyResult.value : null;
    const data = relayData || ntfyData;
    if (data) {
      const merged = {
        ...data,
        players: mergeLists(relayData?.players, ntfyData?.players),
        incoming: mergeLists(relayData?.incoming, ntfyData?.incoming),
        events: mergeLists(relayData?.events, ntfyData?.events),
        message: relayData && ntfyData ? "Relay connected." : data.message,
      };
      this.rememberIncoming(merged);
      this.connected = true;
      this.transport = relayData && ntfyData ? "DuckDNS + public relay" : this.transport;
      return merged;
    }
    try {
      return await this.pollNtfy();
    } catch (error) {
      this.connected = false;
      this.transport = "";
      this.lastError = error?.message || "relay unavailable";
      return null;
    }
  }

  async challenge({ target = "", targetName = "", random = false, inviterColor = "w", game }) {
    const payload = { target, targetName, targetHandle: targetName || target, random, inviterColor, game };
    const destination = targetName || target;
    const challengeId = `ntfy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const relayPromise = this.request("/challenge", payload, 1200);
    const ntfyPromise = destination ? this.publishNtfy(destination, {
      kind: "challenge",
      id: challengeId,
      from: this.player.id,
      from_name: this.label(),
      from_device: this.player.device_id,
      target: destination,
      target_name: destination,
      inviter_color: "w",
      created_at: new Date().toISOString(),
    }).then(() => true).catch(() => false) : Promise.resolve(false);
    const [relayResult, ntfyResult] = await Promise.allSettled([relayPromise, ntfyPromise]);
    const data = relayResult.status === "fulfilled" ? relayResult.value : null;
    const relayOk = data && data.ok !== false;
    const ntfySent = ntfyResult.status === "fulfilled" && ntfyResult.value;
    if (relayOk || ntfySent) {
      this.connected = true;
      this.transport = relayOk && ntfySent ? "DuckDNS + public relay" : relayOk ? this.transport : "public ntfy relay";
      return relayOk ? data : {
        ok: true,
        players: [
          { id: "raypalmer", name: "RayPalmer", active: true, available: true, seeded: true },
          { id: "rick", name: "rick", active: true, available: true, seeded: true },
        ],
        message: `Invite sent to ${destination}.`,
      };
    }
    this.connected = false;
    return data || null;
  }

  poke({ target = "", random = false, game }) {
    return this.request("/poke", { target, random, game });
  }

  async respond({ challengeId, accept }) {
    const challenge = this.incomingById.get(challengeId);
    const data = await this.request("/challenge/respond", { challengeId, accept }, 1200);
    if (data && (!accept || !challenge)) return data;
    if (!challenge) return null;
    if (!accept) {
      this.incomingById.delete(challengeId);
      return { ok: true, message: "Invite declined." };
    }
    const gameId = `ntfy-game-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const accepterGame = {
      id: gameId,
      inviter_id: challenge.from,
      accepter_id: this.player.id,
      opponent: challenge.from_name || challenge.from,
      opponent_name: challenge.from_name || challenge.from,
      opponent_id: challenge.from,
      color: "b",
    };
    const inviterGame = {
      ...accepterGame,
      opponent: this.label(),
      opponent_name: this.label(),
      opponent_id: this.player.id,
      color: "w",
    };
    try {
      await this.publishNtfy(challenge.from, { kind: "game_start", from_device: this.player.device_id, game: inviterGame });
      this.gamesById.set(gameId, accepterGame);
      this.incomingById.delete(challengeId);
      this.connected = true;
      this.transport = data ? "DuckDNS + public relay" : "public ntfy relay";
      return data || { ok: true, game: accepterGame, message: "Invite accepted." };
    } catch (error) {
      if (data) return data;
      this.lastError = error?.message || "relay unavailable";
      return null;
    }
  }

  async move({ gameId, move, fen, pgn }) {
    const data = await this.request("/game/move", { gameId, move, fen, pgn }, 1200);
    if (data) return data;
    const game = this.gamesById.get(gameId);
    if (!game?.opponent_id) return null;
    try {
      await this.publishNtfy(game.opponent_id, { kind: "move", from_device: this.player.device_id, game_id: gameId, move, fen, pgn });
      this.connected = true;
      this.transport = "public ntfy relay";
      return { ok: true, message: "Move relayed." };
    } catch (_err) {
      return null;
    }
  }

  async forfeit({ gameId, reason = "interrupted" }) {
    const data = await this.request("/game/forfeit", { gameId, reason }, 1200);
    if (data) return data;
    const game = this.gamesById.get(gameId);
    if (game?.opponent_id) {
      await this.publishNtfy(game.opponent_id, { kind: "forfeit", from_device: this.player.device_id, game_id: gameId, from: this.player.id, reason }).catch(() => {});
    }
    return { ok: true, message: "Forfeit relayed." };
  }
}
