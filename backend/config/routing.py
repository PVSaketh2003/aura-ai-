from django.urls import path

from apps.execution_traces.consumers import ExecutionEventsConsumer, LocalAgentStatusConsumer, VoiceEventsConsumer
from apps.local_connector.consumers import LocalAgentConsumer
from apps.messenger.consumers import MessengerConsumer

# Browser sockets: session-cookie auth + Origin validation.
browser_websocket_urlpatterns = [
    path("ws/agent/executions/", ExecutionEventsConsumer.as_asgi()),  # all events (used by the web app)
    path("ws/voice/", VoiceEventsConsumer.as_asgi()),
    path("ws/local-agent/status/", LocalAgentStatusConsumer.as_asgi()),
    path("ws/messenger/", MessengerConsumer.as_asgi()),
]
# Device socket for the Local Mac Agent: bearer-token auth, no cookies (so Origin checks don't apply).
device_websocket_urlpatterns = [path("ws/local-agent/", LocalAgentConsumer.as_asgi())]
