#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
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
OFFENSIVE_NAME_PATTERN = re.compile(r"(?:fuck|shit|bitch|asshole|bastard|cunt|dick|whore|slut|piss)", re.I)


def is_test_profile(value: str) -> bool:
    normalized = str(value or "").strip().lower()
    return any(normalized.startswith(prefix) for prefix in TEST_PROFILE_PREFIXES)


def normalized_keys(*values: object) -> set[str]:
    keys = {str(value or "").strip() for value in values}
    keys = {key for key in keys if key}
    keys.update(key.lower() for key in list(keys))
    return keys


def identity_key(value: object) -> str:
    return "".join(ch for ch in str(value or "").strip().lower() if ch.isalnum())


def canonical_roster_key(value: object) -> str:
    key = identity_key(value)
    if key and re.match(r"^mo(?:r(?:k|t(?:i(?:m(?:er?)?)?)?)?)?$", key):
        return "mork"
    return key


def default_name_for_platform(platform: object) -> str:
    text = str(platform or "").strip().lower()
    if any(token in text for token in ("iphone", "ipad", "ipod", "android", "mobile")):
        return ""
    if "mac" in text or "darwin" in text:
        return "Dr. Oz"
    if "win" in text:
        return "Mork"
    return "Player"


def sanitize_display_name(value: object, fallback: str = "Player") -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()[:32]
    if not text:
        return fallback
    if not re.search(r"[A-Za-z0-9]", text):
        return fallback
    if OFFENSIVE_NAME_PATTERN.search(text):
        return fallback
    return text


