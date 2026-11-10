import hashlib
import uuid

from django.conf import settings
from django.contrib.postgres.indexes import GinIndex
from django.db import models

from apps.core.models import TimeStamped


class Memory(TimeStamped):
    class Category(models.TextChoices):
        PREFERENCE = "personal_preference", "Personal preference"
        PROJECT = "project", "Project"
        TECHNICAL = "technical", "Technical information"
        INSTRUCTION = "instruction", "Important instruction"
        GOAL = "goal", "Long-term goal"
        FACT = "fact", "User-provided fact"
        OTHER = "other", "Other"

    class Status(models.TextChoices):
        ACTIVE = "active"
        ARCHIVED = "archived"

    class VectorStatus(models.TextChoices):
        PENDING = "pending"
        SYNCED = "synced"
        FAILED = "failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="memories")
    content = models.TextField()
    category = models.CharField(max_length=32, choices=Category.choices, default=Category.OTHER, db_index=True)
    tags = models.JSONField(default=list, blank=True)
    language = models.CharField(max_length=8, default="en")
    source_conversation = models.ForeignKey("conversations.Conversation", null=True, blank=True, on_delete=models.SET_NULL)
    source_message = models.ForeignKey("conversations.Message", null=True, blank=True, on_delete=models.SET_NULL)
    original_text = models.TextField(blank=True)  # what the user actually said
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE, db_index=True)
    vector_status = models.CharField(max_length=16, choices=VectorStatus.choices, default=VectorStatus.PENDING, db_index=True)
    vector_error = models.TextField(blank=True)
    vector_synced_at = models.DateTimeField(null=True, blank=True)
    content_hash = models.CharField(max_length=64, db_index=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "status", "-created_at"]), GinIndex(fields=["tags"], name="memory_tags_gin")]

    def save(self, *a, **kw):
        self.content_hash = hashlib.sha256(" ".join(self.content.lower().split()).encode()).hexdigest()
        super().save(*a, **kw)
