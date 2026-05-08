const STALE_AFTER_MS = 90_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const PERSON_ROSTER_KEYS = new Set(["mork", "liamz", "raypalmer", "queenorma", "rick", "droz", "spock"]);
const PERSON_DISPLAY_NAMES = {
  mork: "Mork",
  liamz: "Liamz",
  raypalmer: "RayPalmer",
  queenorma: "QueeNorma",
  rick: "rick",
  droz: "Dr. Oz",
  spock: "Spock",
};
const TEST_PROFILE_PREFIXES = [
  "anon", "cf-test", "lan-test", "local-", "public-", "ray-test", "ray-lan",
  "ray-cf", "ray-clean", "ray-move", "ray-win", "norma-test", "norma-lan",
  "norma-cf", "norma-clean", "norma-move", "norma-win", "codex-smoke",
];
const OFFENSIVE_NAME_PATTERN = /(?:fuck|shit|bitch|asshole|bastard|cunt|dick|whore|slut|piss)/i;

function identityKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function canonicalRosterKey(value) {
  const key = identityKey(value);
  if (/^mo(?:r(?:k|t(?:i(?:m(?:er?)?)?)?)?)?$/.test(key)) return "mork";
  return key;
}

function canonicalDisplayName(value, fallback = "") {
  return PERSON_DISPLAY_NAMES[canonicalRosterKey(value)] || fallback;
}

function defaultNameForPlatform(platform) {
  const text = String(platform || "").trim().toLowerCase();
  if (/(iphone|ipad|ipod|android|mobile)/i.test(text)) return "";
  if (/mac|darwin/i.test(text)) return "Dr. Oz";
  if (/win/i.test(text)) return "Mork";
  return "Player";
}

function sanitizeDisplayName(value, fallback = "Player") {
  const text = String(value || "").replace(/\s+/g, " ").trim().slice(0, 32);
  if (!text) return fallback;
  if (!/[a-z0-9]/i.test(text)) return fallback;
  if (OFFENSIVE_NAME_PATTERN.test(text)) return fallback;
  return text;
}

