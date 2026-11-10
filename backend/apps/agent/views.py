from django.db import transaction
from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.conversations.models import Conversation

from services.language import LANGUAGES

from .runner import create_run, submit


class ChatInput(serializers.Serializer):
    message = serializers.CharField(max_length=8000, trim_whitespace=True)
    conversation_id = serializers.UUIDField(required=False, allow_null=True)


class ChatView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "agent"

    def post(self, request):
        data = ChatInput(data=request.data)
        data.is_valid(raise_exception=True)
        conv = None
        if cid := data.validated_data.get("conversation_id"):
            conv = Conversation.objects.filter(pk=cid, user=request.user).first()
            if conv is None:
                return Response({"detail": "Conversation not found."}, status=status.HTTP_404_NOT_FOUND)
        with transaction.atomic():
            run, msg = create_run(request.user, data.validated_data["message"], conv)
            submit(run)
        return Response({"execution_id": str(run.id), "conversation_id": str(run.conversation_id),
                         "message": {"id": str(msg.id), "role": "user", "content": msg.content,
                                     "created_at": msg.created_at.isoformat(), "modality": msg.modality}},
                        status=status.HTTP_202_ACCEPTED)


class VoiceView(APIView):
    """Voice turn: the recording is stored, then ASR runs as the first traced step of the agent run."""
    from rest_framework.parsers import MultiPartParser
    parser_classes = [MultiPartParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "agent"

    def post(self, request):
        from apps.speech.storage import save_upload
        from apps.speech.views import validate_audio
        f = request.FILES.get("audio")
        if err := validate_audio(f):
            return Response({"detail": err}, status=400)
        conv = None
        if cid := request.data.get("conversation_id"):
            conv = Conversation.objects.filter(pk=cid, user=request.user).first()
            if conv is None:
                return Response({"detail": "Conversation not found."}, status=404)
        lang = (request.data.get("language") or "").strip()
        if lang and lang != "auto" and lang not in LANGUAGES:
            return Response({"detail": "Unsupported language."}, status=400)
        path = save_upload(f)
        with transaction.atomic():
            run, msg = create_run(request.user, "", conv, modality="voice", audio_file=str(path),
                                  selected_language="" if lang == "auto" else lang)
            submit(run)
        return Response({"execution_id": str(run.id), "conversation_id": str(run.conversation_id),
                         "message": {"id": str(msg.id), "role": "user", "content": msg.content,
                                     "created_at": msg.created_at.isoformat(), "modality": "voice"}},
                        status=status.HTTP_202_ACCEPTED)


class VoiceRetryView(APIView):
    """Re-runs a voice turn on the same recording with a language the user confirmed ("which language did you say?")."""
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "agent"

    def post(self, request):
        from apps.conversations.models import Message
        lang = request.data.get("language", "")
        if lang not in LANGUAGES:
            return Response({"detail": "Unsupported language."}, status=400)
        src = Message.objects.filter(pk=request.data.get("message_id"), conversation__user=request.user,
                                     role=Message.Role.USER, modality="voice").select_related("conversation").first()
        audio = (src.payload or {}).get("audio_file") if src else None
        if not audio:
            return Response({"detail": "Recording not found."}, status=404)
        with transaction.atomic():
            run, msg = create_run(request.user, "", src.conversation, modality="voice", audio_file=audio,
                                  selected_language=lang)
            submit(run)
        return Response({"execution_id": str(run.id), "conversation_id": str(run.conversation_id),
                         "message": {"id": str(msg.id), "role": "user", "content": msg.content,
                                     "created_at": msg.created_at.isoformat(), "modality": "voice"}},
                        status=status.HTTP_202_ACCEPTED)
