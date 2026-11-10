import pytest
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db


def test_first_run_setup_then_locked():
    c = APIClient()
    assert c.get("/api/auth/session/").json()["setup_required"] is True
    r = c.post("/api/auth/setup/", {"username": "me", "password": "a-strong-passphrase", "display_name": "Sai"})
    assert r.status_code == 201 and r.json()["user"]["display_name"] == "Sai"
    assert c.get("/api/auth/session/").json() == {"authenticated": True, "setup_required": False, "setup_verification": "none", "setup_code_required": False,
                                                  "user": {"id": r.json()["user"]["id"], "username": "me",
                                                           "display_name": "Sai"}}
    r2 = APIClient().post("/api/auth/setup/", {"username": "intruder", "password": "another-strong-pass"})
    assert r2.status_code == 403


def test_weak_password_rejected():
    r = APIClient().post("/api/auth/setup/", {"username": "me", "password": "password"})
    assert r.status_code == 400


def test_login_and_protected_endpoints(user):
    c = APIClient()
    assert c.get("/api/conversations/").status_code == 403
    assert c.post("/api/auth/login/", {"username": "owner", "password": "wrong"}).status_code == 400
    assert c.post("/api/auth/login/", {"username": "owner", "password": "correct-horse-battery"}).status_code == 200
    assert c.get("/api/conversations/").status_code == 200