class RelayState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.players: dict[str, dict] = {}
        self.challenges: dict[str, dict] = {}
        self.games: dict[str, dict] = {}
        self.events: dict[str, list[dict]] = {}
        self.shared_progress: dict[str, object] = {}

    def _ids_for(self, player: dict) -> set[str]:
        return normalized_keys(
            player.get("id"),
            player.get("name"),
            player.get("handle"),
            *(player.get("aliases") or []),
        )

    def _device_id_for(self, player: dict) -> str:
        return str(player.get("device_id") or player.get("deviceId") or "").strip()

    def _keys_for_record(self, record: dict) -> set[str]:
        return normalized_keys(record.get("id"), record.get("name"), record.get("handle"), *(record.get("aliases") or []))

    def _roster_key_for_record(self, record: dict) -> str:
        person_key = canonical_roster_key(record.get("handle") or record.get("name") or record.get("id"))
        if person_key in {"mork", "liamz"}:
            return f"person:{person_key}"
        device_id = self._device_id_for(record)
        if device_id:
            return f"device:{device_id}"
        return person_key

    def _unique_display_name(self, desired: object, device_id: str, existing: dict | None = None, platform: object = "") -> str:
        base = sanitize_display_name(desired, default_name_for_platform(platform))
        occupied = {
            canonical_roster_key(record.get("name") or record.get("handle") or record.get("id"))
            for record in {id(value): value for value in self.players.values()}.values()
            if record is not existing
        }
        if existing:
            current_name = sanitize_display_name(existing.get("name") or existing.get("handle") or existing.get("id"), base)
            if canonical_roster_key(current_name) not in occupied:
                return current_name
        if canonical_roster_key(base) not in occupied:
            return base
        for suffix in range(2, 100):
            candidate = f"{base} {suffix}"
            if canonical_roster_key(candidate) not in occupied:
                return candidate
        return f"{base} {uuid.uuid4().hex[:4]}"

    def _public_player(self, record: dict) -> dict:
        return {
            "id": record.get("id", ""),
            "name": record.get("name", ""),
            "handle": record.get("handle") or record.get("name") or record.get("id") or "",
            "device_id": record.get("device_id") or "",
            "aliases": list(record.get("aliases") or []),
            "active": bool(record.get("active")),
            "available": bool(record.get("available")),
            "last_seen": record.get("last_seen"),
        }

    def _unindex_record(self, record: dict) -> None:
        for key, value in list(self.players.items()):
            if value is record:
                self.players.pop(key, None)

    def _index_record(self, record: dict) -> None:
        for key in self._keys_for_record(record):
            self.players[key] = record

    def prune_stale_players(self) -> None:
        now = time.time()
        for record in list({id(value): value for value in self.players.values()}.values()):
            if now - float(record.get("last_seen", 0)) > STALE_AFTER_SECONDS:
                self._unindex_record(record)

    def _record_for(self, player_id: str) -> dict | None:
        for candidate in normalized_keys(player_id):
            record = self.players.get(candidate)
            if record:
                return record
        return None

    def _event_keys_for(self, player_id: str) -> set[str]:
        keys = normalized_keys(player_id)
        record = self._record_for(player_id)
        if record:
            keys.update(self._keys_for_record(record))
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
        self.prune_stale_players()
        device_id = self._device_id_for(player)
        platform = str(player.get("platform") or player.get("platform_hint") or "").strip()
        player_id = str(player.get("device_id") or player.get("deviceId") or player.get("id") or player.get("name") or "").strip()
        if not player_id:
            player_id = f"anon-{device_id}" if device_id else ""
        existing = next((record for record in {id(value): value for value in self.players.values()}.values() if self._device_id_for(record) == device_id), None)
        if not existing and player_id:
            existing = next((self.players[item] for item in normalized_keys(player_id) if item in self.players), None)
        if not existing and player_id:
            existing = next(
                (
                    record for record in {id(value): value for value in self.players.values()}.values()
                    if canonical_roster_key(record.get("id") or record.get("handle") or record.get("name")) == canonical_roster_key(player_id)
                ),
                None,
            )
        desired_name = player.get("name") or player.get("handle") or (existing.get("name") if existing else "") or default_name_for_platform(platform)
        name = self._unique_display_name(desired_name, device_id, existing, platform)
        handle = sanitize_display_name(player.get("handle") or name or player_id, name)
        incoming_key = self._roster_key_for_record({
            "id": player_id,
            "name": name,
            "handle": handle,
            "device_id": device_id,
        })
        if not existing and incoming_key:
            existing = next(
                (
                    record for record in {id(value): value for value in self.players.values()}.values()
                    if self._roster_key_for_record(record) == incoming_key
                ),
                None,
            )
        if (
            existing
            and self._roster_key_for_record(existing) != incoming_key
            and device_id
            and existing.get("device_id") != device_id
            and normalized_keys(existing.get("id"), existing.get("handle")).isdisjoint(normalized_keys(player_id, handle))
        ):
            existing = None
        record = existing or {}
        if record:
            self._unindex_record(record)
        previous_aliases = [existing.get("id"), existing.get("name"), existing.get("handle")] if existing else []
        previous_aliases.extend(record.get("aliases") or [])
        record.update({
            "id": player_id,
            "name": name,
            "handle": handle,
            "device_id": device_id,
            "aliases": [alias for alias in normalized_keys(*previous_aliases) if canonical_roster_key(alias) != canonical_roster_key(name)],
            "active": True,
            "available": True,
            "last_seen": now,
        })
        self._index_record(record)
        return record

    def roster(self) -> list[dict]:
        now = time.time()
        self.prune_stale_players()
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
                **self._public_player(record),
                "active": active,
                "available": active,
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
            targets = {
                str(challenge.get("target") or ""),
                str(challenge.get("targetName") or ""),
                str(challenge.get("targetHandle") or ""),
                str(challenge.get("targetDevice") or ""),
            }
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
            progress = player.get("progress") or {}
            if isinstance(progress, dict):
                for key in (
                    "successful_moves_learned",
                    "stockfish_training_anchors",
                    "stockfish_training_positions",
                    "stockfish_agreements",
                    "completed_games_evaluated",
                    "exact_positions",
                ):
                    current = float(self.shared_progress.get(key) or 0)
                    incoming = float(progress.get(key) or 0)
                    if incoming > current:
                        self.shared_progress[key] = incoming
                if progress.get("updated_at"):
                    self.shared_progress["updated_at"] = progress["updated_at"]
            player_events = self.pop_events_for(record)
            return {
                "ok": True,
                "players": self.roster(),
                "incoming": self.incoming_for(record),
                "events": player_events,
                "progress": self.shared_progress,
                "self": self._public_player(record),
                "message": "Relay connected.",
            }

    def challenge(self, player: dict, payload: dict) -> dict:
        with self.lock:
            sender = self.touch_player(player)
            target = str(payload.get("target") or "").strip()
            target_name = str(payload.get("targetName") or target).strip()
            target_handle = str(payload.get("targetHandle") or target_name or target).strip()
            target_device = str(payload.get("targetDevice") or "").strip()
            if not target and payload.get("random"):
                for candidate in self.roster():
                    if candidate["id"] != sender["id"] and candidate["active"]:
                        target = candidate["id"]
                        target_name = candidate["name"]
                        target_handle = candidate.get("handle") or target_name
                        target_device = candidate.get("device_id") or ""
                        break
            if not target and not target_handle and not target_device:
                return {"ok": False, "players": self.roster(), "message": "No active player available."}
            target_record = next(
                (
                    candidate for candidate in self.roster()
                    if candidate.get("id") == target
                    or candidate.get("handle") == target
                    or candidate.get("name") == target
                    or candidate.get("device_id") == target
                    or candidate.get("device_id") == target_device
                ),
                None,
            )
            if target_record:
                target = target_record["id"]
                target_name = target_record["name"]
                target_handle = target_record.get("handle") or target_name
                target_device = target_record.get("device_id") or target_device
            challenge_id = f"challenge-{uuid.uuid4().hex[:12]}"
            challenge = {
                "id": challenge_id,
                "from": sender["id"],
                "from_name": sender["name"],
                "target": target,
                "targetName": target_name,
                "targetHandle": target_handle,
                "targetDevice": target_device,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "created_at_ts": time.time(),
                "status": "pending",
            }
            self.challenges[challenge_id] = challenge
            return {
                "ok": True,
                "players": self.roster(),
                "self": self._public_player(sender),
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
                return {"ok": True, "players": self.roster(), "self": self._public_player(responder), "message": "Invite declined."}
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
                "self": self._public_player(responder),
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
            return {"ok": True, "players": self.roster(), "self": self._public_player(sender), "message": "Move relayed."}

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
            return {"ok": True, "players": self.roster(), "self": self._public_player(sender), "message": "Forfeit relayed."}


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
