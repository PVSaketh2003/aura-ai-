"""Email one-time codes, sent from the configured address (EMAIL_FROM, e.g. pvsaketh1@gmail.com).

Delivery (EMAIL_PROVIDER):
  * "smtp"  — any SMTP server; for Gmail: SMTP_USER = the Gmail address, SMTP_PASSWORD = a Google *App Password*
              (Google Account → Security → 2-Step Verification → App passwords). Never the normal Gmail password.
  * "brevo" — Brevo's HTTPS email API (BREVO_API_KEY), for hosts that block outgoing SMTP ports.
Limits: 3 codes per address per 15 min, 10 per IP per hour, 5 wrong tries per code, 10-minute expiry, single use.
Codes are never logged and never returned by the API; only an HMAC is stored.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from config.env import get_settings

from .models import EmailOTP

log = logging.getLogger(__name__)
TTL = timedelta(minutes=10)
MAX_ATTEMPTS = 5
PER_EMAIL = (3, timedelta(minutes=15))
PER_IP = (10, timedelta(hours=1))


class EmailOTPError(ValueError):
    pass


def enabled() -> bool:
    s = get_settings()
    return (s.email_provider == "smtp" and bool(s.smtp_user and s.smtp_password)) or \
           (s.email_provider == "brevo" and bool(s.brevo_api_key))


def normalize(email: str) -> str:
    e = (email or "").strip().lower()
    if "@" not in e or "." not in e.split("@")[-1] or len(e) > 254:
        raise EmailOTPError("Enter a valid email address.")
    return e


def owner_allowed(email: str) -> bool:
    allowed = [x.strip().lower() for x in get_settings().owner_emails if x.strip()]
    return not allowed or email in allowed


def _hash(email: str, code: str) -> str:
    return hmac.new(settings.SECRET_KEY.encode(), f"email:{email}:{code}".encode(), hashlib.sha256).hexdigest()


def _deliver(to: str, subject: str, text: str) -> None:
    s = get_settings()
    if s.email_provider == "brevo":
        import httpx
        name, _, addr = s.email_from.rpartition("<")
        sender = {"email": addr.rstrip(">").strip() or s.email_from, "name": name.strip() or "Aura"}
        r = httpx.post("https://api.brevo.com/v3/smtp/email", timeout=15,
                       headers={"api-key": s.brevo_api_key, "accept": "application/json"},
                       json={"sender": sender, "to": [{"email": to}], "subject": subject, "textContent": text})
        if r.status_code >= 300:
            raise EmailOTPError(f"The email service refused the message (HTTP {r.status_code}).")
        return
    from django.core.mail import get_connection, send_mail
    conn = get_connection("django.core.mail.backends.smtp.EmailBackend", host=s.smtp_host, port=s.smtp_port,
                          username=s.smtp_user, password=s.smtp_password, use_tls=s.smtp_port == 587,
                          use_ssl=s.smtp_port == 465, timeout=15)
    send_mail(subject, text, s.email_from, [to], connection=conn)


def send_code(email: str, purpose: str, ip: str | None) -> None:
    if not enabled():
        raise EmailOTPError("Email verification isn't configured on this server.")
    now = timezone.now()
    if EmailOTP.objects.filter(email=email, created_at__gte=now - PER_EMAIL[1]).count() >= PER_EMAIL[0]:
        raise EmailOTPError("Too many codes were sent to this email. Try again in a few minutes.")
    if ip and EmailOTP.objects.filter(ip=ip, created_at__gte=now - PER_IP[1]).count() >= PER_IP[0]:
        raise EmailOTPError("Too many verification requests. Try again later.")
    code = f"{secrets.randbelow(10 ** 6):06d}"
    text = (f"Your Aura verification code is {code}\n\n"
            "It expires in 10 minutes. If you didn't try to create an Aura account, you can ignore this email.")
    try:
        _deliver(email, f"{code} is your Aura verification code", text)
    except EmailOTPError:
        raise
    except Exception as e:  # noqa: BLE001 — never include the code or credentials in logs
        log.warning("email delivery failed: %s", type(e).__name__)
        raise EmailOTPError("Couldn't send the email right now. Please try again in a minute.") from e
    EmailOTP.objects.create(email=email, purpose=purpose, code_hash=_hash(email, code), expires_at=now + TTL, ip=ip)


def check_code(email: str, code: str, purpose: str) -> bool:
    code = (code or "").strip()
    otp = (EmailOTP.objects.filter(email=email, purpose=purpose, consumed_at__isnull=True, expires_at__gt=timezone.now())
           .order_by("-created_at").first())
    if not otp:
        return False
    if otp.attempts >= MAX_ATTEMPTS or not code.isdigit() or len(code) != 6 or \
            not hmac.compare_digest(otp.code_hash, _hash(email, code)):
        otp.attempts += 1
        otp.save(update_fields=["attempts"])
        return False
    otp.consumed_at = timezone.now()
    otp.save(update_fields=["consumed_at"])
    return True
