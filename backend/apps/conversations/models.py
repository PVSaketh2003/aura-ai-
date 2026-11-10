import uuid

from django.conf import settings
from django.db import models

from apps.core.models import TimeStamped


class Conversation(TimeStamped):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="conversations")
    title = models.CharField(max_length=200, blank=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [models.Index(fields=["user", "-updated_at"])]


class Message(models.Model):
    class Role(models.TextChoices):
        USER = "user"
        ASSISTANT = "assistant"

    class Modality(models.TextChoices):
        TEXT = "text"
        VOICE = "voice"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="messages")
    role = models.CharField(max_length=16, choices=Role.choices)
    content = models.TextField()
    modality = models.CharField(max_length=8, choices=Modality.choices, default=Modality.TEXT)
    language = models.CharField(max_length=16, blank=True)
    execution = models.ForeignKey("execution_traces.ExecutionRun", null=True, blank=True,
                                  on_delete=models.SET_NULL, related_name="messages")
    # Structured response payload (validated AgentResponse) for assistant messages.
    payload = models.JSONField(default=dict, blank=True)
    referenced_documents = models.JSONField(default=list, blank=True)
    referenced_memories = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["conversation", "created_at"])]


class MessageFeedback(models.Model):
    """Explicit user feedback. Only rows with consent=True may be used for fine-tuning."""
    message = models.OneToOneField(Message, on_delete=models.CASCADE, related_name="feedback")
    rating = models.SmallIntegerField(choices=[(1, "up"), (-1, "down")])
    correction = models.TextField(blank=True)
    consent = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
