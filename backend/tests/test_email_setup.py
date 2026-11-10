"""Owner sign-up on a fresh server with an emailed one-time code (sent from EMAIL_FROM, e.g. pvsaketh1@gmail.com).
Real views, CSRF and database; only the outgoing email is captured instead of delivered."""
import re

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from django.utils import timezone

from apps.authentication import email_otp
from apps.authentication.models import EmailOTP
from config.env import get_settings

pytestmark = pytest.mark.django_db
OWNER = "pvsaketh1@gmail.com"


@pytest.fixture
def mail(monkeypatch):
    s = get_settings()
    for k, v in {"email_provider": "smtp", "smtp_user": OWNER, "smtp_password": "app-password", "owner_emails": [OWNER],
                 "setup_code": ""}.items():
        monkeypatch.setattr(s, k, v)
    from django.core.cache import cache
    cache.clear()
    outbox = []
    monkeypatch.setattr(email_otp, "_deliver", lambda to, subject, text: outbox.append((to, subject, text)))
    return outbox


def _client():
    c = Client(enforce_csrf_checks=True)
    c.get("/api/auth/session/")
    return c, {"HTTP_X_CSRFTOKEN": c.cookies["csrftoken"].value}


def code_in(outbox):
    return re.search(r"code is (\d{6})", outbox[-1][2]).group(1)


def test_owner_signs_up_with_an_emailed_code(mail):
    c, h = _client()
    assert c.get("/api/auth/session/").json()["setup_verification"] == "email"
    r = c.post("/api/auth/email-code/", {"email": " PVSaketh1@gmail.com ", "purpose": "setup"}, content_type="application/json", **h)
    assert r.status_code == 200 and "code" not in r.json() and mail[-1][0] == OWNER
    assert code_in(mail) not in EmailOTP.objects.get().code_hash  # only an HMAC is stored
    bad = c.post("/api/auth/setup/", {"username": OWNER, "email": OWNER, "password": "correct-horse-battery-9",
                                      "display_name": "Saketh", "email_code": "000000"}, content_type="application/json", **h)
    assert bad.status_code == 403 and not get_user_model().objects.exists()
    ok = c.post("/api/auth/setup/", {"username": OWNER, "email": OWNER, "password": "correct-horse-battery-9",
                                     "display_name": "Saketh", "email_code": code_in(mail)}, content_type="application/json", **h)
    assert ok.status_code == 201
    u = get_user_model().objects.get()
    assert (u.username, u.email, u.first_name, u.is_superuser) == (OWNER, OWNER, "Saketh", True)
    # the code is single-use and the server can't be set up twice
    assert c.post("/api/auth/email-code/", {"email": OWNER}, content_type="application/json", **h).status_code == 403


def test_sign_in_with_email_afterwards(mail):
    get_user_model().objects.create_user(OWNER, email=OWNER, password="correct-horse-battery-9")
    c, h = _client()
    r = c.post("/api/auth/login/", {"username": "PVSaketh1@Gmail.com", "password": "correct-horse-battery-9"},
               content_type="application/json", **h)
    assert r.status_code == 200


def test_strangers_cannot_get_a_code_for_a_fresh_server(mail):
    c, h = _client()
    r = c.post("/api/auth/email-code/", {"email": "attacker@example.com"}, content_type="application/json", **h)
    assert r.status_code == 403 and mail == []


def test_codes_expire_lock_after_attempts_and_are_rate_limited(mail):
    email_otp.send_code(OWNER, "setup", "1.2.3.4")
    real = code_in(mail)
    for _ in range(email_otp.MAX_ATTEMPTS):
        assert not email_otp.check_code(OWNER, "111111" if real != "111111" else "222222", "setup")
    assert not email_otp.check_code(OWNER, real, "setup")  # locked
    email_otp.send_code(OWNER, "setup", None)
    EmailOTP.objects.update(expires_at=timezone.now())
    assert not email_otp.check_code(OWNER, code_in(mail), "setup")  # expired
    email_otp.send_code(OWNER, "setup", None)
    with pytest.raises(email_otp.EmailOTPError):
        email_otp.send_code(OWNER, "setup", None)  # 4th within 15 minutes


def test_without_email_config_the_setup_code_still_works(monkeypatch):
    monkeypatch.setattr(get_settings(), "email_provider", "")
    monkeypatch.setattr(get_settings(), "setup_code", "dash-code")
    c, h = _client()
    assert c.get("/api/auth/session/").json()["setup_verification"] == "code"
    assert c.post("/api/auth/setup/", {"username": "me", "password": "correct-horse-battery-9", "setup_code": "dash-code"},
                  content_type="application/json", **h).status_code == 201


def test_delivery_failure_is_reported_without_leaking_details(monkeypatch, caplog):
    s = get_settings()
    for k, v in {"email_provider": "smtp", "smtp_user": OWNER, "smtp_password": "app-password", "owner_emails": [OWNER]}.items():
        monkeypatch.setattr(s, k, v)

    def boom(*a, **k):
        raise OSError("connection refused to smtp with password app-password")
    monkeypatch.setattr("django.core.mail.send_mail", boom)
    with pytest.raises(email_otp.EmailOTPError, match="Couldn't send"):
        email_otp.send_code(OWNER, "setup", None)
    assert "app-password" not in caplog.text and not EmailOTP.objects.exists()
