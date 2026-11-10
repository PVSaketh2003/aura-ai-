"""Messenger WebSocket (/ws/messenger/): receives this user's msg.*, chat.*, call.* events and relays WebRTC
signalling (SDP offers/answers, ICE candidates) — but only to the other member of a call the sender belongs to."""
from channels.db import database_sync_to_async

from apps.execution_traces.consumers import ExecutionEventsConsumer
from apps.execution_traces.tracer import user_group


class MessengerConsumer(ExecutionEventsConsumer):
    prefixes = ("msg.", "chat.", "call.", "typing")

    async def connect(self):
        await super().connect()
        user = self.scope.get("user")
        if user and user.is_authenticated:
            await database_sync_to_async(_seen)(user)

    async def receive_json(self, content, **kwargs):
        kind = content.get("kind")
        user = self.scope["user"]
        if kind == "ping":
            await self.send_json({"kind": "pong"})
        elif kind == "call.signal":
            to = await database_sync_to_async(_call_peer)(user, content.get("call_id"))
            if to and isinstance(content.get("data"), dict):
                await self.channel_layer.group_send(user_group(to), {"type": "execution.event", "event": {
                    "kind": "call.signal", "call_id": content["call_id"], "from": user.id, "data": content["data"]}})
        elif kind == "typing":
            ids = await database_sync_to_async(_typing_targets)(user, content.get("chat_id"))
            for uid in ids:
                await self.channel_layer.group_send(user_group(uid), {"type": "execution.event", "event": {
                    "kind": "typing", "chat_id": content["chat_id"], "user_id": user.id}})
        elif kind == "msg.delivered":
            await database_sync_to_async(_delivered)(user, content.get("chat_id"), content.get("seq"))


def _seen(user):
    from .services import touch_last_seen
    touch_last_seen(user)


def _call_peer(user, call_id):
    from .models import CallSession, ChatMember
    try:
        c = CallSession.objects.filter(pk=call_id, state__in=["ringing", "active"]).first()
    except Exception:
        return None
    if not c or not ChatMember.objects.filter(chat=c.chat, user=user, state="active").exists():
        return None
    other = ChatMember.objects.filter(chat=c.chat, state="active").exclude(user=user).values_list("user_id", flat=True).first()
    return other


def _typing_targets(user, chat_id):
    from .models import ChatMember
    try:
        if not ChatMember.objects.filter(chat_id=chat_id, user=user, state="active").exists():
            return []
        return list(ChatMember.objects.filter(chat_id=chat_id, state="active").exclude(user=user).values_list("user_id", flat=True))
    except Exception:
        return []


def _delivered(user, chat_id, seq):
    from .models import ChatMember
    from .services import mark
    try:
        m = ChatMember.objects.select_related("chat").filter(chat_id=chat_id, user=user, state__in=["active", "request"]).first()
        if m and isinstance(seq, int):
            mark(user, m, delivered=seq)
    except Exception:
        pass
