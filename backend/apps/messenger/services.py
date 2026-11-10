"""Messenger core: membership checks, message ordering, delivery state, attachments, real-time fan-out.

Real-time events go to each member's existing per-user channel group (apps.execution_traces.tracer.broadcast), so
only members ever receive a chat's events. Every event has a unique `event_id`; message events carry the chat's
monotonically increasing `seq`, which clients use to drop duplicates and to fetch anything missed while offline."""
from __future__ import annotations

import hashlib
import mimetypes
import uuid
from pathlib import Path

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Q, Sum
from django.http import Http404
from django.utils import timezone

from apps.execution_traces.tracer import broadcast
from config.env import get_settings

from .models import Attachment, Block, Chat, ChatMember, ChatMessage, Contact, PhoneIdentity, Reaction
from .phone import pretty

User = get_user_model()
EDIT_WINDOW_SECONDS = 15 * 60
BLOCKED_EXT = {".exe", ".bat", ".cmd", ".sh", ".app", ".dmg", ".pkg", ".msi", ".js", ".html", ".htm", ".svg", ".php"}


class Forbidden(Exception):
    pass


# --------------------------------------------------------------------------------------------- people & identity
def display_name(u) -> str:
    return u.first_name or u.username


def phone_of(u) -> str:
    return PhoneIdentity.objects.filter(user=u).values_list("phone", flat=True).first() or ""


def name_for(viewer, other) -> str:
    """What the viewer calls `other`: their saved contact name, else the other's display name."""
    ph = phone_of(other)
    if ph:
        c = Contact.objects.filter(owner=viewer, phone=ph).first()
        if c:
            return c.name
    return display_name(other)


def person(viewer, u) -> dict:
    pi = PhoneIdentity.objects.filter(user=u).first()
    last_seen = pi.last_seen.isoformat() if pi and pi.show_last_seen and pi.last_seen else None
    return {"id": u.id, "name": name_for(viewer, u), "display_name": display_name(u),
            "phone": pi.phone if pi else "", "phone_pretty": pretty(pi.phone) if pi else "",
            "about": pi.about if pi else "", "avatar": pi.avatar if pi else "", "last_seen": last_seen}


def is_blocked(a, b) -> bool:
    """True if either user blocked the other."""
    return Block.objects.filter(Q(blocker=a, blocked=b) | Q(blocker=b, blocked=a)).exists()


def registered_user(phone: str):
    """The Aura user who VERIFIED this number, if any (and allows being found)."""
    pi = PhoneIdentity.objects.select_related("user").filter(phone=phone, discoverable=True).first()
    return pi.user if pi else None


# ------------------------------------------------------------------------------------------------- membership
def member_or_404(user, chat_id, *, active=True) -> ChatMember:
    qs = ChatMember.objects.select_related("chat").filter(chat_id=chat_id, user=user)
    qs = qs.filter(state__in=["active", "request"]) if active else qs
    m = qs.first()
    if not m:
        raise Http404
    return m


def require_admin(m: ChatMember) -> None:
    if m.chat.kind != "group" or m.role not in ("owner", "admin") or m.state != "active":
        raise Forbidden("Only group admins can do that.")


def active_member_ids(chat: Chat) -> list[int]:
    return list(chat.members.filter(state__in=["active", "request"]).values_list("user_id", flat=True))


def fanout(chat: Chat, event: dict, user_ids: list[int] | None = None) -> None:
    event = {"event_id": uuid.uuid4().hex, "chat_id": str(chat.id), "ts": timezone.now().isoformat(), **event}
    for uid in (user_ids if user_ids is not None else active_member_ids(chat)):
        broadcast(uid, event)


# ------------------------------------------------------------------------------------------------------- chats
def direct_chat(user, other) -> Chat:
    """The one direct chat between two users (created on first use). If `other` hasn't saved `user` as a contact and
    only accepts messages from contacts, the chat arrives as a message request."""
    if other.id == user.id:
        raise Forbidden("You can't message yourself here — use Aura AI for notes to self.")
    if is_blocked(user, other):
        raise Forbidden("You can't message this person.")
    key = f"{min(user.id, other.id)}:{max(user.id, other.id)}"
    with transaction.atomic():
        chat, created = Chat.objects.get_or_create(direct_key=key, defaults={"kind": "direct", "created_by": user})
        if created:
            ChatMember.objects.create(chat=chat, user=user, role="member", state="active")
            ChatMember.objects.create(chat=chat, user=other, role="member", state=_incoming_state(other, user))
    return chat


def _incoming_state(recipient, sender) -> str:
    """Unknown senders arrive as a request when the recipient only accepts messages from their contacts."""
    pi = PhoneIdentity.objects.filter(user=recipient).first()
    if not pi or pi.who_can_message == "everyone":
        return "active"
    sender_phone = phone_of(sender)
    known = bool(sender_phone) and Contact.objects.filter(owner=recipient, phone=sender_phone).exists()
    return "active" if known else "request"


