const PLAYER_KEY = "tiberius-phone-player-v3";
const NTFY_SEEN_KEY = "tiberius-phone-ntfy-seen-v2";
const NTFY_BASE = "https://ntfy.sh";
const NTFY_PREFIX = "tiberius-phone-chess-v2";
const ROSTER_KEY = "tiberius-phone-public-roster-v8";
const ROSTER_STALE_MS = 90_000;
const PRESENCE_INTERVAL_MS = 15_000;
const RELAY_TIMEOUT_MS = 8_000;

function detectDefaultPlayerName() {
  const platform = String(typeof navigator !== "undefined" ? (navigator.userAgentData?.platform || navigator.platform || "") : "").toLowerCase();
  const ua = String(typeof navigator !== "undefined" ? navigator.userAgent || "" : "").toLowerCase();
  if (/(iphone|ipad|ipod|android|mobile)/i.test(platform) || /(iphone|ipad|ipod|android|mobile)/i.test(ua)) return "RayPalmer";
  if (/mac/i.test(platform) || /mac os/i.test(ua)) return "Dr. Oz";
  return "Mork";
}

const DEFAULT_PLAYER_NAME = detectDefaultPlayerName();
const FALLBACK_PLAYERS = [
  { id: "rick", name: "rick", active: false, available: false, seeded: true },
  { id: "queenorma", name: "QueeNorma", active: false, available: false, seeded: true },
];

function removePrefixedStorage(prefix) {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch (_err) {}
}

function canonicalHandle(name) {
  const handle = safeTopicPart(name).replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return handle.length >= 2 ? handle : "";
}

function runtimePlatform() {
  return String(typeof navigator !== "undefined" ? (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "") : "").trim();
}

function isAnonIdentity(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "anon" || text.startsWith("anon-");
}

function identityKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function canonicalRosterKey(value) {
  const key = identityKey(value);
  if (/^mo(?:r(?:k|t(?:i(?:m(?:er?)?)?)?)?)?$/.test(key)) return "mork";
  if (/^dr(?:\.|\s)?oz$/.test(key) || key === "droz") return "droz";
  if (key === "raypalmer") return "raypalmer";
  return key;
}

function rosterIdentityKey(player) {
  const personKey = canonicalRosterKey(player?.handle || player?.name || player?.id);
  if (personKey === "mork") return "person:mork";
  if (personKey === "droz") return "person:droz";
  if (personKey === "raypalmer") return "person:raypalmer";
  const deviceId = String(player?.device_id || player?.deviceId || "").trim();
  if (deviceId) return `device:${deviceId}`;
  return personKey;
}

function betterRosterRecord(current, next) {
  if (!current) return next;
  if (!next) return current;
  const currentActive = Boolean(current.active || current.available);
  const nextActive = Boolean(next.active || next.available);
  if (nextActive !== currentActive) return nextActive ? next : current;
  const currentSeen = Number(current.last_seen || 0);
  const nextSeen = Number(next.last_seen || 0);
  if (nextSeen !== currentSeen) return nextSeen > currentSeen ? next : current;
  if (String(next.name || "").length < String(current.name || "").length) return next;
  return current;
}

