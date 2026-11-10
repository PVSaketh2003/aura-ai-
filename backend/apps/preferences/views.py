from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from services.language import LANGUAGES

from .models import Preferences


class PreferencesSerializer(serializers.ModelSerializer):
    asr_language = serializers.ChoiceField(choices=["auto", *LANGUAGES.keys()])
    tts_speed = serializers.FloatField(min_value=0.6, max_value=1.6)

    class Meta:
        model = Preferences
        fields = ["asr_language", "spoken_languages", "asr_engine", "asr_fallback", "speak_replies", "tts_voices", "tts_speed", "web_search", "wikipedia", "multi_query", "updated_at"]
        read_only_fields = ["updated_at"]

    asr_engine = serializers.ChoiceField(choices=["auto", "indic-conformer", "whisper"], required=False)
    asr_fallback = serializers.ChoiceField(choices=["whisper", "none"], required=False)

    def validate_spoken_languages(self, v):
        if not isinstance(v, list) or not v or len(v) > 6 or any(x not in LANGUAGES for x in v):
            raise serializers.ValidationError("Choose 1-6 supported languages.")
        return list(dict.fromkeys(v))

    def validate_tts_voices(self, v):
        if not isinstance(v, dict) or len(v) > 30 or any(not isinstance(x, str) or len(x) > 40 for x in v.values()):
            raise serializers.ValidationError("Invalid voices map.")
        return v


class PreferencesView(APIView):
    def get(self, request):
        return Response({**PreferencesSerializer(Preferences.for_user(request.user)).data, "languages": LANGUAGES})

    def put(self, request):
        s = PreferencesSerializer(Preferences.for_user(request.user), data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        s.save()
        return Response({**s.data, "languages": LANGUAGES})