def chat_summary(viewer, m: ChatMember) -> dict:
    chat = m.chat
    last = chat.messages.filter(seq__gt=m.joined_seq).order_by("-seq").first()
    out = {"id": str(chat.id), "kind": chat.kind, "state": m.state, "role": m.role, "muted": m.muted,
           "archived": m.archived, "unread": max(0, chat.last_seq - max(m.read_seq, m.joined_seq)),
           "last_seq": chat.last_seq, "read_seq": m.read_seq,
           "last_message": message_dict(viewer, last, chat) if last else None,
           "last_message_at": (chat.last_message_at or chat.created_at).isoformat()}
    if chat.kind == "group":
        out.update(name=chat.name, description=chat.description, avatar=chat.avatar,
                   member_count=chat.members.filter(state="active").count())
    else:
        other = chat.members.exclude(user=viewer).select_related("user").first()
        p = person(viewer, other.user) if other else {"name": "Deleted account"}
        out.update(name=p["name"], avatar=p.get("avatar", ""), peer=p,
                   blocked=bool(other) and Block.objects.filter(blocker=viewer, blocked=other.user).exists())
    return out


# ---------------------------------------------------------------------------------------------------- messages
def message_dict(viewer, msg: ChatMessage, chat: Chat | None = None) -> dict:
    chat = chat or msg.chat
    deleted = msg.deleted_at is not None
    d = {"id": str(msg.id), "chat_id": str(chat.id), "seq": msg.seq, "kind": msg.kind, "client_id": msg.client_id,
         "sender_id": msg.sender_id, "sender_name": name_for(viewer, msg.sender) if msg.sender else "Aura",
         "mine": msg.sender_id == viewer.id, "text": "" if deleted else msg.text, "deleted": deleted,
         "forwarded": msg.forwarded, "pinned": msg.pinned, "edited": msg.edited_at is not None,
         "created_at": msg.created_at.isoformat(), "attachment": None, "reply_to": None, "reactions": {}}
    if msg.attachment_id and not deleted:
        a = msg.attachment
        d["attachment"] = {"id": str(a.id), "name": a.name, "mime": a.mime, "size": a.size, "kind": a.kind,
                           "duration": a.duration}
    if msg.reply_to_id:
        r = msg.reply_to
        d["reply_to"] = {"id": str(r.id), "sender_name": name_for(viewer, r.sender) if r.sender else "Aura",
                         "text": "" if r.deleted_at else (r.text[:140] or (r.attachment.name if r.attachment_id else ""))}
    for emoji, uid in msg.reactions.values_list("emoji", "user_id"):
        d["reactions"].setdefault(emoji, []).append(uid)
    if d["mine"] and msg.kind == "text":
        d["status"] = delivery_status(chat, msg)
    return d


def delivery_status(chat: Chat, msg: ChatMessage) -> str:
    """sent → delivered (every other active member's device received it) → read (every other member read it).
    Derived from the members' acknowledged positions — never assumed."""
    others = chat.members.filter(state="active").exclude(user_id=msg.sender_id).values_list("delivered_seq", "read_seq")
    if not others:
        return "sent"
    if all(r >= msg.seq for _, r in others):
        return "read"
    if all(d >= msg.seq for d, _ in others):
        return "delivered"
    return "sent"


def post_message(user, chat: Chat, *, text: str = "", attachment: Attachment | None = None, reply_to=None,
                 client_id: str = "", forwarded: bool = False, kind: str = "text", sender=None) -> tuple[ChatMessage, bool]:
    """Append a message with the next per-chat seq (row lock). Returns (message, created). A retried send with the
    same client_id returns the original message instead of a duplicate."""
    sender = user if sender is None else sender
    if client_id:
        prev = ChatMessage.objects.filter(chat=chat, sender=sender, client_id=client_id).first()
        if prev:
            return prev, False
    try:
        with transaction.atomic():
            c = Chat.objects.select_for_update().get(pk=chat.pk)
            c.last_seq += 1
            c.last_message_at = timezone.now()
            c.save(update_fields=["last_seq", "last_message_at"])
            msg = ChatMessage.objects.create(chat=c, sender=sender, seq=c.last_seq, client_id=client_id[:64], kind=kind,
                                             text=text, attachment=attachment, reply_to=reply_to, forwarded=forwarded)
            if sender is not None:
                ChatMember.objects.filter(chat=c, user=sender).update(read_seq=c.last_seq, delivered_seq=c.last_seq)
    except IntegrityError:  # a concurrent retry with the same client_id won the race
        return ChatMessage.objects.get(chat=chat, sender=sender, client_id=client_id), False
    chat.last_seq = msg.seq
    # a reply un-archives the chat for everyone, like other messengers
    ChatMember.objects.filter(chat=chat, archived=True).update(archived=False)
    for uid in active_member_ids(chat):
        viewer = User(id=uid)
        broadcast(uid, {"kind": "msg.new", "event_id": uuid.uuid4().hex, "chat_id": str(chat.id), "seq": msg.seq,
                        "ts": msg.created_at.isoformat(), "message": message_dict(viewer, msg, chat)})
    return msg, True