function normalizePlayerIdentity(player, { preserveAliases = true } = {}) {
  const rawName = String(player?.name || "").trim().slice(0, 32);
  const savedId = String(player?.id || "").trim();
  let name = rawName && !isAnonIdentity(rawName)
    ? rawName
    : isAnonIdentity(savedId) ? DEFAULT_PLAYER_NAME : savedId || DEFAULT_PLAYER_NAME;
  const handle = canonicalHandle(name);
  const baseId = isAnonIdentity(player?.id) ? "" : player?.id;
  const id = handle || baseId || `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const deviceId = player?.device_id || player?.deviceId || `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const aliases = new Set(preserveAliases && Array.isArray(player?.aliases) ? player.aliases : []);
  if (preserveAliases && player?.id && !isAnonIdentity(player.id) && player.id !== id) aliases.add(player.id);
  const ownKeys = new Set([id, name, handle].map(canonicalRosterKey).filter(Boolean));
  return {
    id,
    name,
    handle: handle || "",
    device_id: deviceId,
    aliases: [...aliases].filter(alias => !ownKeys.has(canonicalRosterKey(alias))).slice(0, 8),
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

function mergeProgress(current = {}, incoming = {}) {
  const merged = { ...(current || {}) };
  for (const key of [
    "successful_moves_learned",
    "stockfish_training_anchors",
    "stockfish_training_positions",
    "stockfish_agreements",
    "completed_games_evaluated",
    "exact_positions",
  ]) {
    const next = Number(incoming?.[key] || 0);
    const prev = Number(merged[key] || 0);
    if (next > prev) merged[key] = next;
  }
  if (incoming?.updated_at) merged.updated_at = incoming.updated_at;
  return merged;
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

function readRoster() {
  try {
    return JSON.parse(localStorage.getItem(ROSTER_KEY)) || {};
  } catch (_err) {
    return {};
  }
}

function writeRoster(roster) {
  try {
    const deduped = {};
    for (const player of Object.values(roster || {})) {
      const key = rosterIdentityKey(player);
      if (!key || isAnonIdentity(key)) continue;
      const id = canonicalHandle(player?.handle || player?.name || player?.id) || key;
      deduped[id] = betterRosterRecord(deduped[id], { ...player, id });
    }
    localStorage.setItem(ROSTER_KEY, JSON.stringify(deduped));
  } catch (_err) {}
}

function clearLegacyRosterStorage() {
  try {
    removePrefixedStorage("tiberius-phone-public-roster-v");
    removePrefixedStorage("tiberius-phone-player-v");
    localStorage.removeItem(ROSTER_KEY);
    localStorage.removeItem(PLAYER_KEY);
  } catch (_err) {}
}

function stableId(defaultName = DEFAULT_PLAYER_NAME) {
  const targetName = String(defaultName || "").trim();
  let deviceId = "";
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_KEY));
    deviceId = String(saved?.device_id || saved?.deviceId || "").trim();
  } catch (_err) {}
  const player = normalizePlayerIdentity({
    id: canonicalHandle(targetName) || targetName.toLowerCase(),
    name: targetName || "Mork",
    handle: canonicalHandle(targetName) || "mork",
    device_id: deviceId || `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    aliases: [],
  });
  try {
    localStorage.setItem(PLAYER_KEY, JSON.stringify(player));
  } catch (_err) {}
  return player;
}

export class MultiplayerClient {
  constructor({ endpoints = [] } = {}) {
    this.endpoints = endpoints;
    clearLegacyRosterStorage();
    this.player = stableId(DEFAULT_PLAYER_NAME);
    this.connected = false;
    this.lastError = "";
    this.transport = "";
    this.incomingById = new Map();
    this.gamesById = new Map();
    this.rosterById = new Map();
    for (const player of FALLBACK_PLAYERS) this.rememberRosterPlayer(player);
    for (const player of Object.values(readRoster())) this.rememberRosterPlayer(player);
    this.lastPresenceAt = 0;
  }

  resetIdentity(defaultName = DEFAULT_PLAYER_NAME) {
    clearLegacyRosterStorage();
    this.player = stableId(defaultName);
    this.lastPresenceAt = 0;
    return this.player;
  }

  setName(name) {
    const clean = String(name || "").trim();
    if (!clean) return;
    this.player = normalizePlayerIdentity({ ...this.player, name: clean }, { preserveAliases: false });
    try {
      localStorage.setItem(PLAYER_KEY, JSON.stringify(this.player));
    } catch (_err) {}
    this.lastPresenceAt = 0;
  }

  label() {
    return this.player.name || DEFAULT_PLAYER_NAME;
  }

  repairIdentity(defaultName = DEFAULT_PLAYER_NAME) {
    const desiredName = String(defaultName || "").trim();
    const id = String(this.player?.id || "");
    const name = String(this.player?.name || "").trim();
    if (desiredName && identityKey(name) === identityKey(desiredName) && identityKey(id) === identityKey(desiredName)) return false;
    if (name && !isAnonIdentity(name) && !isAnonIdentity(id) && !desiredName) return false;
    const aliases = [...(this.player.aliases || []), id].filter(Boolean);
    this.player = normalizePlayerIdentity({ ...this.player, name: desiredName || defaultName || "", aliases });
    try {
      localStorage.setItem(PLAYER_KEY, JSON.stringify(this.player));
    } catch (_err) {}
    this.lastPresenceAt = 0;
    return true;
  }

  clearIdentity() {
    this.player = normalizePlayerIdentity({
      id: "",
      name: "",
      handle: "",
      device_id: this.player.device_id,
      aliases: [],
    });
    try {
      localStorage.setItem(PLAYER_KEY, JSON.stringify(this.player));
    } catch (_err) {}
    this.lastPresenceAt = 0;
  }

  async request(path, payload = {}, timeoutMs = RELAY_TIMEOUT_MS) {
    const body = {
      player: { ...this.player, progress: payload?.progress || null },
      client: "tiberius-phone-github-pages",
      platform: runtimePlatform(),
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

  rememberRosterPlayer(player) {
    if (isAnonIdentity(player?.id) || isAnonIdentity(player?.name) || isAnonIdentity(player?.handle)) return;
    let id = canonicalHandle(player?.id || player?.name || player?.handle);
    let name = String(player?.name || player?.handle || id || "").trim().slice(0, 32);
    const personKey = canonicalRosterKey(player?.handle || name || id);
    if (DEFAULT_PLAYER_NAME && [id, name, player?.handle].some(value => identityKey(value) === identityKey(DEFAULT_PLAYER_NAME))) {
      id = canonicalHandle(DEFAULT_PLAYER_NAME);
      name = DEFAULT_PLAYER_NAME;
    }
    if (!id || !name || isAnonIdentity(id) || isAnonIdentity(name)) return;
    const lastSeen = Number(player.last_seen || Date.now());
    const active = Date.now() - lastSeen <= ROSTER_STALE_MS;
    const record = {
      id,
      name,
      handle: canonicalHandle(player?.handle || name) || id,
      device_id: String(player?.device_id || player?.deviceId || "").trim(),
      active,
      available: active,
      last_seen: lastSeen,
      public_roster: true,
      seeded: Boolean(player.seeded),
    };
    const key = rosterIdentityKey(record);
    const existingKey = [...this.rosterById.entries()]
      .find(([existingId, existingPlayer]) => canonicalRosterKey(existingId) === key || rosterIdentityKey(existingPlayer) === key)?.[0];
    this.rosterById.set(existingKey || record.id, betterRosterRecord(existingKey ? this.rosterById.get(existingKey) : null, record));
  }

  rosterPlayers() {
    const now = Date.now();
    const saved = {};
    const byPerson = new Map();
    for (const [id, player] of this.rosterById.entries()) {
      if (isAnonIdentity(id) || isAnonIdentity(player?.name) || isAnonIdentity(player?.handle)) continue;
      const lastSeen = Number(player.last_seen || 0);
      const seeded = Boolean(player.seeded);
      const self = id === this.player.id || id === this.player.handle;
      const active = self || now - lastSeen <= ROSTER_STALE_MS;
      const record = { ...player, active, available: active };
      const key = rosterIdentityKey(record);
      byPerson.set(key, betterRosterRecord(byPerson.get(key), record));
      if (!seeded && now - lastSeen <= 30 * 60_000) saved[id] = record;
    }
    writeRoster(saved);
    return [...byPerson.values()];
  }

  topicFor(id) {
    return `${NTFY_PREFIX}-${safeTopicPart(id)}`;
  }

  rosterTopic() {
    return `${NTFY_PREFIX}-public-roster`;
  }

  topicsForPlayer() {
    return unique([
      this.player.id,
      this.player.handle,
      this.player.name,
      ...(this.player.aliases || []),
    ]).map(id => this.topicFor(id));
  }

  async publishTopic(topic, message) {
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

  async publishNtfy(target, message) {
    return this.publishTopic(this.topicFor(target), message);
  }

  async publishPresence(force = false, state = {}) {
    const now = Date.now();
    if (!force && now - this.lastPresenceAt < PRESENCE_INTERVAL_MS) return false;
    this.lastPresenceAt = now;
    const handle = this.player.handle || canonicalHandle(this.label());
    if (!handle) return false;
    await this.publishTopic(this.rosterTopic(), {
      kind: "presence",
      id: handle,
      name: this.label(),
      handle,
      device_id: this.player.device_id,
      progress: state.progress || null,
      updated_at: now,
    });
    this.rememberRosterPlayer({ id: handle, name: this.label(), handle, device_id: this.player.device_id, progress: state.progress || null, last_seen: now });
    return true;
  }

  async pollRoster() {
    const response = await fetch(`${NTFY_BASE}/${this.rosterTopic()}/json?poll=1&since=5m`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = await response.text();
    let progress = {};
    for (const line of text.split(/\n+/)) {
      if (!line.trim()) continue;
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch (_err) {
        continue;
      }
      if (envelope.event !== "message") continue;
      let message;
      try {
        message = JSON.parse(envelope.message || "{}");
      } catch (_err) {
        continue;
      }
      if (message.kind !== "presence") continue;
      this.rememberRosterPlayer({
        id: message.id || message.handle || message.name,
        name: message.name || message.handle || message.id,
        handle: message.handle || message.id,
        device_id: message.device_id || message.deviceId,
        progress: message.progress || null,
        last_seen: Number(message.updated_at || envelope.time * 1000 || Date.now()),
      });
      progress = mergeProgress(progress, message.progress || {});
    }
    return { players: this.rosterPlayers(), progress };
  }

  async pollNtfy(state = {}) {
    await this.publishPresence(false, state).catch(() => {});
    const rosterData = await this.pollRoster().catch(() => ({ players: this.rosterPlayers(), progress: {} }));
    const roster = Array.isArray(rosterData) ? rosterData : rosterData.players;
    let progress = Array.isArray(rosterData) ? {} : (rosterData.progress || {});
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
        } else if (message.kind === "progress") {
          progress = mergeProgress(progress, message.progress || {});
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
      players: roster,
      incoming,
      events,
      progress,
      message: "Relay connected.",
    };
  }

  async heartbeat(state) {
    const data = await this.request("/heartbeat", state, RELAY_TIMEOUT_MS);
    if (data?.ok) {
      this.rememberIncoming(data);
      this.connected = true;
      return data;
    }
    return this.pollNtfy(state).catch(() => {
      this.connected = false;
      this.transport = "";
      return null;
    });
  }

  async challenge({ target = "", targetName = "", random = false, inviterColor = "w", game }) {
    const payload = { target, targetName, targetHandle: targetName || target, random, inviterColor, game };
    const data = await this.request("/challenge", payload, RELAY_TIMEOUT_MS);
    if (data?.ok) {
      this.connected = true;
      return data;
    }
    const roster = this.rosterPlayers();
    const chosen = target || (random ? roster.find(player => player.active && player.id !== this.player.id)?.id : "");
    if (!chosen) return data || { ok: false, players: roster, message: "No active player available." };
    const challengeId = `ntfy-challenge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await this.publishNtfy(chosen, {
      kind: "challenge",
      id: challengeId,
      from: this.player.handle || this.player.id,
      from_name: this.label(),
      from_device: this.player.device_id,
      target: chosen,
      target_name: targetName || chosen,
      inviter_color: inviterColor,
      game,
      created_at: new Date().toISOString(),
    });
    this.connected = true;
    this.transport = "public ntfy relay";
    return { ok: true, players: roster, message: `Invite sent to ${targetName || chosen}.` };
  }

  poke({ target = "", random = false, game }) {
    return this.request("/poke", { target, random, game });
  }

  async respond({ challengeId, accept }) {
    const challenge = this.incomingById.get(challengeId);
    const data = await this.request("/challenge/respond", { challengeId, accept }, RELAY_TIMEOUT_MS);
    if (data?.ok && accept && data.game) {
      this.gamesById.set(data.game.id, data.game);
      this.incomingById.delete(challengeId);
      return data;
    }
    if (data && (!accept || !challenge)) return data;
    if (!challenge) return data || null;
    if (!accept) return { ok: true, message: "Invite declined." };
    const game = {
      id: `ntfy-game-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      white: challenge.from,
      black: this.player.handle || this.player.id,
      inviter_id: challenge.from,
      accepter_id: this.player.handle || this.player.id,
      opponent: challenge.from_name || challenge.from,
      opponent_name: challenge.from_name || challenge.from,
      opponent_id: challenge.from,
      color: "b",
    };
    await this.publishNtfy(challenge.from, {
      kind: "game_start",
      from: this.player.handle || this.player.id,
      from_name: this.label(),
      from_device: this.player.device_id,
      game: {
        ...game,
        opponent: this.label(),
        opponent_name: this.label(),
        opponent_id: this.player.handle || this.player.id,
        color: "w",
      },
    });
    this.gamesById.set(game.id, game);
    this.incomingById.delete(challengeId);
    this.connected = true;
    this.transport = "public ntfy relay";
    return { ok: true, game, message: "Invite accepted." };
  }

  async move({ gameId, move, fen, pgn }) {
    const data = await this.request("/game/move", { gameId, move, fen, pgn }, RELAY_TIMEOUT_MS);
    if (data?.ok) return data;
    const game = this.gamesById.get(gameId);
    const target = game?.opponent_id || game?.opponent;
    if (!target) return data || null;
    await this.publishNtfy(target, {
      kind: "move",
      from: this.player.handle || this.player.id,
      from_name: this.label(),
      from_device: this.player.device_id,
      game_id: gameId,
      move,
      fen,
      pgn,
    });
    this.connected = true;
    this.transport = "public ntfy relay";
    return { ok: true, message: "Move relayed." };
  }

  async forfeit({ gameId, reason = "interrupted" }) {
    const data = await this.request("/game/forfeit", { gameId, reason }, RELAY_TIMEOUT_MS);
    if (data?.ok) return data;
    const game = this.gamesById.get(gameId);
    const target = game?.opponent_id || game?.opponent;
    if (!target) return data || null;
    await this.publishNtfy(target, {
      kind: "forfeit",
      from: this.player.handle || this.player.id,
      from_name: this.label(),
      from_device: this.player.device_id,
      game_id: gameId,
      reason,
    });
    this.connected = true;
    this.transport = "public ntfy relay";
    return { ok: true, message: "Forfeit relayed." };
  }
}
