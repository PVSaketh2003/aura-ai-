from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .tracer import user_group


class ExecutionEventsConsumer(AsyncJsonWebsocketConsumer):
    """Streams the authenticated user's events. Session-cookie authenticated.
    Subclasses narrow the stream to one family of events (voice, local agent)."""
    prefixes: tuple[str, ...] | None = None  # None = everything except other families' events
    exclude: tuple[str, ...] = ("msg.", "chat.", "call.", "typing")  # messenger events have their own socket

    async def connect(self):
        user = self.scope.get("user")
        if not user or not user.is_authenticated:
            await self.close(code=4401)
            return
        self.group = user_group(user.id)
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()
        await self.send_json({"kind": "socket.ready"})

    async def disconnect(self, code):
        if hasattr(self, "group"):
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive_json(self, content, **kwargs):
        if content.get("kind") == "ping":
            await self.send_json({"kind": "pong"})

    async def execution_event(self, message):
        e = message["event"]
        k = e.get("kind", "")
        if (self.prefixes is None and not k.startswith(self.exclude)) or (self.prefixes and k.startswith(self.prefixes)):
            await self.send_json(e)


class VoiceEventsConsumer(ExecutionEventsConsumer):
    prefixes = ("transcript", "audio.")


class LocalAgentStatusConsumer(ExecutionEventsConsumer):
    prefixes = ("local_agent.",)
