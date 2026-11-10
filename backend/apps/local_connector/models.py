import hashlib
import secrets
import uuid

from django.conf import settings
from django.db import models


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class LocalAgentDevice(models.Model):
    """A paired Mac. Only the SHA-256 of the device token is stored."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="local_agents")
    name = models.CharField(max_length=128)
    token_hash = models.CharField(max_length=64, unique=True)
    hostname = models.CharField(max_length=255, blank=True)
    agent_version = models.CharField(max_length=32, blank=True)
    roots = models.JSONField(default=list, blank=True)  # as reported by the agent (the agent enforces them)
    disabled_roots = models.JSONField(default=list, blank=True)  # roots the user switched off in Settings
    last_seen = models.DateTimeField(null=True, blank=True)
    revoked = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    @classmethod
    def pair(cls, user, name: str) -> tuple["LocalAgentDevice", str]:
        token = "aura_la_" + secrets.token_urlsafe(32)
        return cls.objects.create(user=user, name=name, token_hash=hash_token(token)), token

    @classmethod
    def authenticate(cls, token: str) -> "LocalAgentDevice | None":
        if not token or not token.startswith("aura_la_"):
            return None
        return cls.objects.select_related("user").filter(token_hash=hash_token(token), revoked=False).first()
