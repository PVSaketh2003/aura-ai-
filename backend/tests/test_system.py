import pytest
from channels.testing import WebsocketCommunicator
from rest_framework.test import APIClient

from config.asgi import application

pytestmark = pytest.mark.django_db


def test_health_public_is_minimal():
    body = APIClient().get("/api/health/").json()
    assert set(body) == {"status"}


def test_health_authenticated_has_no_secrets(api):
    body = api.get("/api/health/").json()
    assert body["components"]["database"]["status"] == "ok"
    assert "api_key" not in str(body).lower()


@pytest.mark.asyncio
async def test_websocket_rejects_anonymous():
    comm = WebsocketCommunicator(application, "/ws/agent/executions/", headers=[(b"origin", b"http://localhost")])
    connected, code = await comm.connect()
    assert not connected
    await comm.disconnect()
