"""Email one-time codes, sent from the configured address (EMAIL_FROM, e.g. pvsaketh1@gmail.com).

Delivery (EMAIL_PROVIDER):
  * "smtp"  — any SMTP server; for Gmail: SMTP_USER = the Gmail address, SMTP_PASSWORD = a Google *App Password*
              (Google Account → Security → 2-Step Verification → App passwords). Never the normal Gmail password.
  * "brevo" — Brevo's HTTPS email API (BREVO_API_KEY), for hosts that block outgoing SMTP ports.
  * "gmail_api" — Gmail's official API over HTTPS, sending as the authorised Gmail account itself (pvsaketh1@gmail.com).
              Works where SMTP is blocked (e.g. Render's free plan). Set up once with scripts/gmail_authorize.py.
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
           (s.email_provider == "brevo" and bool(s.brevo_api_key)) or \
           (s.email_provider == "gmail_api" and bool(s.gmail_client_id and s.gmail_client_secret and s.gmail_refresh_token))


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


_gmail_token: dict = {}


def _gmail_access_token() -> str:
    """Short-lived access token from the long-lived refresh token (cached until shortly before it expires)."""
    import time

    import httpx
    if _gmail_token.get("exp", 0) > time.time() + 60:
        return _gmail_token["value"]
    s = get_settings()
    r = httpx.post("https://oauth2.googleapis.com/token", timeout=15, data={
        "client_id": s.gmail_client_id, "client_secret": s.gmail_client_secret,
        "refresh_token": s.gmail_refresh_token, "grant_type": "refresh_token"})
    if r.status_code >= 300:
        raise EmailOTPError("Gmail authorisation failed. Run scripts/gmail_authorize.py again (the approval may have been revoked).")
    d = r.json()
    _gmail_token.update(value=d["access_token"], exp=time.time() + int(d.get("expires_in", 3600)))
    return _gmail_token["value"]


def _gmail_send(to: str, subject: str, text: str) -> None:
    import base64
    from email.message import EmailMessage

    import httpx
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = get_settings().email_from, to, subject
    msg.set_content(text)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    r = httpx.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", timeout=20,
                   headers={"Authorization": f"Bearer {_gmail_access_token()}"}, json={"raw": raw})
    if r.status_code == 401:
        _gmail_token.clear()
    if r.status_code >= 300:
        raise EmailOTPError(f"Gmail refused the message (HTTP {r.status_code}).")


def _deliver(to: str, subject: str, text: str) -> None:
    s = get_settings()
    if s.email_provider == "gmail_api":
        return _gmail_send(to, subject, text)
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
        if isinstance(e, (TimeoutError, ConnectionError, OSError)) and get_settings().email_provider == "smtp" \
                and not hasattr(e, "smtp_code"):
            raise EmailOTPError("Couldn't reach the email server. This host may block outgoing email ports; "
                                "switch EMAIL_PROVIDER to an HTTPS email API.") from e
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