function isTestProfile(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return TEST_PROFILE_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function normalizedKeys(...values) {
  const keys = new Set();
  for (const value of values.flat()) {
    const text = String(value || "").trim();
    if (!text) continue;
    keys.add(text);
    keys.add(text.toLowerCase());
    const canonical = canonicalRosterKey(text);
    if (canonical) keys.add(canonical);
  }
  return keys;
}

function publicPlayer(record) {
  return {
    id: record.id || "",
    name: record.name || "",
    handle: record.handle || record.name || record.id || "",
    device_id: record.device_id || "",
    surface: String(record.surface || "browser").trim().toLowerCase() || "browser",
    aliases: Array.isArray(record.aliases) ? record.aliases : [],
    active: Boolean(record.active),
    available: Boolean(record.available),
    last_seen: record.last_seen || 0,
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function emptyState() {
  return {
    players: [],
    challenges: {},
    games: {},
    events: [],
    shared_progress: {},
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return jsonResponse({ ok: true });
    if (!env.RELAY) return jsonResponse({ ok: false, message: "Relay binding missing." }, 500);
    const id = env.RELAY.idFromName("global");
    return env.RELAY.get(id).fetch(request);
  },
};

export class TiberiusRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.data = null;
  }

  async load() {
    if (!this.data) this.data = await this.state.storage.get("relay") || emptyState();
    this.data.players ||= [];
    this.data.challenges ||= {};
    this.data.games ||= {};
    this.data.events ||= [];
    this.data.shared_progress ||= {};
    return this.data;
  }

  async save() {
    await this.state.storage.put("relay", this.data || emptyState());
  }

  rosterKeyFor(record) {
    const personKey = canonicalRosterKey(record.handle || record.name || record.id);
    const surface = String(record.surface || "browser").trim().toLowerCase() || "browser";
    if (PERSON_ROSTER_KEYS.has(personKey)) return `person:${personKey}:surface:${surface}`;
    const deviceId = String(record.device_id || record.deviceId || "").trim();
    if (deviceId) return `device:${deviceId}`;
    return personKey;
  }

  deliveryKeysFor(...values) {
    return normalizedKeys(...values);
  }

  playerDeliveryKeys(player) {
    return this.deliveryKeysFor(
      player.id,
      player.name,
      player.handle,
      player.device_id,
      player.deviceId,
      player.surface,
      ...(player.aliases || [])
    );
  }

  recordKeys(record) {
    return this.deliveryKeysFor(record.id, record.name, record.handle, record.device_id, ...(record.aliases || []));
  }

  findRecordFor(player) {
    const deviceId = String(player.device_id || player.deviceId || "").trim();
    const surface = String(player.surface || "browser").trim().toLowerCase() || "browser";
    if (deviceId) {
      const byDevice = this.data.players.find(record => String(record.device_id || "").trim() === deviceId);
      if (byDevice) return byDevice;
    }
    const incoming = this.playerDeliveryKeys(player);
    const byKey = this.data.players.find(record => {
      for (const key of this.recordKeys(record)) {
        if (incoming.has(key) && String(record.surface || "browser").trim().toLowerCase() === surface) return true;
      }
      return false;
    });
    if (byKey) return byKey;
    const personKey = canonicalRosterKey(player.handle || player.name || player.id);
    if (PERSON_ROSTER_KEYS.has(personKey)) {
      return this.data.players.find(record => this.rosterKeyFor(record) === `person:${personKey}:surface:${surface}`);
    }
    return null;
  }

  uniqueName(desired, existing = null, platform = "", rename = false) {
    let base = sanitizeDisplayName(desired, defaultNameForPlatform(platform));
    base = canonicalDisplayName(base, base);
    const baseKey = canonicalRosterKey(base);
    const existingKey = existing ? canonicalRosterKey(existing.name || existing.handle || existing.id) : "";
    if (existing && baseKey && baseKey === existingKey) return base;
    const occupied = new Set(this.data.players
      .filter(record => record !== existing)
      .map(record => canonicalRosterKey(record.name || record.handle || record.id))
      .filter(Boolean));
    if (existing && !rename) {
      const current = sanitizeDisplayName(existing.name || existing.handle || existing.id, base);
      if (!occupied.has(canonicalRosterKey(current))) return current;
    }
    if (!occupied.has(baseKey)) return base;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base} ${suffix}`;
      if (!occupied.has(canonicalRosterKey(candidate))) return candidate;
    }
    return `${base} ${crypto.randomUUID().slice(0, 4)}`;
  }

  prune() {
    const cutoff = Date.now() - STALE_AFTER_MS;
    this.data.players = this.data.players.filter(record => Number(record.last_seen || 0) >= cutoff);
    for (const [id, challenge] of Object.entries(this.data.challenges)) {
      if (challenge.status !== "pending" || Date.now() - Number(challenge.created_at_ms || 0) > CHALLENGE_TTL_MS) {
        delete this.data.challenges[id];
      }
    }
    this.data.events = this.data.events.filter(event => Date.now() - Number(event.created_at_ms || 0) <= 30 * 60_000);
  }

  touchPlayer(player, rename = false) {
    this.prune();
    const platform = String(player.platform || player.platform_hint || "").trim();
    const deviceId = String(player.device_id || player.deviceId || "").trim();
    const surface = String(player.surface || "browser").trim().toLowerCase() || "browser";
    const playerId = String(player.device_id || player.deviceId || player.id || player.name || "").trim() || (deviceId ? `anon-${deviceId}` : "");
    const existing = this.findRecordFor(player);
    const desiredName = (
      (rename ? player.name : "")
      || existing?.name
      || player.name
      || player.handle
      || defaultNameForPlatform(platform)
    );
    const name = this.uniqueName(desiredName, existing, platform, rename);
    const personKey = canonicalRosterKey(name || player.handle || playerId);
    const handle = PERSON_ROSTER_KEYS.has(personKey)
      ? personKey
      : canonicalRosterKey(player.handle || name || playerId) || name;
    const aliases = new Set(existing?.aliases || []);
    for (const value of [existing?.id, existing?.name, existing?.handle, player.id, player.name, player.handle]) {
      const text = String(value || "").trim();
      if (text && canonicalRosterKey(text) !== canonicalRosterKey(name)) aliases.add(text);
    }
    const record = existing || {};
    Object.assign(record, {
      id: playerId || handle || name,
      name,
      handle,
      device_id: deviceId,
      surface,
      aliases: [...aliases].slice(-16),
      active: true,
      available: true,
      last_seen: Date.now(),
    });
    if (!existing) this.data.players.push(record);
    return record;
  }

  roster() {
    this.prune();
    const byKey = new Map();
    for (const record of this.data.players) {
      if (isTestProfile(record.id) || isTestProfile(record.name)) continue;
      const active = Date.now() - Number(record.last_seen || 0) <= STALE_AFTER_MS;
      const publicRecord = { ...publicPlayer(record), active, available: active };
      const key = this.rosterKeyFor(publicRecord);
      const current = byKey.get(key);
      if (!current || Number(publicRecord.last_seen || 0) > Number(current.last_seen || 0)) {
        byKey.set(key, publicRecord);
      }
    }
    return [...byKey.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }

  incomingFor(record) {
    const ownKeys = this.recordKeys(record);
    const ownSurface = String(record.surface || "browser").trim().toLowerCase() || "browser";
    const incoming = [];
    for (const challenge of Object.values(this.data.challenges)) {
      if (challenge.status !== "pending") continue;
      const targetSurface = String(challenge.targetSurface || "browser").trim().toLowerCase() || "browser";
      if (ownSurface !== targetSurface) continue;
      const targetKeys = this.deliveryKeysFor(challenge.target, challenge.targetName, challenge.targetHandle, challenge.targetDevice, ...(challenge.targetKeys || []));
      if ([...ownKeys].some(key => targetKeys.has(key))) incoming.push(this.publicChallenge(challenge));
    }
    return incoming;
  }

  publicChallenge(challenge) {
    return {
      id: challenge.id,
      challenge_id: challenge.id,
      from: challenge.from,
      from_name: challenge.from_name,
      from_device: challenge.from_device || "",
      target: challenge.target || "",
      target_name: challenge.targetName || challenge.target || "",
      created_at: challenge.created_at,
    };
  }

  popEventsFor(record) {
    const ownKeys = this.recordKeys(record);
    const events = [];
    const kept = [];
    const seen = new Set();
    for (const item of this.data.events) {
      const targetKeys = this.deliveryKeysFor(item.targetKeys || []);
      if ([...ownKeys].some(key => targetKeys.has(key))) {
        const marker = JSON.stringify(item.event);
        if (!seen.has(marker)) {
          seen.add(marker);
          events.push(item.event);
        }
      } else {
        kept.push(item);
      }
    }
    this.data.events = kept;
    return events;
  }

  queueEvent(targetRecord, event) {
    const record = typeof targetRecord === "string"
      ? this.data.players.find(player => this.recordKeys(player).has(targetRecord) || this.recordKeys(player).has(targetRecord.toLowerCase()))
      : targetRecord;
    const targetKeys = record ? [...this.recordKeys(record)] : [...this.deliveryKeysFor(targetRecord)];
    this.data.events.push({ targetKeys, event, created_at_ms: Date.now() });
  }

  mergeProgress(progress = {}) {
    for (const key of [
      "successful_moves_learned",
      "stockfish_training_anchors",
      "stockfish_training_positions",
      "stockfish_agreements",
      "completed_games_evaluated",
      "exact_positions",
    ]) {
      const current = Number(this.data.shared_progress[key] || 0);
      const incoming = Number(progress[key] || 0);
      if (incoming > current) this.data.shared_progress[key] = incoming;
    }
    if (progress.updated_at) this.data.shared_progress.updated_at = progress.updated_at;
  }

  async handlePost(path, body) {
    const player = body.player || {};
    const payload = body.payload || {};
    const rename = Boolean(payload.rename);
    if (path.endsWith("/heartbeat")) return this.heartbeat(player, payload, rename);
    if (path.endsWith("/challenge/respond")) return this.respond(player, payload, rename);
    if (path.endsWith("/challenge")) return this.challenge(player, payload, rename);
    if (path.endsWith("/game/move")) return this.move(player, payload, rename);
    if (path.endsWith("/game/forfeit")) return this.forfeit(player, payload, rename);
    return jsonResponse({ ok: false, message: "Not found." }, 404);
  }

  heartbeat(player, payload, rename) {
    const record = this.touchPlayer(player, rename);
    this.mergeProgress(player.progress || payload.progress || {});
    return jsonResponse({
      ok: true,
      players: this.roster(),
      incoming: this.incomingFor(record),
      events: this.popEventsFor(record),
      progress: this.data.shared_progress,
      self: publicPlayer(record),
      message: "Relay connected.",
    });
  }

  challenge(player, payload, rename) {
    const sender = this.touchPlayer(player, rename);
    let target = String(payload.target || "").trim();
    let targetName = String(payload.targetName || target).trim();
    let targetHandle = String(payload.targetHandle || targetName || target).trim();
    let targetDevice = String(payload.targetDevice || "").trim();
    const targetSurface = String(payload.targetSurface || sender.surface || "browser").trim().toLowerCase() || "browser";
    if (!target && payload.random) {
      const candidate = this.roster().find(item => (
        item.active
        && item.surface === targetSurface
        && item.id !== sender.id
        && item.device_id !== sender.device_id
      ));
      if (candidate) {
        target = candidate.id;
        targetName = candidate.name;
        targetHandle = candidate.handle || candidate.name;
        targetDevice = candidate.device_id || "";
      }
    }
    if (!target && !targetHandle && !targetDevice) {
      return jsonResponse({ ok: false, players: this.roster(), message: "No active player available." });
    }
    const targetKeys = this.deliveryKeysFor(target, targetName, targetHandle, targetDevice);
    const targetRecord = this.data.players.find(candidate => (
      String(candidate.surface || "browser").trim().toLowerCase() === targetSurface
      && [...targetKeys].some(key => this.recordKeys(candidate).has(key))
    ));
    if (targetRecord) {
      target = targetRecord.id;
      targetName = targetRecord.name;
      targetHandle = targetRecord.handle || targetRecord.name;
      targetDevice = targetRecord.device_id || targetDevice;
    }
    const id = `challenge-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.data.challenges[id] = {
      id,
      from: sender.id,
      from_name: sender.name,
      from_device: sender.device_id || "",
      target,
      targetName,
      targetHandle,
      targetDevice,
      targetSurface,
      targetKeys: [...this.deliveryKeysFor(target, targetName, targetHandle, targetDevice)],
      created_at: new Date().toISOString(),
      created_at_ms: Date.now(),
      status: "pending",
    };
    return jsonResponse({
      ok: true,
      players: this.roster(),
      self: publicPlayer(sender),
      message: `Invite sent to ${targetName || targetHandle || target}.`,
    });
  }

  respond(player, payload, rename) {
    const responder = this.touchPlayer(player, rename);
    const challengeId = String(payload.challengeId || "").trim();
    const accept = Boolean(payload.accept);
    const challenge = this.data.challenges[challengeId];
    if (!challenge || challenge.status !== "pending") {
      return jsonResponse({ ok: false, players: this.roster(), message: "Invite is no longer available." });
    }
    challenge.status = accept ? "accepted" : "declined";
    if (!accept) {
      return jsonResponse({ ok: true, players: this.roster(), self: publicPlayer(responder), message: "Invite declined." });
    }
    const gameId = `game-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const game = {
      id: gameId,
      white: challenge.from,
      black: responder.id,
      inviter_id: challenge.from,
      accepter_id: responder.id,
      opponent: challenge.from_name,
      opponent_name: challenge.from_name,
      opponent_id: challenge.from,
    };
    this.data.games[gameId] = game;
    const inviter = this.data.players.find(record => this.recordKeys(record).has(challenge.from) || this.recordKeys(record).has(String(challenge.from).toLowerCase()));
    this.queueEvent(inviter || challenge.from, {
      type: "game_start",
      game: {
        ...game,
        opponent: responder.name,
        opponent_name: responder.name,
        opponent_id: responder.id,
        color: "w",
      },
    });
    return jsonResponse({
      ok: true,
      players: this.roster(),
      self: publicPlayer(responder),
      game: { ...game, color: "b" },
      message: "Invite accepted.",
    });
  }

  move(player, payload, rename) {
    const sender = this.touchPlayer(player, rename);
    const gameId = String(payload.gameId || "").trim();
    const game = this.data.games[gameId];
    if (!game) return jsonResponse({ ok: false, players: this.roster(), message: "Game not found." });
    for (const target of [game.white, game.black]) {
      if (target === sender.id) continue;
      this.queueEvent(target, {
        type: "move",
        game_id: gameId,
        move: payload.move,
        fen: payload.fen,
        pgn: payload.pgn,
      });
    }
    return jsonResponse({ ok: true, players: this.roster(), self: publicPlayer(sender), message: "Move relayed." });
  }

  forfeit(player, payload, rename) {
    const sender = this.touchPlayer(player, rename);
    const gameId = String(payload.gameId || "").trim();
    const game = this.data.games[gameId];
    delete this.data.games[gameId];
    if (game) {
      for (const target of [game.white, game.black]) {
        if (target === sender.id) continue;
        this.queueEvent(target, {
          type: "forfeit",
          game_id: gameId,
          from: sender.id,
          reason: payload.reason || "forfeit",
        });
      }
    }
    return jsonResponse({ ok: true, players: this.roster(), self: publicPlayer(sender), message: "Forfeit relayed." });
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return jsonResponse({ ok: true });
    if (request.method === "GET" && url.pathname === "/health") return jsonResponse({ ok: true, service: "tiberius-multiplayer-relay" });
    if (request.method !== "POST") return jsonResponse({ ok: false, message: "Not found." }, 404);
    try {
      const body = await request.json().catch(() => ({}));
      const response = await this.handlePost(url.pathname, body);
      await this.save();
      return response;
    } catch (error) {
      return jsonResponse({ ok: false, message: error?.message || String(error) }, 500);
    }
  }
}
