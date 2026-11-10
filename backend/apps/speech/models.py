import uuid

from django.conf import settings
from django.db import models


class VoiceSample(models.Model):
    """One enrollment recording: the user reading a known sentence. Used to measure how well Aura understands the
    user's accent/dialect, as a language prior, and as a (audio, text) pair for fine-tuning speech recognition."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="voice_samples")
    language = models.CharField(max_length=8)
    prompt_index = models.PositiveIntegerField()
    text = models.TextField()
    audio_file = models.CharField(max_length=500)
    heard = models.TextField(blank=True, default="")
    accuracy = models.FloatField(null=True)  # 1 - character error rate
    seconds = models.FloatField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        unique_together = [("user", "language", "prompt_index")]


class FreeTalkSession(models.Model):
    """Up to ~5 minutes of the user talking freely, in any mix of languages. Split at pauses into segments; each segment
    gets its own language detection + transcript, which the user can confirm or correct. Confirmed segments become
    (audio, exact text) training pairs and teach Aura the user's vocabulary and recurring recognition mistakes."""
    STATUS = [("queued", "queued"), ("processing", "processing"), ("done", "done"), ("failed", "failed")]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="free_talk_sessions")
    audio_file = models.CharField(max_length=500)
    seconds = models.FloatField(default=0)
    status = models.CharField(max_length=12, choices=STATUS, default="queued")
    total_segments = models.PositiveIntegerField(default=0)
    error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class FreeTalkSegment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(FreeTalkSession, on_delete=models.CASCADE, related_name="segments")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="free_talk_segments")
    index = models.PositiveIntegerField()
    start = models.FloatField()
    end = models.FloatField()
    audio_file = models.CharField(max_length=500)
    language = models.CharField(max_length=8, blank=True, default="")
    language_probability = models.FloatField(null=True)
    language_uncertain = models.BooleanField(default=False)
    heard = models.TextField(blank=True, default="")  # what Aura transcribed, never overwritten
    confidence = models.FloatField(null=True)
    engine = models.CharField(max_length=80, blank=True, default="")
    corrected = models.TextField(blank=True, default="")  # what the user says they actually said
    verified = models.BooleanField(default=False)
    accuracy = models.FloatField(null=True)  # 1 − CER of `heard` against `corrected`, once verified

    class Meta:
        ordering = ["session", "index"]
        unique_together = [("session", "index")]
