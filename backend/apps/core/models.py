import uuid

from django.conf import settings
from django.db import models


class TimeStamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class AuditLog(models.Model):
    """Append-only record of security-relevant operations (auth, file access, memory changes)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    action = models.CharField(max_length=64, db_index=True)
    target = models.CharField(max_length=512, blank=True)
    details = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]


def audit(user, action: str, target: str = "", **details) -> None:
    AuditLog.objects.create(user=user if getattr(user, "is_authenticated", False) else None,
                            action=action, target=target[:512], details=details)
