"""Long-running agent: keeps a WebSocket to Django, answers allow-listed file operations, reconnects with backoff.
There is deliberately no operation that executes commands, writes, moves or deletes user files."""
from __future__ import annotations

import asyncio
import json
import logging
import random
import socket
from pathlib import Path

import websockets

from local_agent.config import VERSION, AgentConfig, load_config
from local_agent.document_transfer.upload import upload
from local_agent.file_access.guard import AccessDenied, describe, resolve
from local_agent.file_search import search
from local_agent.mac_permissions.check import check_roots

log = logging.getLogger("aura.local_agent")


class Agent:
    def __init__(self, cfg: AgentConfig):
        self.cfg = cfg

    def ws_url(self) -> str:
        return self.cfg.server.replace("https://", "wss://").replace("http://", "ws://") + "/ws/local-agent/"

    # ---- operations (allow-list) -------------------------------------------------------------------------
    def op_roots(self, _):
        return {"roots": check_roots(self.cfg)}

    def op_search(self, a):
        return search.search_files(self.cfg, str(a.get("query", ""))[:300], a.get("root"), int(a.get("limit", 10)))

    def op_search_content(self, a):
        return search.search_content(self.cfg, str(a.get("topic", ""))[:300], a.get("root"), int(a.get("limit", 10)))

    def op_find_directory(self, a):
        return search.find_directory(self.cfg, str(a.get("name", ""))[:200])

    def op_list(self, a):
        real, _ = resolve(self.cfg, a.get("path", ""), must_be_dir=True)
        return search.list_pdfs(self.cfg, real, int(a.get("limit", 200)))

    def op_stat(self, a):
        real, root = resolve(self.cfg, a.get("path", ""))
        return describe(self.cfg, real, root)

    def op_read(self, a, request_id):
        real, root = resolve(self.cfg, a.get("path", ""), must_be_file=True)
        meta = upload(self.cfg.server, self.cfg.token, request_id, real)
        log.info("transferred %s (%s bytes)", real, meta["size"])
        return {**describe(self.cfg, real, root), **meta}

    async def handle(self, ws, msg: dict):
        rid, op, args = msg.get("id"), msg.get("op"), msg.get("args") or {}
        ops = {"roots": self.op_roots, "search": self.op_search, "search_content": self.op_search_content,
               "find_directory": self.op_find_directory, "list": self.op_list, "stat": self.op_stat}
        try:
            if op == "read":
                await ws.send(json.dumps({"type": "progress", "id": rid, "message": "Transferring file securely"}))
                result = await asyncio.to_thread(self.op_read, args, rid)
            elif op in ops:
                result = await asyncio.to_thread(ops[op], args)
            else:
                raise AccessDenied(f"Operation '{op}' is not supported.")
            await ws.send(json.dumps({"type": "response", "id": rid, "ok": True, "result": result}))
        except AccessDenied as e:
            await ws.send(json.dumps({"type": "response", "id": rid, "ok": False, "error": str(e)}))
        except PermissionError:
            await ws.send(json.dumps({"type": "response", "id": rid, "ok": False, "error":
                                      "macOS denied access. Allow the Aura agent under System Settings → Privacy & Security → Files and Folders."}))
        except Exception as e:  # never crash the agent on a single request
            log.exception("op %s failed", op)
            await ws.send(json.dumps({"type": "response", "id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"[:300]}))

    async def session(self):
        async with websockets.connect(self.ws_url(), additional_headers={"Authorization": f"Bearer {self.cfg.token}"},
                                      open_timeout=10, ping_interval=20, max_size=2 ** 22) as ws:
            await ws.send(json.dumps({"type": "hello", "version": VERSION, "hostname": socket.gethostname(),
                                      "roots": check_roots(self.cfg)}))
            log.info("connected to %s", self.cfg.server)

            async def heartbeat():
                while True:
                    await asyncio.sleep(25)
                    await ws.send(json.dumps({"type": "heartbeat"}))

            hb = asyncio.create_task(heartbeat())
            try:
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("type") == "config":
                        self.cfg.disabled = set(msg.get("disabled_roots", []))
                    elif msg.get("type") == "request":
                        asyncio.create_task(self.handle(ws, msg))
            finally:
                hb.cancel()

    async def run_forever(self):
        delay = 1.0
        while True:
            started = asyncio.get_running_loop().time()
            try:
                await self.session()
                delay = 1.0
            except websockets.InvalidStatus as e:
                if e.response.status_code in (401, 403):
                    log.error("Server rejected the agent token. Re-pair with: python manage.py pair_local_agent")
                    delay = 60
                else:
                    log.warning("connection refused: %s", e)
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as e:
                log.warning("disconnected: %s", e)
            if asyncio.get_running_loop().time() - started > 30:
                delay = 1.0  # a healthy session just ended (e.g. server restart): reconnect quickly
            await asyncio.sleep(delay + random.random())
            delay = min(10.0, delay * 2)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(Agent(load_config()).run_forever())
