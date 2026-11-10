from rest_framework import serializers

from .models import Conversation, Message


class MessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = Message
        fields = ["id", "role", "content", "modality", "language", "execution", "payload",
                  "referenced_documents", "referenced_memories", "created_at"]


class ConversationListSerializer(serializers.ModelSerializer):
    message_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Conversation
        fields = ["id", "title", "created_at", "updated_at", "message_count"]


class ConversationDetailSerializer(serializers.ModelSerializer):
    messages = MessageSerializer(many=True, read_only=True)

    class Meta:
        model = Conversation
        fields = ["id", "title", "created_at", "updated_at", "messages"]
        read_only_fields = ["id", "created_at", "updated_at", "messages"]
