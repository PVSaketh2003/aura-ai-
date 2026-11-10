"""Aura Messenger: verified phone identities, saved contacts, direct + group chats, messages, attachments, calls.

Authorisation is membership-based and enforced in the backend: every query for chats, messages, attachments and calls
goes through `ChatMember` for the requesting user (see services.py → member_or_404)."""
import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q

User = settings.AUTH_USER_MODEL


class PhoneIdentity(models.Model):
    """A user's VERIFIED phone number (E.164). Only created after a successful OTP check."""
    WHO = [("everyone", "everyone"), ("contacts", "contacts")]
    user = models.OneToOneField(User, on_delete=models.CASCADE, primary_key=True, related_name="phone")
    phone = models.CharField(max_length=20, unique=True)
    verified_at = models.DateTimeField()
    about = models.CharField(max_length=140, blank=True, default="")
    avatar = models.CharField(max_length=500, blank=True, default="")  # attachment id of the profile photo
    discoverable = models.BooleanField(default=True)  # can be found by exact phone-number lookup
    who_can_message = models.CharField(max_length=10, choices=WHO, default="everyone")
    show_last_seen = models.BooleanField(default=True)
    last_seen = models.DateTimeField(null=True, blank=True)


class PhoneOTP(models.Model):
    """One verification attempt. Only a salted hash of the code is stored (dev backend); with Twilio Verify the code
    never reaches Aura at all. Codes expire and allow a limited number of attempts."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    phone = models.CharField(max_length=20, db_index=True)
    purpose = models.CharField(max_length=12)  # register | login | link
    code_hash = models.CharField(max_length=128, blank=True, default="")
    provider = models.CharField(max_length=16)
    attempts = models.PositiveSmallIntegerField(default=0)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)


class Contact(models.Model):
    """A phone number the user saved. May or may not belong to a registered Aura user (resolved at read time from
    verified PhoneIdentity rows, never assumed)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name="contacts")
    name = models.CharField(max_length=80)
    phone = models.CharField(max_length=20)
    description = models.CharField(max_length=200, blank=True, default="")
    avatar = models.CharField(max_length=64, blank=True, default="")  # attachment id
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint(fields=["owner", "phone"], name="contact_unique_per_owner")]


class Block(models.Model):
    blocker = models.ForeignKey(User, on_delete=models.CASCADE, related_name="blocks")
    blocked = models.ForeignKey(User, on_delete=models.CASCADE, related_name="blocked_by")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["blocker", "blocked"], name="block_unique")]


class Report(models.Model):
    reporter = models.ForeignKey(User, on_delete=models.CASCADE, related_name="reports_made")
    reported = models.ForeignKey(User, on_delete=models.CASCADE, related_name="reports_received")
    reason = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)


class Chat(models.Model):
    KIND = [("direct", "direct"), ("group", "group")]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    kind = models.CharField(max_length=8, choices=KIND)
    direct_key = models.CharField(max_length=64, null=True, blank=True, unique=True)  # "<min id>:<max id>"
    name = models.CharField(max_length=80, blank=True, default="")
    description = models.CharField(max_length=500, blank=True, default="")
    avatar = models.CharField(max_length=64, blank=True, default="")  # attachment id
    created_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    last_seq = models.BigIntegerField(default=0)
    last_message_at = models.DateTimeField(null=True, blank=True, db_index=True)


class ChatMember(models.Model):
    ROLE = [("owner", "owner"), ("admin", "admin"), ("member", "member")]
    STATE = [("active", "active"), ("request", "request"), ("left", "left"), ("removed", "removed")]
    chat = models.ForeignKey(Chat, on_delete=models.CASCADE, related_name="members")
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="chat_memberships")
    role = models.CharField(max_length=8, choices=ROLE, default="member")
    # "request": a direct chat started by someone the user hasn't saved — shown as a message request
    state = models.CharField(max_length=8, choices=STATE, default="active")
    joined_seq = models.BigIntegerField(default=0)  # members never see messages from before they joined
    delivered_seq = models.BigIntegerField(default=0)
    read_seq = models.BigIntegerField(default=0)
    muted = models.BooleanField(default=False)
    archived = models.BooleanField(default=False)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["chat", "user"], name="member_unique")]
        indexes = [models.Index(fields=["user", "state"])]


class Attachment(models.Model):
    """Content-addressed file (one physical copy per SHA-256), served only to the uploader and members of chats that
    contain a message referencing it."""
    KIND = [("image", "image"), ("video", "video"), ("audio", "audio"), ("voice", "voice"), ("pdf", "pdf"),
            ("document", "document"), ("other", "other")]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    uploader = models.ForeignKey(User, on_delete=models.CASCADE, related_name="attachments")
    sha256 = models.CharField(max_length=64, db_index=True)
    path = models.CharField(max_length=500)
    name = models.CharField(max_length=255)
    mime = models.CharField(max_length=100)
    size = models.BigIntegerField()
    kind = models.CharField(max_length=10, choices=KIND)
    duration = models.FloatField(null=True, blank=True)  # voice notes
    created_at = models.DateTimeField(auto_now_add=True)


class ChatMessage(models.Model):
    KIND = [("text", "text"), ("system", "system"), ("call", "call"), ("ai", "ai")]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    chat = models.ForeignKey(Chat, on_delete=models.CASCADE, related_name="messages")
    sender = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, related_name="+")
    seq = models.BigIntegerField()  # per-chat order, assigned under a row lock
    client_id = models.CharField(max_length=64, blank=True, default="")  # sender-side id: retries never duplicate
    kind = models.CharField(max_length=8, choices=KIND, default="text")
    text = models.TextField(blank=True, default="")
    attachment = models.ForeignKey(Attachment, on_delete=models.SET_NULL, null=True, blank=True, related_name="messages")
    reply_to = models.ForeignKey("self", on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    forwarded = models.BooleanField(default=False)
    pinned = models.BooleanField(default=False)
    edited_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)  # "deleted for everyone": text and file removed
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["seq"]
        constraints = [
            models.UniqueConstraint(fields=["chat", "seq"], name="message_seq_unique"),
            models.UniqueConstraint(fields=["chat", "sender", "client_id"], condition=~Q(client_id=""),
                                    name="message_client_id_unique"),
        ]


class Reaction(models.Model):
    message = models.ForeignKey(ChatMessage, on_delete=models.CASCADE, related_name="reactions")
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="+")
    emoji = models.CharField(max_length=16)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["message", "user"], name="reaction_one_per_user")]


class CallSession(models.Model):
    STATE = [("ringing", "ringing"), ("active", "active"), ("ended", "ended"), ("missed", "missed"),
             ("declined", "declined"), ("failed", "failed")]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    chat = models.ForeignKey(Chat, on_delete=models.CASCADE, related_name="calls")
    caller = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, related_name="+")
    video = models.BooleanField(default=False)
    state = models.CharField(max_length=10, choices=STATE, default="ringing")
    created_at = models.DateTimeField(auto_now_add=True)
    answered_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
