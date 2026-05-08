const PLAYER_KEY = "tiberius-phone-player-v1";
const NTFY_SEEN_KEY = "tiberius-phone-ntfy-seen-v2";
const NTFY_BASE = "https://ntfy.sh";
const NTFY_PREFIX = "tiberius-phone-chess-v2";
const ROSTER_KEY = "tiberius-phone-public-roster-v6";
const ROSTER_STALE_MS = 90_000;
const PRESENCE_INTERVAL_MS = 15_000;
const RELAY_TIMEOUT_MS = 3_000;
const NTFY_TIMEOUT_MS = 3_000;
const NTFY_CHALLENGE_TTL_MS = 10 * 60_000;

function detectDefaultPlayerName() {
  const platform = String(typeof navigator !== "undefined" ? (navigator.userAgentData?.platform || navigator.platform || "") : "").toLowerCase();
  const ua = String(typeof navigator !== "undefined" ? navigator.userAgent || "" : "").toLowerCase();
  if (/(iphone|ipad|ipod|android|mobile)/i.test(platform) || /(iphone|ipad|ipod|android|mobile)/i.test(ua)) return "";
  if (/mac/i.test(platform) || /mac os/i.test(ua)) return "Dr. Oz";
  return "Mork";
}

const DEFAULT_PLAYER_NAME = detectDefaultPlayerName();
const OFFENSIVE_NAME_PATTERN = /(?:fuck|shit|bitch|asshole|bastard|cunt|dick|whore|slut|piss)/i;
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
const FALLBACK_PLAYERS = [
  { id: "raypalmer", name: "RayPalmer", active: false, available: false, seeded: true, last_seen: 1 },
  { id: "liamz", name: "Liamz", active: false, available: false, seeded: true, last_seen: 1 },
  { id: "queenorma", name: "QueeNorma", active: false, available: false, seeded: true, last_seen: 1 },
  { id: "rick", name: "rick", active: false, available: false, seeded: true, last_seen: 1 },
  { id: "droz", name: "Dr. Oz", active: false, available: false, seeded: true, last_seen: 1 },
  { id: "spock", name: "Spock", active: false, available: false, seeded: true, last_seen: 1 },
];

function detectPlatform() {
  const platform = String(typeof navigator !== "undefined" ? (navigator.userAgentData?.platform || navigator.platform || "") : "").trim();
  if (platform) return platform;
  return "unknown";
}

function sanitizeDisplayName(value, fallback = DEFAULT_PLAYER_NAME) {
  const text = String(value || "").replace(/\s+/g, " ").trim().slice(0, 32);
  if (!text) return fallback;
  if (!/[a-z0-9]/i.test(text)) return fallback;
  if (OFFENSIVE_NAME_PATTERN.test(text)) return fallback;
  return text;
}

function canonicalHandle(name) {
  if (!String(name || "").trim()) return "";
  const handle = safeTopicPart(name).replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return handle.length >= 2 ? handle : "";
}

function isAnonIdentity(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "anon" || text.startsWith("anon-");
}

function firstNamedIdentity(...values) {
  return values.map(value => String(value || "").trim()).find(value => value && !isAnonIdentity(value)) || "";
}

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

function normalizeTimestamp(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string" && /[a-z:-]/i.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return number < 10_000_000_000 ? number * 1000 : number;
}

function rosterRecordActive(player) {
  const lastSeen = normalizeTimestamp(player?.last_seen || player?.updated_at);
  return lastSeen > 0 && Date.now() - lastSeen <= ROSTER_STALE_MS;
}

function rosterIdentityKey(player) {
  const personKey = canonicalRosterKey(firstNamedIdentity(player?.handle, player?.name, player?.id));
  if (PERSON_ROSTER_KEYS.has(personKey)) return `person:${personKey}`;
  const deviceId = String(player?.device_id || player?.deviceId || "").trim();
  if (deviceId) return `device:${deviceId}`;
  return personKey;
}

