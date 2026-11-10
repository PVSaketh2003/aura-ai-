import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django_asgi = get_asgi_application()

from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from channels.security.websocket import AllowedHostsOriginValidator  # noqa: E402

from .routing import browser_websocket_urlpatterns, device_websocket_urlpatterns  # noqa: E402

browser = AllowedHostsOriginValidator(AuthMiddlewareStack(URLRouter(browser_websocket_urlpatterns)))
device = URLRouter(device_websocket_urlpatterns)


async def websocket_router(scope, receive, send):
    app = device if scope["path"].rstrip("/") == "/ws/local-agent" else browser
    return await app(scope, receive, send)


application = ProtocolTypeRouter({"http": django_asgi, "websocket": websocket_router})


def _clear_stale_agent_presence():
    """A restarted server has no live agent sockets yet; drop presence left by the previous process so requests
    aren't sent to an agent that hasn't reconnected (it re-registers within seconds)."""
    try:
        from apps.local_connector.bridge import r
        for k in r().scan_iter("la:online:*"):
            r().delete(k)
    except Exception:
        pass


_clear_stale_agent_presence()
