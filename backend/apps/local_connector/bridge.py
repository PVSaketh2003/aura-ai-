"""Synchronous RPC from agent worker threads to the Local Mac Agent.

request:  worker → channel layer group `localagent.<user>` → consumer → agent (WebSocket)
response: agent → consumer → Redis list `la:resp:<id>` → worker (BLPOP with timeout)
"""
from __future__ import annotations

import json
import uuid
from functools import lru_cache
from typing import Any, Callable

import redis
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from config.env import get_settings

ONLINE_TTL = 75


class AgentOffline(RuntimeError):
    pass


class AgentError(RuntimeError):
    pass


@lru_cache
def r() -> redis.Redis:
    # socket_timeout must exceed the BLPOP timeout used in call()
    return redis.Redis.from_url(get_settings().redis_url, decode_responses=True, socket_timeout=30, socket_connect_timeout=5)


def agent_group(user_id: int) -> str:
    return f"localagent.{user_id}"


def mark_online(user_id: int, device_id: str) -> None:
    r().set(f"la:online:{user_id}", device_id, ex=ONLINE_TTL)


def mark_offline(user_id: int, device_id: str) -> None:
    if r().get(f"la:online:{user_id}") == device_id:
        r().delete(f"la:online:{user_id}")


def online_device(user_id: int) -> str | None:
    return r().get(f"la:online:{user_id}")


def deliver_response(request_id: str, payload: dict) -> None:
    key = f"la:resp:{request_id}"
    r().rpush(key, json.dumps(payload))
    r().expire(key, 120)


def call(user_id: int, op: str, args: dict[str, Any] | None = None, timeout: float | None = None,
         on_progress: Callable[[str], None] | None = None) -> Any:
    import time
    deadline = time.monotonic() + 10  # grace period for an agent that is reconnecting (e.g. after a server restart)
    while not online_device(user_id) and time.monotonic() < deadline:
        if on_progress:
            on_progress("Waiting for the Local Agent to reconnect")
        time.sleep(1)
    if not online_device(user_id):
        raise AgentOffline("Your Mac's Local Agent is offline or the Mac is asleep, so local file operations are "
                           "temporarily unavailable. Start it with: scripts/install_local_agent.sh")
    timeout = timeout or get_settings().local_agent_timeout_seconds
    rid = uuid.uuid4().hex
    if op == "read":
        r().set(f"la:upload:{rid}", user_id, ex=int(timeout) + 60)
    async_to_sync(get_channel_layer().group_send)(agent_group(user_id), {
        "type": "agent.request", "request": {"type": "request", "id": rid, "op": op, "args": args or {}}})
    deadline_left = timeout
    while True:
        item = r().blpop([f"la:resp:{rid}"], timeout=max(1, int(min(deadline_left, 5))))
        if item is None:
            deadline_left -= 5
            if deadline_left <= 0:
                raise AgentError(f"The Local Agent did not answer '{op}' within {int(timeout)}s.")
            continue
        msg = json.loads(item[1])
        if msg.get("type") == "progress":
            if on_progress:
                on_progress(msg.get("message", ""))
            continue
        if not msg.get("ok"):
            raise AgentError(msg.get("error") or "The Local Agent reported an error.")
        result = msg.get("result")
        if op == "read":
            staged = r().get(f"la:upload_done:{rid}")
            if not staged:
                raise AgentError("The file transfer did not complete.")
            result = {**(result or {}), "staged_path": staged}
        return result
