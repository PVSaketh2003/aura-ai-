from django.conf import settings
from django.db import models


def default_spoken():
    return ["te", "hi", "en"]


class Preferences(models.Model):
    class Speak(models.TextChoices):
        ALWAYS = "always"
        VOICE_ONLY = "voice_only"
        NEVER = "never"

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True, related_name="preferences")
    asr_language = models.CharField(max_length=8, default="auto")  # "auto" = detect; otherwise authoritative
    # Auto mode only chooses among the languages the user actually speaks: an accent-driven guess can never turn
    # Telugu into Marathi/Tamil/Gujarati unless the user enabled that language.
    spoken_languages = models.JSONField(default=default_spoken, blank=True)
    asr_engine = models.CharField(max_length=24, default="auto")  # auto | indic-conformer | whisper
    asr_fallback = models.CharField(max_length=24, default="whisper")  # whisper | none
    speak_replies = models.CharField(max_length=16, choices=Speak.choices, default=Speak.ALWAYS)
    tts_voices = models.JSONField(default=dict, blank=True)  # {"en": "af_heart", ...}
    tts_speed = models.FloatField(default=1.0)
    web_search = models.BooleanField(default=True)
    wikipedia = models.BooleanField(default=True)
    multi_query = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def for_user(cls, user) -> "Preferences":
        return cls.objects.get_or_create(user=user)[0]
