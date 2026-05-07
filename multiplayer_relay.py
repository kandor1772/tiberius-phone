#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


STALE_AFTER_SECONDS = 90
TEST_PROFILE_PREFIXES = (
    "anon", "cf-test", "lan-test", "local-", "public-", "ray-test", "ray-lan",
    "ray-cf", "ray-clean", "ray-move", "ray-win", "norma-test", "norma-lan",
    "norma-cf", "norma-clean", "norma-move", "norma-win", "codex-smoke",
)


def is_test_profile(value: str) -> bool:
    normalized = str(value or "").strip().lower()
    return any(normalized.startswith(prefix) for prefix in TEST_PROFILE_PREFIXES)


class RelayState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.players: dict[str, dict] = {}
        self.challenges: dict[str, dict] = {}
        self.games: dict[str, dict] = {}
        self.events: dict[str, list[dict]] = {}

    def _ids_for(self, player: dict) -> set[str]:
        ids = {
            str(player.get("id") or "").strip(),
            str(player.get("name") or "").strip(),
            str(player.get("handle") or "").strip(),
            str(player.get("device_id") or player.get("deviceId") or "").strip(),
        }
        for alias in player.get("aliases") or []:
            ids.add(str(alias).strip())
        expanded = {item for item in ids if item}
        expanded.update(item.lower() for item in expanded)
        return expanded

    def _record_for(self, player_id: str) -> dict | None:
        candidates = {str(player_id or "").strip()}
        candidates.update(item.lower() for item in list(candidates) if item)
        for candidate in candidates:
            record = self.players.get(candidate)
            if record:
                return record
        return None

    def _event_keys_for(self, player_id: str) -> set[str]:
        keys = {str(player_id or "").strip()}
        record = self._record_for(player_id)
        if record:
            keys.update(self._ids_for(record))
            keys.update(str(alias).strip() for alias in record.get("aliases") or [])
        keys = {item for item in keys if item}
        keys.update(item.lower() for item in list(keys))
        return keys

    def queue_event(self, player_id: str, event: dict) -> None:
        for key in self._event_keys_for(player_id):
            self.events.setdefault(key, []).append(event)

    def pop_events_for(self, player: dict) -> list[dict]:
        events: list[dict] = []
        seen: set[str] = set()
        for key in self._ids_for(player):
            for event in self.events.pop(key, []):
                marker = json.dumps(event, sort_keys=True)
                if marker in seen:
                    continue
                seen.add(marker)
                events.append(event)
        return events

    def touch_player(self, player: dict) -> dict:
        now = time.time()
        ids = self._ids_for(player)
        existing = next((self.players[item] for item in ids if item in self.players), None)
        player_id = str(player.get("id") or player.get("name") or "").strip()
        if not player_id:
            player_id = "raypalmer"
        name = str(player.get("name") or player_id).strip()
        record = existing or {}
        record.update({
            "id": player_id,
            "name": name,
            "handle": str(player.get("handle") or name).strip(),
            "aliases": sorted(ids | set(record.get("aliases") or [])),
            "active": True,
            "available": True,
            "last_seen": now,
        })
        self.players[player_id] = record
        for alias in record["aliases"]:
            self.players[alias] = record
        return record

    def roster(self) -> list[dict]:
        now = time.time()
        seen: set[int] = set()
        players: list[dict] = []
        for record in self.players.values():
            marker = id(record)
            if marker in seen:
                continue
            seen.add(marker)
            if is_test_profile(record.get("id", "")) or is_test_profile(record.get("name", "")):
                continue
            active = now - float(record.get("last_seen", 0)) <= STALE_AFTER_SECONDS
            players.append({
                "id": record["id"],
                "name": record["name"],
                "handle": record.get("handle") or record["name"],
                "active": active,
                "available": active,
                "last_seen": record.get("last_seen"),
            })
        return sorted(players, key=lambda item: (not item["active"], item["name"].lower()))

    def incoming_for(self, player: dict) -> list[dict]:
        ids = self._ids_for(player)
        now = time.time()
        incoming = []
        for challenge in self.challenges.values():
            if challenge.get("status") != "pending":
                continue
            if now - float(challenge.get("created_at_ts", 0)) > 300:
                challenge["status"] = "expired"
                continue
            targets = {str(challenge.get("target") or ""), str(challenge.get("targetName") or ""), str(challenge.get("targetHandle") or "")}
            targets.update(item.lower() for item in list(targets))
            if ids & {item for item in targets if item}:
                incoming.append(self.public_challenge(challenge))
        return incoming

    def public_challenge(self, challenge: dict) -> dict:
        return {
            "id": challenge["id"],
            "challenge_id": challenge["id"],
            "from": challenge["from"],
            "from_name": challenge["from_name"],
            "target": challenge.get("target") or "",
            "target_name": challenge.get("targetName") or challenge.get("target") or "",
            "created_at": challenge["created_at"],
        }

    def heartbeat(self, player: dict) -> dict:
        with self.lock:
            record = self.touch_player(player)
            player_events = self.pop_events_for(record)
            return {
                "ok": True,
                "players": self.roster(),
                "incoming": self.incoming_for(record),
                "events": player_events,
                "message": "Relay connected.",
            }

    def challenge(self, player: dict, payload: dict) -> dict:
        with self.lock:
            sender = self.touch_player(player)
            target = str(payload.get("target") or "").strip()
            target_name = str(payload.get("targetName") or target).strip()
            target_handle = str(payload.get("targetHandle") or target_name or target).strip()
            if not target and payload.get("random"):
                for candidate in self.roster():
                    if candidate["id"] != sender["id"] and candidate["active"]:
                        target = candidate["id"]
                        target_name = candidate["name"]
                        target_handle = candidate.get("handle") or target_name
                        break
            if not target and not target_handle:
                return {"ok": False, "players": self.roster(), "message": "No active player available."}
            challenge_id = f"challenge-{uuid.uuid4().hex[:12]}"
            challenge = {
                "id": challenge_id,
                "from": sender["id"],
                "from_name": sender["name"],
                "target": target,
                "targetName": target_name,
                "targetHandle": target_handle,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "created_at_ts": time.time(),
                "status": "pending",
            }
            self.challenges[challenge_id] = challenge
            return {
                "ok": True,
                "players": self.roster(),
                "message": f"Invite sent to {target_name or target_handle or target}.",
            }

    def respond(self, player: dict, payload: dict) -> dict:
        with self.lock:
            responder = self.touch_player(player)
            challenge_id = str(payload.get("challengeId") or "").strip()
            accept = bool(payload.get("accept"))
            challenge = self.challenges.get(challenge_id)
            if not challenge or challenge.get("status") != "pending":
                return {"ok": False, "players": self.roster(), "message": "Invite is no longer available."}
            challenge["status"] = "accepted" if accept else "declined"
            if not accept:
                return {"ok": True, "players": self.roster(), "message": "Invite declined."}
            game_id = f"game-{uuid.uuid4().hex[:12]}"
            game = {
                "id": game_id,
                "white": challenge["from"],
                "black": responder["id"],
                "inviter_id": challenge["from"],
                "accepter_id": responder["id"],
                "opponent": challenge["from_name"],
                "opponent_name": challenge["from_name"],
                "opponent_id": challenge["from"],
            }
            self.games[game_id] = game
            inviter_event = {
                "type": "game_start",
                "game": {
                    **game,
                    "opponent": responder["name"],
                    "opponent_name": responder["name"],
                    "opponent_id": responder["id"],
                    "color": "w",
                },
            }
            self.queue_event(challenge["from"], inviter_event)
            return {
                "ok": True,
                "players": self.roster(),
                "game": {**game, "color": "b"},
                "message": "Invite accepted.",
            }

    def move(self, player: dict, payload: dict) -> dict:
        with self.lock:
            sender = self.touch_player(player)
            game_id = str(payload.get("gameId") or "").strip()
            game = self.games.get(game_id)
            if not game:
                return {"ok": False, "players": self.roster(), "message": "Game not found."}
            recipients = [game["white"], game["black"]]
            for target in recipients:
                if target == sender["id"]:
                    continue
                self.queue_event(target, {
                    "type": "move",
                    "game_id": game_id,
                    "move": payload.get("move"),
                    "fen": payload.get("fen"),
                    "pgn": payload.get("pgn"),
                })
            return {"ok": True, "players": self.roster(), "message": "Move relayed."}

    def forfeit(self, player: dict, payload: dict) -> dict:
        with self.lock:
            sender = self.touch_player(player)
            game_id = str(payload.get("gameId") or "").strip()
            game = self.games.pop(game_id, None)
            if game:
                for target in [game["white"], game["black"]]:
                    if target != sender["id"]:
                        self.queue_event(target, {
                            "type": "forfeit",
                            "game_id": game_id,
                            "from": sender["id"],
                            "reason": payload.get("reason") or "forfeit",
                        })
            return {"ok": True, "players": self.roster(), "message": "Forfeit relayed."}