def mark(user, m: ChatMember, *, delivered: int | None = None, read: int | None = None) -> None:
    """Acknowledge delivery/read up to a seq; tells the senders so their ticks update."""
    chat = m.chat
    upd = {}
    if delivered is not None and delivered > m.delivered_seq:
        upd["delivered_seq"] = min(delivered, chat.last_seq)
    if read is not None and read > m.read_seq:
        upd["read_seq"] = min(read, chat.last_seq)
        upd["delivered_seq"] = max(upd.get("delivered_seq", m.delivered_seq), upd["read_seq"])
    if not upd:
        return
    ChatMember.objects.filter(pk=m.pk).update(**upd)
    fanout(chat, {"kind": "msg.receipt", "user_id": user.id, **{k.replace("_seq", ""): v for k, v in upd.items()}},
           [u for u in active_member_ids(chat) if u != user.id])


def can_edit(user, msg: ChatMessage) -> bool:
    return (msg.sender_id == user.id and msg.kind == "text" and msg.deleted_at is None
            and (timezone.now() - msg.created_at).total_seconds() <= EDIT_WINDOW_SECONDS)


def message_changed(chat: Chat, msg: ChatMessage) -> None:
    for uid in active_member_ids(chat):
        broadcast(uid, {"kind": "msg.update", "event_id": uuid.uuid4().hex, "chat_id": str(chat.id), "seq": msg.seq,
                        "message": message_dict(User(id=uid), msg, chat)})


def react(user, msg: ChatMessage, emoji: str) -> None:
    if not emoji:
        Reaction.objects.filter(message=msg, user=user).delete()
    else:
        Reaction.objects.update_or_create(message=msg, user=user, defaults={"emoji": emoji[:16]})
    message_changed(msg.chat, msg)


def system_message(chat: Chat, text: str, actor=None) -> ChatMessage:
    return post_message(actor, chat, text=text, kind="system", sender=actor)[0]


# ------------------------------------------------------------------------------------------------- attachments
def attachments_dir() -> Path:
    d = get_settings().media_root / "messenger"
    d.mkdir(parents=True, exist_ok=True)
    return d


def kind_for(mime: str, name: str, voice: bool = False) -> str:
    if voice:
        return "voice"
    if mime == "application/pdf" or name.lower().endswith(".pdf"):
        return "pdf"
    top = mime.split("/")[0]
    if top in ("image", "video", "audio"):
        return top
    if any(name.lower().endswith(e) for e in (".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".md", ".rtf", ".odt")):
        return "document"
    return "other"


def store_upload(user, f, *, voice: bool = False, duration: float | None = None) -> Attachment:
    s = get_settings()
    name = Path(f.name or "file").name[:255]
    ext = Path(name).suffix.lower()
    if ext in BLOCKED_EXT:
        raise Forbidden(f"{ext} files can't be shared.")
    if f.size > s.messenger_max_upload_bytes:
        raise Forbidden(f"Files up to {s.messenger_max_upload_bytes // (1024 * 1024)} MB can be shared.")
    used = Attachment.objects.filter(uploader=user).aggregate(t=Sum("size"))["t"] or 0
    if used + f.size > s.messenger_quota_bytes:
        raise Forbidden("Your storage quota for shared files is full. Delete some chats or files first.")
    mime = (f.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream").split(";")[0]
    if mime in ("text/html", "image/svg+xml", "application/javascript", "text/javascript"):
        mime = "application/octet-stream"  # never served as active content
    h = hashlib.sha256()
    tmp = attachments_dir() / f".tmp-{uuid.uuid4().hex}"
    with open(tmp, "wb") as out:
        for c in f.chunks():
            h.update(c)
            out.write(c)
    digest = h.hexdigest()
    dest = attachments_dir() / digest[:2] / digest
    dest.parent.mkdir(exist_ok=True)
    if dest.exists():  # the same bytes are stored once
        tmp.unlink()
    else:
        tmp.replace(dest)
    return Attachment.objects.create(uploader=user, sha256=digest, path=str(dest), name=name, mime=mime, size=f.size,
                                     kind=kind_for(mime, name, voice), duration=duration)


def attachment_for(user, attachment_id) -> Attachment:
    """The attachment if the user uploaded it, or it's in a message (not deleted) of a chat they're a member of
    (from when they joined), or it's the avatar of a group/person they can see."""
    a = Attachment.objects.filter(pk=attachment_id).first()
    if not a:
        raise Http404
    if a.uploader_id == user.id:
        return a
    for m in ChatMember.objects.filter(user=user, state__in=["active", "request"]):
        if ChatMessage.objects.filter(chat_id=m.chat_id, attachment=a, deleted_at__isnull=True, seq__gt=m.joined_seq).exists():
            return a
        if m.chat.avatar == str(a.id):
            return a
    if PhoneIdentity.objects.filter(avatar=str(a.id)).exists() or Contact.objects.filter(owner=user, avatar=str(a.id)).exists():
        return a
    raise Http404


def touch_last_seen(user) -> None:
    PhoneIdentity.objects.filter(user=user).update(last_seen=timezone.now())