function betterRosterRecord(current, next) {
  if (!current) return next;
  if (!next) return current;
  const currentActive = rosterRecordActive(current);
  const nextActive = rosterRecordActive(next);
  if (nextActive !== currentActive) return nextActive ? next : current;
  const currentSeen = normalizeTimestamp(current.last_seen || current.updated_at);
  const nextSeen = normalizeTimestamp(next.last_seen || next.updated_at);
  if (nextSeen !== currentSeen) return nextSeen > currentSeen ? next : current;
  const currentCanonical = canonicalDisplayName(current.name || current.handle || current.id, current.name || "");
  const nextCanonical = canonicalDisplayName(next.name || next.handle || next.id, next.name || "");
  if (nextCanonical && next.name === nextCanonical && current.name !== currentCanonical) return next;
  if (String(next.name || "").length < String(current.name || "").length) return next;
  return current;
}

function normalizePlayerIdentity(player, { preserveAliases = true } = {}) {
  const rawName = sanitizeDisplayName(firstNamedIdentity(player?.name, player?.handle), DEFAULT_PLAYER_NAME);
  const fallbackName = sanitizeDisplayName("", DEFAULT_PLAYER_NAME);
  let name = rawName && !isAnonIdentity(rawName)
    ? rawName
    : fallbackName;
  name = canonicalDisplayName(name, name);
  const handle = canonicalHandle(name);
  const deviceId = player?.device_id || player?.deviceId || `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const baseId = isAnonIdentity(player?.id) ? "" : player?.id;
  const id = deviceId || baseId || `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const aliases = new Set(preserveAliases && Array.isArray(player?.aliases) ? player.aliases : []);
  if (preserveAliases && player?.id && !isAnonIdentity(player.id) && player.id !== id) aliases.add(player.id);
  const ownKeys = new Set([id, name, handle].map(canonicalRosterKey).filter(Boolean));
  return {
    id,
    name,
    handle: handle || "",
    device_id: deviceId,
    platform: String(player?.platform || player?.platform_hint || detectPlatform()).trim(),
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

function mergeRosterLists(...lists) {
  const byPlayer = new Map();
  for (const list of lists) {
    for (const player of list || []) {
      const key = rosterIdentityKey(player) || player?.id || player?.name || JSON.stringify(player);
      byPlayer.set(key, betterRosterRecord(byPlayer.get(key), player));
    }
  }
  return [...byPlayer.values()];
}

function publicId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function fetchTextWithTimeout(url, options = {}, timeoutMs = NTFY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
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
    localStorage.removeItem("tiberius-phone-public-roster-v1");
    localStorage.removeItem("tiberius-phone-public-roster-v2");
    localStorage.removeItem("tiberius-phone-public-roster-v3");
    localStorage.removeItem("tiberius-phone-public-roster-v4");
    localStorage.removeItem("tiberius-phone-public-roster-v5");
  } catch (_err) {}
}

function stableId() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_KEY));
    if (saved?.id) {
      const normalized = normalizePlayerIdentity(isAnonIdentity(saved?.id) || isAnonIdentity(saved?.name) ? { ...saved, name: "" } : saved);
      localStorage.setItem(PLAYER_KEY, JSON.stringify(normalized));
      return normalized;
    }
  } catch (_err) {}
  const player = normalizePlayerIdentity({ name: "" });
  try {
    localStorage.setItem(PLAYER_KEY, JSON.stringify(player));
  } catch (_err) {}
  return player;
}

