import logging
from urllib.parse import parse_qs

from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.utils import timezone

from apps.execution_traces.tracer import user_group

from . import bridge
from .models import LocalAgentDevice

log = logging.getLogger(__name__)


class LocalAgentConsumer(AsyncJsonWebsocketConsumer):
    """Connection from the Local Mac Agent. Authenticated with a device token (Authorization header)."""

    async def connect(self):
        headers = dict(self.scope.get("headers", []))
        auth = headers.get(b"authorization", b"").decode()
        token = auth[7:] if auth.lower().startswith("bearer ") else ""
        self.device = await sync_to_async(LocalAgentDevice.authenticate)(token)
        if not self.device:
            await self.close(code=4401)
            return
        self.user_id = self.device.user_id
        await self.channel_layer.group_add(bridge.agent_group(self.user_id), self.channel_name)
        await self.accept()
        await sync_to_async(bridge.mark_online)(self.user_id, str(self.device.id))
        await self._status("online")

    async def disconnect(self, code):
        if getattr(self, "device", None):
            await self.channel_layer.group_discard(bridge.agent_group(self.user_id), self.channel_name)
            await sync_to_async(bridge.mark_offline)(self.user_id, str(self.device.id))
            await self._status("offline")

    async def _status(self, state: str):
        await self.channel_layer.group_send(user_group(self.user_id), {"type": "execution.event", "event": {
            "kind": "local_agent.status", "status": state, "device": self.device.name,
            "hostname": self.device.hostname, "roots": self.device.roots}})

    @sync_to_async
    def _save_hello(self, content):
        d = self.device
        d.hostname = str(content.get("hostname", ""))[:255]
        d.agent_version = str(content.get("version", ""))[:32]
        d.roots = [{"name": str(x.get("name", ""))[:64], "path": str(x.get("path", ""))[:1024],
                    "accessible": bool(x.get("accessible")), "error": str(x.get("error", ""))[:300]}
                   for x in content.get("roots", [])][:32]
        d.last_seen = timezone.now()
        d.save(update_fields=["hostname", "agent_version", "roots", "last_seen"])
        return d.disabled_roots

    async def receive_json(self, content, **kwargs):
        kind = content.get("type")
        if kind == "hello":
            disabled = await self._save_hello(content)
            await self.send_json({"type": "config", "disabled_roots": disabled})
            await self._status("online")
        elif kind == "heartbeat":
            await sync_to_async(bridge.mark_online)(self.user_id, str(self.device.id))
            await sync_to_async(LocalAgentDevice.objects.filter(pk=self.device.pk).update)(last_seen=timezone.now())
            await self.send_json({"type": "heartbeat_ack"})
        elif kind in ("response", "progress") and isinstance(content.get("id"), str):
            await sync_to_async(bridge.deliver_response)(content["id"][:64], content)

    async def agent_request(self, message):
        await self.send_json(message["request"])

    async def agent_config(self, message):
        await self.send_json(message["config"])
