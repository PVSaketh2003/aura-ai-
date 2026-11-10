import hashlib
from pathlib import Path

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.views.decorators.csrf import csrf_exempt
from rest_framework import serializers, status
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.models import audit
from apps.documents.ingestion import new_staging_dir
from config.env import get_settings

from . import bridge
from .models import LocalAgentDevice


def _device_payload(d: LocalAgentDevice | None, user_id: int):
    online = bool(d and bridge.online_device(user_id) == str(d.id))
    if not d:
        return {"paired": False, "online": False}
    return {"paired": True, "online": online, "id": str(d.id), "name": d.name, "hostname": d.hostname,
            "version": d.agent_version, "last_seen": d.last_seen, "disabled_roots": d.disabled_roots,
            "roots": [{**x, "enabled": x["name"] not in d.disabled_roots} for x in d.roots]}


class LocalAgentStatusView(APIView):
    def get(self, request):
        d = LocalAgentDevice.objects.filter(user=request.user, revoked=False).order_by("-last_seen").first()
        return Response(_device_payload(d, request.user.id))


class RootsInput(serializers.Serializer):
    disabled_roots = serializers.ListField(child=serializers.CharField(max_length=64), max_length=32)


class LocalAgentRootsView(APIView):
    """Disable/enable folders the agent exposes. The server can only *narrow* access, never widen it."""

    def put(self, request):
        data = RootsInput(data=request.data)
        data.is_valid(raise_exception=True)
        d = LocalAgentDevice.objects.filter(user=request.user, revoked=False).order_by("-last_seen").first()
        if not d:
            return Response({"detail": "No Local Agent is paired."}, status=404)
        d.disabled_roots = data.validated_data["disabled_roots"]
        d.save(update_fields=["disabled_roots"])
        async_to_sync(get_channel_layer().group_send)(bridge.agent_group(request.user.id), {
            "type": "agent.config", "config": {"type": "config", "disabled_roots": d.disabled_roots}})
        audit(request.user, "local_agent.roots_changed", d.name, disabled=d.disabled_roots)
        return Response(_device_payload(d, request.user.id))


@csrf_exempt
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def upload(request, request_id: str):
    """File transfer from the Local Agent. Device-token authenticated, bound to a pending read request,
    size-limited, PDF-validated and SHA-256 verified."""
    auth = request.headers.get("Authorization", "")
    device = LocalAgentDevice.authenticate(auth[7:] if auth.lower().startswith("bearer ") else "")
    if not device:
        return Response({"detail": "Unauthorized"}, status=401)
    pending = bridge.r().get(f"la:upload:{request_id[:64]}")
    if pending is None or int(pending) != device.user_id:
        return Response({"detail": "No matching file request."}, status=403)
    expected = request.headers.get("X-Content-Sha256", "")
    name = Path(request.headers.get("X-Filename", "document.pdf")).name[:255] or "document.pdf"
    if not name.lower().endswith(".pdf"):
        return Response({"detail": "Only PDF files are accepted."}, status=415)
    limit = get_settings().max_pdf_bytes
    dest = new_staging_dir() / name
    h, size = hashlib.sha256(), 0
    with open(dest, "wb") as f:
        while chunk := request.read(1 << 20):
            size += len(chunk)
            if size > limit:
                f.close()
                dest.unlink(missing_ok=True)
                return Response({"detail": "File too large."}, status=413)
            h.update(chunk)
            f.write(chunk)
    if h.hexdigest() != expected:
        dest.unlink(missing_ok=True)
        return Response({"detail": "Checksum mismatch."}, status=400)
    bridge.r().set(f"la:upload_done:{request_id[:64]}", str(dest), ex=600)
    bridge.r().delete(f"la:upload:{request_id[:64]}")
    audit(device.user, "local_agent.file_received", name, size=size, sha256=expected)
    return Response({"ok": True, "size": size})
