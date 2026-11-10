from django.db.models import Count
from rest_framework import generics

from .models import Conversation
from .serializers import ConversationDetailSerializer, ConversationListSerializer


class ConversationListView(generics.ListAPIView):
    serializer_class = ConversationListSerializer

    def get_queryset(self):
        qs = Conversation.objects.filter(user=self.request.user).annotate(message_count=Count("messages"))
        if q := self.request.query_params.get("q"):
            qs = qs.filter(title__icontains=q[:100])
        return qs


class ConversationDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = ConversationDetailSerializer
    lookup_url_kwarg = "conversation_id"
    http_method_names = ["get", "patch", "delete"]

    def get_queryset(self):
        return Conversation.objects.filter(user=self.request.user).prefetch_related("messages")


from rest_framework import serializers as _s  # noqa: E402
from rest_framework.response import Response  # noqa: E402
from rest_framework.views import APIView  # noqa: E402

from .models import Message, MessageFeedback  # noqa: E402


class FeedbackInput(_s.Serializer):
    rating = _s.ChoiceField(choices=[1, -1])
    correction = _s.CharField(max_length=8000, required=False, allow_blank=True)
    consent = _s.BooleanField(default=False)


class FeedbackView(APIView):
    def put(self, request, message_id):
        msg = generics.get_object_or_404(Message, pk=message_id, conversation__user=request.user, role="assistant")
        data = FeedbackInput(data=request.data)
        data.is_valid(raise_exception=True)
        fb, _ = MessageFeedback.objects.update_or_create(message=msg, defaults=data.validated_data)
        return Response({"rating": fb.rating, "consent": fb.consent, "correction": fb.correction})
