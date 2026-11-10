import uuid

from django.conf import settings
from django.db import models

from apps.core.models import TimeStamped


class Document(TimeStamped):
    class Status(models.TextChoices):
        PENDING = "pending"
        PROCESSING = "processing"
        INDEXED = "indexed"
        FAILED = "failed"

    class Source(models.TextChoices):
        LOCAL_AGENT = "local_agent"
        UPLOAD = "upload"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="documents")
    filename = models.CharField(max_length=512)
    file_type = models.CharField(max_length=16, default="pdf")
    source = models.CharField(max_length=16, choices=Source.choices)
    source_path = models.CharField(max_length=2048, blank=True)  # path on the Mac (display only, never trusted)
    source_directory = models.CharField(max_length=256, blank=True)
    content_hash = models.CharField(max_length=64, db_index=True)
    size_bytes = models.BigIntegerField(default=0)
    stored_file = models.CharField(max_length=512)  # relative to MEDIA root; the original on the Mac is never touched
    page_count = models.PositiveIntegerField(default=0)
    chunk_count = models.PositiveIntegerField(default=0)
    loader = models.CharField(max_length=64, blank=True)
    loader_reason = models.CharField(max_length=500, blank=True)
    inspection = models.JSONField(default=dict, blank=True)
    chunking_config = models.JSONField(default=dict, blank=True)
    embedding_model = models.CharField(max_length=128, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING, db_index=True)
    embedding_status = models.CharField(max_length=16, default="pending")
    index_status = models.CharField(max_length=16, default="pending")
    error = models.TextField(blank=True)
    indexed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["user", "content_hash"], name="uniq_user_document_hash")]


class Chunk(models.Model):
    id = models.CharField(primary_key=True, max_length=80)  # "<document_id>:<index>" (deterministic → idempotent upserts)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="chunks")
    index = models.PositiveIntegerField()
    page_number = models.PositiveIntegerField()
    page_end = models.PositiveIntegerField()
    text = models.TextField()
    kind = models.CharField(max_length=16, default="text")  # text | table | ocr
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["document", "index"]
        indexes = [models.Index(fields=["document", "index"])]