class RelayHandler(BaseHTTPRequestHandler):
    server: "RelayServer"

    def _send_json(self, data: dict, status: int = 200) -> None:
        raw = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        self._send_json({"ok": True})

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/health":
            self._send_json({"ok": True, "service": "tiberius-multiplayer-relay"})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            body = json.loads(self.rfile.read(length).decode("utf-8") if length else "{}")
            player = body.get("player") or {}
            payload = body.get("payload") or {}
            path = urlparse(self.path).path
            if path.endswith("/heartbeat"):
                data = self.server.state.heartbeat(player)
            elif path.endswith("/challenge/respond"):
                data = self.server.state.respond(player, payload)
            elif path.endswith("/challenge"):
                data = self.server.state.challenge(player, payload)
            elif path.endswith("/game/move"):
                data = self.server.state.move(player, payload)
            elif path.endswith("/game/forfeit"):
                data = self.server.state.forfeit(player, payload)
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self._send_json(data)
        except Exception as exc:
            self._send_json({"ok": False, "message": str(exc)}, status=500)

    def log_message(self, fmt: str, *args: object) -> None:
        return


class RelayServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler]):
        super().__init__(address, handler)
        self.state = RelayState()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8776)
    args = parser.parse_args()
    server = RelayServer((args.host, args.port), RelayHandler)
    print(f"Tiberius multiplayer relay running at http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
