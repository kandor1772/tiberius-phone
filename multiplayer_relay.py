#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
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


PROGRESS_KEYS = (
    "successful_moves_learned",
    "stockfish_training_anchors",
    "stockfish_training_positions",
    "stockfish_agreements",
    "completed_games_evaluated",
    "exact_positions",
)


class RelayState:
    def __init__(self, state_path: Path | None = None) -> None:
        self.lock = threading.RLock()
        self.state_path = state_path
        self.players: dict[str, dict] = {}
        self.challenges: dict[str, dict] = {}
        self.games: dict[str, dict] = {}
        self.events: dict[str, list[dict]] = {}
        self.shared_progress: dict[str, object] = {}
        self.sync_events: list[dict] = []
        self.memory_snapshot: dict[str, object] = {
            "positions": {},
            "global_moves": {},
            "outcomes": {},
            "transitions": {},
            "meta": {
                "source": "tiberius-always-on-backend",
                "updated_at": "",
            },
        }
        self.load()

    def load(self) -> None:
        if not self.state_path or not self.state_path.exists():
            return
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception:
            return
        self.shared_progress = data.get("shared_progress") or {}
        self.sync_events = data.get("sync_events") or []
        snapshot = data.get("memory_snapshot")
        if isinstance(snapshot, dict):
            self.memory_snapshot = snapshot

    def save(self) -> None:
        if not self.state_path:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.state_path.with_suffix(f"{self.state_path.suffix}.tmp")
            tmp.write_text(json.dumps({
                "shared_progress": self.shared_progress,
                "sync_events": self.sync_events[-5000:],
                "memory_snapshot": self.memory_snapshot,
                "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }, separators=(",", ":")), encoding="utf-8")
            tmp.replace(self.state_path)
        except Exception:
            return

    def merge_progress(self, progress: dict | None) -> None:
        if not isinstance(progress, dict):
            return
        for key in PROGRESS_KEYS:
            current = float(self.shared_progress.get(key) or 0)
            incoming = float(progress.get(key) or 0)
            if incoming > current:
                self.shared_progress[key] = incoming
        if progress.get("updated_at"):
            self.shared_progress["updated_at"] = progress["updated_at"]
        elif any(key in progress for key in PROGRESS_KEYS):
            self.shared_progress["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def update_memory_snapshot_meta(self) -> None:
        self.memory_snapshot.setdefault("positions", {})
        self.memory_snapshot.setdefault("global_moves", {})
        self.memory_snapshot.setdefault("outcomes", {})
        self.memory_snapshot.setdefault("transitions", {})
        meta = self.memory_snapshot.setdefault("meta", {})
        meta["source"] = "tiberius-always-on-backend"
        meta["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for key in PROGRESS_KEYS:
            if key in self.shared_progress:
                meta[key] = self.shared_progress[key]

    def ingest_phone_sync(self, events: list[dict]) -> dict:
        accepted = []
        with self.lock:
            for event in events:
                if not isinstance(event, dict):
                    continue
                accepted.append(event)
                payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
                game = event.get("game") if isinstance(event.get("game"), dict) else payload.get("game")
                progress = payload.get("progress") or event.get("progress")
                if isinstance(game, dict):
                    progress = progress or game.get("progress")
                self.merge_progress(progress if isinstance(progress, dict) else None)
                if event.get("type") in {"game_complete", "human_game_complete"}:
                    current = float(self.shared_progress.get("completed_games_evaluated") or 0)
                    self.shared_progress["completed_games_evaluated"] = current + 1
            if accepted:
                self.sync_events.extend(accepted)
                self.sync_events = self.sync_events[-5000:]
                self.update_memory_snapshot_meta()
                self.save()
            return {
                "ok": True,
                "accepted": len(accepted),
                "progress": self.shared_progress,
                "memory_url": "/tiberius-memory-lite.json",
                "message": "Tiberius core sync accepted.",
            }

    def _ids_for(self, player: dict) -> set[str]:
        return normalized_keys(
            player.get("id"),
            player.get("name"),
            player.get("handle"),
        )

    def _device_id_for(self, player: dict) -> str:
        return str(player.get("device_id") or player.get("deviceId") or "").strip()

    def _keys_for_record(self, record: dict) -> set[str]:
        return normalized_keys(record.get("id"), record.get("name"), record.get("handle"))

    def _roster_key_for_record(self, record: dict) -> str:
        person_key = canonical_roster_key(record.get("handle") or record.get("name") or record.get("id"))
        if person_key == "mork":
            return f"person:{person_key}"
        device_id = self._device_id_for(record)
        if device_id:
            return f"device:{device_id}"
        return person_key

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

    def touch_player(self, player: dict, platform: str = "") -> dict:
        now = time.time()
        self.prune_stale_players()
        device_id = self._device_id_for(player)
        player_id = str(player.get("id") or player.get("name") or "").strip()
        if not player_id:
            player_id = f"anon-{device_id}" if device_id else ""
        name = str(player.get("name") or player_id).strip()
        handle = str(player.get("handle") or name).strip()
        canonical_name = "Mork"
        name = canonical_name
        handle = canonical_name
        player_id = canonical_roster_key(canonical_name)
        incoming_key = self._roster_key_for_record({
            "id": player_id,
            "name": name,
            "handle": handle,
            "device_id": device_id,
        })
        existing = next((self.players[item] for item in normalized_keys(player_id, handle) if item in self.players), None)
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
        record.update({
            "id": player_id,
            "name": name,
            "handle": handle,
            "device_id": device_id,
            "aliases": [],
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
                "id": record["id"],
                "name": record["name"],
                "handle": record.get("handle") or record["name"],
                "device_id": record.get("device_id") or "",
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

    def heartbeat(self, player: dict, platform: str = "") -> dict:
        with self.lock:
            record = self.touch_player(player, platform)
            progress = player.get("progress") or {}
            if isinstance(progress, dict):
                self.merge_progress(progress)
                self.update_memory_snapshot_meta()
                self.save()
            player_events = self.pop_events_for(record)
            return {
                "ok": True,
                "players": self.roster(),
                "incoming": self.incoming_for(record),
                "events": player_events,
                "progress": self.shared_progress,
                "message": "Relay connected.",
            }

    def challenge(self, player: dict, payload: dict, platform: str = "") -> dict:
        with self.lock:
            sender = self.touch_player(player, platform)
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

    def respond(self, player: dict, payload: dict, platform: str = "") -> dict:
        with self.lock:
            responder = self.touch_player(player, platform)
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

    def move(self, player: dict, payload: dict, platform: str = "") -> dict:
        with self.lock:
            sender = self.touch_player(player, platform)
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

    def forfeit(self, player: dict, payload: dict, platform: str = "") -> dict:
        with self.lock:
            sender = self.touch_player(player, platform)
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

    def _send_text(self, text: str, content_type: str = "text/plain; charset=utf-8", status: int = 200) -> None:
        raw = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        self._send_json({"ok": True})

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self._send_json({
                "ok": True,
                "service": "tiberius-always-on-backend",
                "progress": self.server.state.shared_progress,
            })
            return
        if path == "/tiberius-memory-lite.json":
            self._send_text(json.dumps(self.server.state.memory_snapshot), "application/json; charset=utf-8")
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            body = json.loads(self.rfile.read(length).decode("utf-8") if length else "{}")
            player = body.get("player") or {}
            platform = str(body.get("platform") or "").strip()
            payload = body.get("payload") or {}
            path = urlparse(self.path).path
            if path == "/api/phone-sync" or path.endswith("/phone-sync"):
                events = body.get("events") or []
                data = self.server.state.ingest_phone_sync(events if isinstance(events, list) else [])
            elif path.endswith("/heartbeat"):
                data = self.server.state.heartbeat(player, platform)
            elif path.endswith("/challenge/respond"):
                data = self.server.state.respond(player, payload, platform)
            elif path.endswith("/challenge"):
                data = self.server.state.challenge(player, payload, platform)
            elif path.endswith("/game/move"):
                data = self.server.state.move(player, payload, platform)
            elif path.endswith("/game/forfeit"):
                data = self.server.state.forfeit(player, payload, platform)
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self._send_json(data)
        except Exception as exc:
            self._send_json({"ok": False, "message": str(exc)}, status=500)

    def log_message(self, fmt: str, *args: object) -> None:
        return


class RelayServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], state_path: Path | None = None):
        super().__init__(address, handler)
        self.state = RelayState(state_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8776")))
    parser.add_argument("--state-path", default=os.environ.get("TIBERIUS_STATE_PATH", "state/tiberius-backend-state.json"))
    args = parser.parse_args()
    server = RelayServer((args.host, args.port), RelayHandler, Path(args.state_path))
    print(f"Tiberius always-on backend running at http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
