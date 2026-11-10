import hashlib

import pytest
from rest_framework.test import APIClient

from apps.local_connector import bridge
from apps.local_connector.models import LocalAgentDevice, hash_token

pytestmark = pytest.mark.django_db
PDF = b"%PDF-1.4\nhello\n"


def test_token_is_hashed(user):
    d, token = LocalAgentDevice.pair(user, "mac")
    assert d.token_hash == hash_token(token) and token not in d.token_hash
    assert LocalAgentDevice.authenticate(token) == d
    assert LocalAgentDevice.authenticate("aura_la_wrong") is None


def _post(token, rid, body, sha=None, name="a.pdf"):
    return APIClient().generic("POST", f"/api/local-agent/upload/{rid}/", body, content_type="application/pdf",
                               HTTP_AUTHORIZATION=f"Bearer {token}", HTTP_X_CONTENT_SHA256=sha or hashlib.sha256(body).hexdigest(),
                               HTTP_X_FILENAME=name)


def test_upload_requires_pending_request_and_valid_checksum(user, settings, tmp_path):
    from config.env import get_settings
    get_settings().media_root = tmp_path
    d, token = LocalAgentDevice.pair(user, "mac")
    assert _post("aura_la_bad", "r1", PDF).status_code == 401
    assert _post(token, "r1", PDF).status_code == 403  # nobody asked for this file
    bridge.r().set("la:upload:r2", user.id, ex=60)
    assert _post(token, "r2", PDF, sha="0" * 64).status_code == 400
    bridge.r().set("la:upload:r3", user.id, ex=60)
    assert _post(token, "r3", PDF, name="x.exe").status_code == 415
    bridge.r().set("la:upload:r4", user.id, ex=60)
    assert _post(token, "r4", PDF).status_code == 200
    assert bridge.r().get("la:upload_done:r4").endswith("a.pdf")


def test_offline_agent_is_reported(user):
    bridge.r().delete(f"la:online:{user.id}")
    with pytest.raises(bridge.AgentOffline, match="offline or the Mac is asleep"):
        bridge.call(user.id, "roots")


def test_roots_can_only_be_narrowed(api, user):
    d, _ = LocalAgentDevice.pair(user, "mac")
    d.roots = [{"name": "Documents", "path": "/Users/x/Documents", "accessible": True, "error": ""}]
    d.save()
    r = api.put("/api/local-agent/roots/", {"disabled_roots": ["Documents"]}, format="json").json()
    assert r["roots"][0]["enabled"] is False
