import uuid

from django.db import models


class EmailOTP(models.Model):
    """One email verification attempt. Only an HMAC of the code is stored; codes expire, are single-use and allow a
    limited number of tries (apps/authentication/email_otp.py)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(db_index=True)
    purpose = models.CharField(max_length=12)  # setup
    code_hash = models.CharField(max_length=128)
    attempts = models.PositiveSmallIntegerField(default=0)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
