# Tiberius Always-On Backend

DuckDNS is only the public name. To keep sync alive when the Mac and Windows PC are off, the service behind that name must run on an always-on host.

This repository now includes one backend process for:

- `POST /api/phone-sync`: accepts queued phone/browser game and training events.
- `POST /api/multiplayer/heartbeat`: keeps multiplayer presence and shared progress moving.
- `POST /api/multiplayer/challenge`, `/challenge/respond`, `/game/move`, `/game/forfeit`: relays live play.
- `GET /tiberius-memory-lite.json`: serves the current shared memory/progress snapshot.
- `GET /health`: health check for uptime monitors and reverse proxies.

## Local Test

```bash
python multiplayer_relay.py --host 127.0.0.1 --port 8776
```

Then check:

```text
http://127.0.0.1:8776/health
http://127.0.0.1:8776/tiberius-memory-lite.json
```

## Docker

```bash
docker compose -f docker-compose.backend.yml up -d --build
```

## Production Shape

Run this backend on a cloud VM or web service, then point DuckDNS at that always-on host:

```text
https://eltiburon.duckdns.org/api/phone-sync
https://eltiburon.duckdns.org/api/multiplayer
https://eltiburon.duckdns.org/tiberius-memory-lite.json
```

Both computers can then be off. The GitHub Pages app stays online, and sync/progress continue through the cloud backend.

## Reverse Proxy

Use Caddy or Nginx to terminate HTTPS and proxy to the backend port.

Caddy example:

```text
eltiburon.duckdns.org {
  reverse_proxy 127.0.0.1:8776
}
```

## State

Persistent state is written to:

```text
state/tiberius-backend-state.json
```

In Docker, that maps to `/data/tiberius-backend-state.json`.

The backend keeps the most recent sync events and shared progress counters. It intentionally uses plain JSON so the state can be inspected, copied, backed up, or replaced by a database later.
