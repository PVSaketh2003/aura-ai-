from django.http import FileResponse, Http404
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.conversations.models import Message
from config.env import get_settings
from services.asr.engine import ASRError, transcribe, warm

from .storage import save_upload, tts_dir

AUDIO_TYPES = ("audio/webm", "audio/mp4", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg")


def validate_audio(f):
    if f is None:
        return "Attach an audio file as `audio`."
    if f.size > get_settings().max_audio_bytes:
        return "Recording is too large."
    if (f.content_type or "").split(";")[0] not in AUDIO_TYPES:
        return f"Unsupported audio type {f.content_type}."
    return None


class TranscribeView(APIView):
    parser_classes = [MultiPartParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "agent"

    def post(self, request):
        f = request.FILES.get("audio")
        if err := validate_audio(f):
            return Response({"detail": err}, status=400)
        path = save_upload(f)
        try:
            tr = transcribe(path, language=request.data.get("language", "auto"))
        except ASRError as e:
            return Response({"detail": str(e)}, status=422)
        finally:
            path.unlink(missing_ok=True)
        return Response(tr.as_dict())


class AudioView(APIView):
    """Serves generated speech for the owner of the message only."""

    def get(self, request, message_id, segment=None):
        if not Message.objects.filter(pk=message_id, conversation__user=request.user).exists():
            raise Http404
        d = tts_dir(str(message_id))
        p = d / ("answer.m4a" if segment is None else f"seg-{int(segment):03d}.m4a")
        if not p.exists():
            raise Http404
        resp = FileResponse(open(p, "rb"), content_type="audio/mp4")
        if request.query_params.get("download"):
            resp["Content-Disposition"] = f'attachment; filename="aura-{str(message_id)[:8]}.m4a"'
        return resp


class WarmView(APIView):
    """Called when the microphone opens: loads Whisper in the background while the user is still speaking."""

    def post(self, request):
        return Response({"warming": warm()})
