import uuid

from django.conf import settings
from django.db import models


class Status(models.TextChoices):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class ExecutionRun(models.Model):
    """One agent execution. Every step shown in the UI is a persisted ExecutionStep row."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="executions")
    conversation = models.ForeignKey("conversations.Conversation", null=True, on_delete=models.CASCADE,
                                     related_name="executions")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING, db_index=True)
    intent = models.CharField(max_length=32, blank=True)
    input_text = models.TextField(blank=True)
    error = models.TextField(blank=True)
    started_at = models.DateTimeField(auto_now_add=True, db_index=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    duration_ms = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        ordering = ["-started_at"]


class ExecutionStep(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    run = models.ForeignKey(ExecutionRun, on_delete=models.CASCADE, related_name="steps")
    seq = models.PositiveIntegerField()
    key = models.CharField(max_length=64)  # node identifier, e.g. "llm_generation"
    name = models.CharField(max_length=128)  # human label
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.RUNNING)
    summary = models.CharField(max_length=500, blank=True)
    detail = models.JSONField(default=dict, blank=True)
    error = models.TextField(blank=True)
    started_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    duration_ms = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        ordering = ["seq"]
        unique_together = [("run", "seq")]
