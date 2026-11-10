"""The same backend serves http://localhost (owner on the Mac) and https://*.pvsairamsaketh.in (Cloudflare Tunnel).
Sign-in must work on both: shared Secure cookies on the public HTTPS host, plain cookies on localhost; CORS/CSRF only
for the real frontend origin; admin never reachable from the public hosts."""
import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from apps.core import cookies
from config.env import get_settings

pytestmark = pytest.mark.django_db
PUBLIC = {"HTTP_HOST": "api.aura.pvsairamsaketh.in", "HTTP_X_FORWARDED_PROTO": "https",
          "HTTP_ORIGIN": "https://aura.pvsairamsaketh.in", "HTTP_REFERER": "https://aura.pvsairamsaketh.in/"}


@pytest.fixture
def public(monkeypatch, settings):
    monkeypatch.setattr(get_settings(), "cookie_domain", ".pvsairamsaketh.in")
    settings.ALLOWED_HOSTS = ["127.0.0.1", "localhost", "testserver", "api.aura.pvsairamsaketh.in", "aura.pvsairamsaketh.in"]
    settings.SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    settings.CSRF_TRUSTED_ORIGINS = ["http://localhost:5173", "https://aura.pvsairamsaketh.in"]
    settings.CORS_ALLOWED_ORIGINS = ["http://localhost:5173", "https://aura.pvsairamsaketh.in"]
    get_user_model().objects.create_user("owner", password="correct-horse-battery-9")
    return Client(enforce_csrf_checks=True)


def _login(c, **extra):
    c.get("/api/auth/session/", **extra)
    token = c.cookies["csrftoken"].value
    return c.post("/api/auth/login/", {"username": "owner", "password": "correct-horse-battery-9"},
                  content_type="application/json", HTTP_X_CSRFTOKEN=token, **extra)


def test_public_https_login_shares_a_secure_cookie_across_subdomains(public):
    r = _login(public, **PUBLIC)
    assert r.status_code == 200
    s = r.cookies["sessionid"]
    assert s["domain"] == ".pvsairamsaketh.in" and s["secure"] and s["httponly"] and s["samesite"] == "Lax"
    assert public.get("/api/auth/session/", **PUBLIC).json()["authenticated"] is True


def test_localhost_login_keeps_working_with_plain_cookies(public):
    r = _login(public, HTTP_HOST="localhost:8000", HTTP_ORIGIN="http://localhost:5173")
    assert r.status_code == 200
    assert r.cookies["sessionid"]["domain"] == "" and not r.cookies["sessionid"]["secure"]


def test_cors_allows_only_the_real_frontend_with_credentials(public):
    ok = public.get("/api/auth/session/", **PUBLIC)
    assert ok["Access-Control-Allow-Origin"] == "https://aura.pvsairamsaketh.in" and ok["Access-Control-Allow-Credentials"] == "true"
    evil = public.get("/api/auth/session/", **{**PUBLIC, "HTTP_ORIGIN": "https://evil.example"})
    assert "Access-Control-Allow-Origin" not in evil


def test_csrf_rejects_a_post_from_another_site(public):
    public.get("/api/auth/session/", **PUBLIC)
    token = public.cookies["csrftoken"].value
    r = public.post("/api/auth/login/", {"username": "owner", "password": "correct-horse-battery-9"}, content_type="application/json",
                    HTTP_X_CSRFTOKEN=token, **{**PUBLIC, "HTTP_ORIGIN": "https://evil.example", "HTTP_REFERER": "https://evil.example/"})
    assert r.status_code == 403


def test_cookie_middleware_is_inert_without_a_cookie_domain(monkeypatch):
    monkeypatch.setattr(get_settings(), "cookie_domain", "")
    assert cookies.SiteCookieMiddleware(lambda r: r).domain == ""


def test_admin_is_not_public_but_works_on_the_mac(public):
    assert public.get("/admin/", HTTP_HOST="api.aura.pvsairamsaketh.in", HTTP_X_FORWARDED_PROTO="https").status_code == 404
    assert public.get("/admin/", HTTP_HOST="localhost").status_code == 302  # → admin login page, as before


def test_admin_is_hidden_on_the_platform_address_too(public, settings):
    settings.ALLOWED_HOSTS = [*settings.ALLOWED_HOSTS, ".onrender.com"]
    assert public.get("/admin/", HTTP_HOST="aura-backend-m52k.onrender.com", HTTP_X_FORWARDED_PROTO="https").status_code == 404


def test_fresh_server_needs_the_setup_code(monkeypatch, settings, db):
    from django.contrib.auth import get_user_model
    from rest_framework.test import APIClient
    monkeypatch.setattr(get_settings(), "setup_code", "one-time-code-from-dashboard")
    c = APIClient()
    assert c.get("/api/auth/session/").json()["setup_code_required"] is True
    body = {"username": "owner", "password": "correct-horse-battery-9", "display_name": "Owner"}
    assert c.post("/api/auth/setup/", {**body, "setup_code": "guess"}, format="json").status_code == 403
    assert not get_user_model().objects.exists()
    assert c.post("/api/auth/setup/", {**body, "setup_code": "one-time-code-from-dashboard"}, format="json").status_code == 201
