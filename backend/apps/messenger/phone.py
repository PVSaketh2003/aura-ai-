"""Phone numbers (E.164) and one-time verification codes.

SMS delivery is pluggable via SMS_BACKEND in backend/.env:
  * "twilio"  — Twilio Verify (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID). Twilio generates,
                sends and checks the code; Aura never sees it.
  * "dev"     — LOCAL TESTING ONLY, refused unless DJANGO_DEBUG=true. The code is written to
                backend/data/dev_sms_outbox/<number>.txt on this Mac (never to logs, never in an API response).
  * unset     — phone verification is unavailable and the API says so.

Abuse limits: 3 codes per number per 15 min, 10 per IP per hour, 5 wrong attempts per code, 10-minute expiry.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from datetime import timedelta

import phonenumbers
from django.conf import settings
from django.utils import timezone

from config.env import get_settings

from .models import PhoneOTP

log = logging.getLogger(__name__)
CODE_TTL = timedelta(minutes=10)
MAX_ATTEMPTS = 5
PER_NUMBER = (3, timedelta(minutes=15))
PER_IP = (10, timedelta(hours=1))


class PhoneError(ValueError):
    pass


def normalize(raw: str, country: str = "") -> str:
    """'+91 98765 43210' / ('9876543210', '+91') → '+919876543210'. Raises PhoneError if not a valid number."""
    raw = (raw or "").strip()
    cc = (country or "").strip().lstrip("+")
    if cc and not raw.startswith("+"):
        raw = f"+{cc}{raw}"
    try:
        n = phonenumbers.parse(raw, None)
    except phonenumbers.NumberParseException as e:
        raise PhoneError("Enter the number with its country code, e.g. +91 98765 43210.") from e
    if not phonenumbers.is_valid_number(n):
        raise PhoneError("That isn't a valid phone number.")
    return phonenumbers.format_number(n, phonenumbers.PhoneNumberFormat.E164)


def pretty(e164: str) -> str:
    try:
        return phonenumbers.format_number(phonenumbers.parse(e164, None), phonenumbers.PhoneNumberFormat.INTERNATIONAL)
    except Exception:
        return e164


def backend() -> str:
    b = get_settings().sms_backend.strip().lower()
    if b == "dev" and not settings.DEBUG:
        return ""  # the dev outbox must never run in production
    return b if b in ("twilio", "dev") else ""


def _env(name: str) -> str:
    return getattr(get_settings(), name.lower())


def _hash(phone: str, code: str) -> str:
    return hmac.new(settings.SECRET_KEY.encode(), f"{phone}:{code}".encode(), hashlib.sha256).hexdigest()


def _outbox():
    from config.env import BASE_DIR
    d = BASE_DIR / "data" / "dev_sms_outbox"
    d.mkdir(parents=True, exist_ok=True)
    return d


def send_code(phone: str, purpose: str, ip: str | None) -> None:
    b = backend()
    if not b:
        raise PhoneError("Phone verification isn't configured on this server (set SMS_BACKEND, see README → Messenger).")
    now = timezone.now()
    if PhoneOTP.objects.filter(phone=phone, created_at__gte=now - PER_NUMBER[1]).count() >= PER_NUMBER[0]:
        raise PhoneError("Too many codes sent to this number. Try again in a few minutes.")
    if ip and PhoneOTP.objects.filter(ip=ip, created_at__gte=now - PER_IP[1]).count() >= PER_IP[0]:
        raise PhoneError("Too many verification requests. Try again later.")
    otp = PhoneOTP(phone=phone, purpose=purpose, provider=b, expires_at=now + CODE_TTL, ip=ip)
    if b == "dev":
        code = f"{secrets.randbelow(10 ** 6):06d}"
        otp.code_hash = _hash(phone, code)
        (_outbox() / f"{phone.lstrip('+')}.txt").write_text(f"Aura verification code for {phone}: {code}\n")
    else:
        import requests
        r = requests.post(f"https://verify.twilio.com/v2/Services/{_env('TWILIO_VERIFY_SERVICE_SID')}/Verifications",
                          data={"To": phone, "Channel": "sms"},
                          auth=(_env("TWILIO_ACCOUNT_SID"), _env("TWILIO_AUTH_TOKEN")), timeout=15)
        if r.status_code >= 300:
            log.warning("Twilio Verify send failed: HTTP %s", r.status_code)  # never log the body (may echo data)
            raise PhoneError("Couldn't send the SMS right now.")
    otp.save()


def check_code(phone: str, code: str, purpose: str) -> bool:
    """True once for a correct, unexpired, unconsumed code. Wrong codes count towards the attempt limit."""
    code = (code or "").strip()
    otp = (PhoneOTP.objects.filter(phone=phone, purpose=purpose, consumed_at__isnull=True, expires_at__gt=timezone.now())
           .order_by("-created_at").first())
    if not otp or otp.attempts >= MAX_ATTEMPTS or not code.isdigit() or len(code) > 10:
        if otp:
            otp.attempts += 1
            otp.save(update_fields=["attempts"])
        return False
    if otp.provider == "dev":
        ok = hmac.compare_digest(otp.code_hash, _hash(phone, code))
    else:
        import requests
        r = requests.post(f"https://verify.twilio.com/v2/Services/{_env('TWILIO_VERIFY_SERVICE_SID')}/VerificationCheck",
                          data={"To": phone, "Code": code},
                          auth=(_env("TWILIO_ACCOUNT_SID"), _env("TWILIO_AUTH_TOKEN")), timeout=15)
        ok = r.status_code < 300 and r.json().get("status") == "approved"
    if ok:
        otp.consumed_at = timezone.now()
        otp.save(update_fields=["consumed_at"])
        if otp.provider == "dev":
            (_outbox() / f"{phone.lstrip('+')}.txt").unlink(missing_ok=True)
    else:
        otp.attempts += 1
        otp.save(update_fields=["attempts"])
    return ok
