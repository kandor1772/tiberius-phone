# Multiplayer Relay Contract

GitHub Pages can host the Tiberius phone app, but it cannot hold live matchmaking state. Online play needs a relay at:

```text
https://tiberius-phone-relay.q79qmzkmk4.workers.dev
```

The browser client is already prepared for this relay. Until the endpoint exists, the online panel stays safe: it shows relay unavailable, keeps the chess engine working, and does not crash the app.

## Availability Rule

The phone advertises a player as available only while their local board is active:

```json
{
  "active": true,
  "fen": "current FEN",
  "pgn": "current PGN",
  "human_color": "black",
  "turn": "black",
  "moves": ["e4"]
}
```

Players who are not currently playing should be treated as unavailable by the relay. Random matching should pull only from active players unless the requester explicitly starts a fresh open game.

## Anonymous Players

The client creates a stable anonymous id in local storage. The optional display name is saved locally and published to the relay on heartbeat. A signed-out player can:

- select a player from the roster and press `Play Human`
- press `Play Human` with no selected roster row to challenge a random active player

The static client seeds `RP` and `rick` as known active players before the relay responds. Inactive players remain visible, but the client disables direct invites to inactive rows.

No account is required for the first version.

## Endpoints

All requests are `POST` with:

```json
{
  "player": {
    "id": "anon-id-or-account-id",
    "name": "optional display name"
  },
  "client": "tiberius-phone-github-pages",
  "payload": {}
}
```

### `/heartbeat`

Updates presence and returns pending events.

Response:

```json
{
  "message": "optional status",
  "players": [
    {
      "id": "rick",
      "name": "rick",
      "active": true,
      "last_seen": "2026-05-06T19:25:00.000Z"
    }
  ],
  "incoming": [
    {
      "id": "challenge-id",
      "type": "challenge",
      "from": "player-id",
      "from_name": "display name"
    }
  ],
  "events": []
}
```

The client merges `players` into its local roster. Active players sort first; inactive known players remain visible but cannot be selected for a direct invite.

### `/challenge`

Creates a specific or random challenge.

Payload:

```json
{
  "target": "specific player id or handle",
  "random": false,
  "game": { "active": true, "fen": "...", "pgn": "..." }
}
```

### `/challenge/respond`

Payload:

```json
{
  "challengeId": "challenge-id",
  "accept": true
}
```

Accept response:

```json
{
  "game": {
    "id": "game-id",
    "opponent": "opponent-id",
    "opponent_name": "display name",
    "color": "w",
    "fen": "optional starting FEN"
  }
}
```

### `/game/move`

Payload:

```json
{
  "gameId": "game-id",
  "move": { "san": "Nf6", "uci": "g8f6" },
  "fen": "updated FEN",
  "pgn": "updated PGN"
}
```

Remote move event:

```json
{
  "type": "move",
  "game_id": "game-id",
  "move": { "san": "Nf6", "uci": "g8f6" }
}
```

## Large Traffic Guardrails

Use a relay that keeps hot state near the match:

- Cloudflare Durable Objects: one object per game id and sharded matchmaking queues.
- Supabase Realtime: row-level game channels plus a rate-limited challenge table.
- Firebase/Firestore: one document per game plus presence TTL records.

Minimum traffic protections:

- Heartbeat no faster than every 25 seconds per client.
- Challenge rate limit per player and per target.
- Presence records expire automatically after 45-90 seconds.
- Matchmaking queue is sharded by region or hash bucket.
- Game move writes are idempotent by move number.
- Relay never broadcasts global state; it returns only events for the requesting player or game.
- Anonymous ids can play, but abusive ids can be cooled down by fingerprint-free rate limits: IP bucket, player id bucket, and target bucket.

The current phone client already follows the low-frequency heartbeat pattern and keeps Tiberius/Stockfish local, so engine traffic does not hit the relay.