export class MultiplayerClient {
  constructor({ endpoints = [] } = {}) {
    this.endpoints = endpoints;
    clearLegacyRosterStorage();
    this.player = stableId();
    this.pendingRename = false;
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

  setName(name) {
    const clean = sanitizeDisplayName(name, DEFAULT_PLAYER_NAME);
    if (!clean) return;
    this.player = normalizePlayerIdentity({ ...this.player, name: clean }, { preserveAliases: false });
    this.pendingRename = true;
    try {
      localStorage.setItem(PLAYER_KEY, JSON.stringify(this.player));
    } catch (_err) {}
    this.lastPresenceAt = 0;
  }

  label() {
    return this.player.name || "";
  }

  repairIdentity(defaultName = DEFAULT_PLAYER_NAME) {
    const id = String(this.player?.id || "");
    const name = String(this.player?.name || "").trim();
    if (name && !isAnonIdentity(name) && !isAnonIdentity(id)) return false;
    const aliases = [...(this.player.aliases || []), id].filter(Boolean);
    this.player = normalizePlayerIdentity({ ...this.player, name: sanitizeDisplayName(defaultName, DEFAULT_PLAYER_NAME), aliases });
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
      platform: this.player.platform,
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
      payload: { ...payload, rename: Boolean(payload?.rename || this.pendingRename) },
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
        const data = await response.json().catch(() => ({}));
        if (data?.self) {
          const serverName = firstNamedIdentity(data.self.name, data.self.handle);
          this.player = normalizePlayerIdentity({
            ...this.player,
            ...data.self,
            name: serverName || this.player.name,
            handle: serverName ? data.self.handle : this.player.handle,
            platform: this.player.platform,
          }, { preserveAliases: false });
          try {
            localStorage.setItem(PLAYER_KEY, JSON.stringify(this.player));
          } catch (_err) {}
        }
        if (path === "/heartbeat") this.pendingRename = false;
        return data;
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
    let name = sanitizeDisplayName(firstNamedIdentity(player?.name, player?.handle), DEFAULT_PLAYER_NAME);
    if (!name) return;
    let id = canonicalHandle(firstNamedIdentity(player?.id, player?.device_id, player?.deviceId, player?.handle, name));
    const personKey = canonicalRosterKey(firstNamedIdentity(player?.handle, name, id));
    if (PERSON_ROSTER_KEYS.has(personKey)) {
      id = personKey;
      name = canonicalDisplayName(personKey, name);
    }
    if (DEFAULT_PLAYER_NAME && [id, name, player?.handle].some(value => identityKey(value) === identityKey(DEFAULT_PLAYER_NAME))) {
      id = canonicalHandle(DEFAULT_PLAYER_NAME);
      name = canonicalDisplayName(DEFAULT_PLAYER_NAME, DEFAULT_PLAYER_NAME);
    }
    if (!id || !name || isAnonIdentity(id) || isAnonIdentity(name)) return;
    const lastSeen = normalizeTimestamp(player.last_seen || player.updated_at);
    const active = rosterRecordActive({ ...player, last_seen: lastSeen });
    const record = {
      id,
      name,
      handle: PERSON_ROSTER_KEYS.has(personKey) ? personKey : canonicalHandle(player?.handle || name) || id,
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
      const normalizedLastSeen = normalizeTimestamp(player.last_seen || player.updated_at);
      const seeded = Boolean(player.seeded);
      const self = id === this.player.id || id === this.player.handle;
      const active = self || rosterRecordActive({ ...player, last_seen: normalizedLastSeen });
      const record = { ...player, active, available: active, last_seen: normalizedLastSeen || player.last_seen };
      const key = rosterIdentityKey(record);
      byPerson.set(key, betterRosterRecord(byPerson.get(key), record));
      if (!seeded && normalizedLastSeen && now - normalizedLastSeen <= 30 * 60_000) saved[id] = record;
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
    ].filter(value => !isAnonIdentity(value))).map(id => this.topicFor(id));
  }

  async publishTopic(topic, message) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NTFY_TIMEOUT_MS);
    try {
      const response = await fetch(`${NTFY_BASE}/${topic}`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Title": "Tiberius",
          "Tags": "chess",
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }
  }

  async publishNtfy(target, message) {
    return this.publishTopic(this.topicFor(target), message);
  }

  async publishToTargets(targets, message) {
    const cleanTargets = unique(targets.map(target => String(target || "").trim()).filter(Boolean));
    if (!cleanTargets.length) return false;
    let delivered = false;
    let lastError = null;
    for (const target of cleanTargets) {
      try {
        await this.publishNtfy(target, message);
        delivered = true;
      } catch (error) {
        lastError = error;
      }
    }
    if (!delivered && lastError) throw lastError;
    return delivered;
  }

  ntfyTargetsForGame(gameId) {
    const game = this.gamesById.get(gameId);
    return unique(game?._ntfyTargets || game?.ntfy_targets || []);
  }

  async publishPresence(force = false) {
    const now = Date.now();
    if (!force && now - this.lastPresenceAt < PRESENCE_INTERVAL_MS) return false;
    this.lastPresenceAt = now;
    const handle = this.player.handle || canonicalHandle(this.label());
    if (!handle) return false;
    const message = {
      kind: "presence",
      id: handle,
      name: this.label(),
      handle,
      device_id: this.player.device_id,
      updated_at: now,
    };
    await this.publishTopic(this.rosterTopic(), message);
    this.rememberRosterPlayer({ id: handle, name: this.label(), handle, device_id: this.player.device_id, last_seen: now });
    return true;
  }

  async pollRoster() {
    const text = await fetchTextWithTimeout(`${NTFY_BASE}/${this.rosterTopic()}/json?poll=1&since=10m`, { cache: "no-store" });
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
        last_seen: Number(message.updated_at || envelope.time * 1000 || Date.now()),
      });
    }
    return this.rosterPlayers();
  }

  async pollNtfy() {
    await this.publishPresence().catch(() => {});
    const roster = await this.pollRoster().catch(() => this.rosterPlayers());
    const seen = readSeen(this.player.id);
    const incoming = [];
    const events = [];
    let game = null;
    const topicResults = await Promise.all(this.topicsForPlayer().map(async topic => ({
      topic,
      text: await fetchTextWithTimeout(`${NTFY_BASE}/${topic}/json?poll=1&since=30m`, { cache: "no-store" }).catch(() => ""),
    })));
    for (const { topic, text } of topicResults) {
      if (!text) continue;
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
          const messageTime = Number(message.created_at_ms || envelope.time * 1000 || Date.now());
          if (Date.now() - messageTime > NTFY_CHALLENGE_TTL_MS) continue;
          const challenge = {
            id: message.id,
            challenge_id: message.id,
            from: message.from,
            from_name: message.from_name || message.from,
            from_device: message.from_device || "",
            target: message.target,
            target_name: message.target_name || message.target,
            created_at: message.created_at,
            game: message.game || null,
            transport: "ntfy",
          };
          this.incomingById.set(challenge.id, challenge);
          incoming.push(challenge);
        } else if (message.kind === "game_start" && message.game) {
          const ntfyTargets = unique([message.from, message.from_name, message.from_device]);
          game = { ...message.game };
          this.gamesById.set(game.id, { ...game, _transport: "ntfy", _ntfyTargets: ntfyTargets });
          events.push({ type: "game_start", game });
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
      players: roster,
      incoming,
      events,
      game,
      message: "Relay connected.",
    };
  }

  async heartbeat(state) {
    const relayData = await this.request("/heartbeat", state, RELAY_TIMEOUT_MS);
    const relayTransport = this.transport;
    if (relayData?.ok) {
      this.rememberIncoming(relayData);
      this.connected = true;
      this.transport = relayTransport;
      return relayData;
    }
    const ntfyData = await this.pollNtfy().catch(() => null);
    if (ntfyData?.ok) {
      this.rememberIncoming(ntfyData);
      return ntfyData;
    }
    this.connected = false;
    this.transport = "";
    return null;
  }

  async challenge({ target = "", targetDevice = "", targetName = "", targetHandle = "", random = false, inviterColor = "w", game }) {
    const payload = { target, targetDevice, targetName, targetHandle: targetHandle || targetName || target, random, inviterColor, game };
    const data = await this.request("/challenge", payload, RELAY_TIMEOUT_MS);
    if (data?.ok) {
      this.connected = true;
      return data;
    }
    let ntfyDelivered = false;
    const ntfyTargets = unique([target, targetDevice, targetName, targetHandle]);
    if (ntfyTargets.length) {
      const challengeId = publicId("challenge");
      ntfyDelivered = await this.publishToTargets(ntfyTargets, {
        kind: "challenge",
        id: challengeId,
        from: this.player.id,
        from_name: this.label(),
        from_handle: this.player.handle,
        from_device: this.player.device_id,
        target,
        target_name: targetName || target,
        target_handle: targetHandle || targetName || target,
        target_device: targetDevice,
        game,
        created_at: new Date().toISOString(),
        created_at_ms: Date.now(),
      }).catch(() => false);
    }
    if (ntfyDelivered) {
      this.connected = true;
      this.transport = "public ntfy relay";
      return {
        ok: true,
        players: this.rosterPlayers(),
        message: `Invite sent to ${targetName || targetHandle || target}.`,
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
    const data = await this.request("/challenge/respond", { challengeId, accept }, RELAY_TIMEOUT_MS);
    if (data?.ok && accept && data.game) {
      this.gamesById.set(data.game.id, data.game);
      this.incomingById.delete(challengeId);
      return data;
    }
    if (data && (!accept || !challenge)) return data;
    if (!challenge || challenge.transport !== "ntfy") return data || null;
    this.incomingById.delete(challengeId);
    const ntfyTargets = unique([challenge.from, challenge.from_name, challenge.from_device]);
    if (!accept) {
      await this.publishToTargets(ntfyTargets, {
        kind: "challenge_declined",
        id: publicId("decline"),
        challenge_id: challengeId,
        from: this.player.id,
        from_name: this.label(),
        from_device: this.player.device_id,
        created_at: new Date().toISOString(),
        created_at_ms: Date.now(),
      }).catch(() => {});
      return { ok: true, players: this.rosterPlayers(), message: "Invite declined." };
    }
    const gameId = publicId("game");
    const responderGame = {
      id: gameId,
      inviter_id: challenge.from,
      accepter_id: this.player.id,
      opponent: challenge.from_name || challenge.from || "player",
      opponent_name: challenge.from_name || challenge.from || "player",
    };
    const inviterGame = {
      id: gameId,
      inviter_id: challenge.from,
      accepter_id: this.player.id,
      opponent: this.label(),
      opponent_name: this.label(),
    };
    const delivered = await this.publishToTargets(ntfyTargets, {
      kind: "game_start",
      id: gameId,
      challenge_id: challengeId,
      from: this.player.id,
      from_name: this.label(),
      from_device: this.player.device_id,
      game: inviterGame,
      created_at: new Date().toISOString(),
      created_at_ms: Date.now(),
    }).catch(() => false);
    if (!delivered) return data || null;
    this.gamesById.set(gameId, { ...responderGame, _transport: "ntfy", _ntfyTargets: ntfyTargets });
    this.connected = true;
    this.transport = "public ntfy relay";
    return { ok: true, players: this.rosterPlayers(), game: responderGame, message: "Challenge accepted." };
  }

  async move({ gameId, move, fen, pgn }) {
    const stored = this.gamesById.get(gameId);
    const data = stored?._transport === "ntfy" ? null : await this.request("/game/move", { gameId, move, fen, pgn }, RELAY_TIMEOUT_MS);
    if (data?.ok) return data;
    const ntfyTargets = this.ntfyTargetsForGame(gameId);
    const delivered = await this.publishToTargets(ntfyTargets, {
      kind: "move",
      id: publicId("move"),
      game_id: gameId,
      move,
      fen,
      pgn,
      from: this.player.id,
      from_name: this.label(),
      from_device: this.player.device_id,
      created_at: new Date().toISOString(),
      created_at_ms: Date.now(),
    }).catch(() => false);
    return delivered ? { ok: true, message: "Move relayed." } : data || null;
  }

  async forfeit({ gameId, reason = "interrupted" }) {
    const stored = this.gamesById.get(gameId);
    const data = stored?._transport === "ntfy" ? null : await this.request("/game/forfeit", { gameId, reason }, RELAY_TIMEOUT_MS);
    if (data?.ok) return data;
    const ntfyTargets = this.ntfyTargetsForGame(gameId);
    const delivered = await this.publishToTargets(ntfyTargets, {
      kind: "forfeit",
      id: publicId("forfeit"),
      game_id: gameId,
      reason,
      from: this.player.id,
      from_name: this.label(),
      from_device: this.player.device_id,
      created_at: new Date().toISOString(),
      created_at_ms: Date.now(),
    }).catch(() => false);
    return delivered ? { ok: true, message: "Forfeit relayed." } : data || null;
  }
}
