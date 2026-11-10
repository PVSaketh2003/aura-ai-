"""Voice profile API: enrollment prompts, recording samples, per-sample recognition accuracy, dataset export."""
from __future__ import annotations

import json
from pathlib import Path

from django.db.models import Avg, Count, Sum
from rest_framework.parsers import JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from config.env import get_settings
from services.asr.engine import ASRError, transcribe
from services.asr.enrollment import PROMPTS, char_accuracy

from .models import FreeTalkSegment, VoiceSample
from .storage import save_upload
from .views import validate_audio


def _sample(s: VoiceSample) -> dict:
    return {"id": str(s.id), "language": s.language, "index": s.prompt_index, "text": s.text, "heard": s.heard,
            "accuracy": s.accuracy, "seconds": s.seconds, "created_at": s.created_at.isoformat()}


def enrolled_languages(user_id: int) -> list[str]:
    """Languages the user has trained or spoken in free talk, most used first — used as a prior by language detection."""
    from .free_talk import language_mix
    n = dict(VoiceSample.objects.filter(user_id=user_id).values("language").annotate(n=Count("id")).values_list("language", "n"))
    for lang, k in language_mix(user_id).items():
        n[lang] = n.get(lang, 0) + k
    return sorted(n, key=lambda L: -n[L])


def write_manifest(user_id: int) -> None:
    """Training manifest (audio path + the exact sentence read) used by scripts/finetune_voice.py."""
    d = get_settings().media_root / "voice_profile" / str(user_id)
    d.mkdir(parents=True, exist_ok=True)
    rows = [json.dumps({"audio": x.audio_file, "text": x.text, "language": x.language}, ensure_ascii=False)
            for x in VoiceSample.objects.filter(user_id=user_id)]
    # free-talk utterances the user confirmed or corrected: exact text for real, spontaneous speech
    rows += [json.dumps({"audio": x.audio_file, "text": x.corrected, "language": x.language, "source": "free_talk"},
                        ensure_ascii=False)
             for x in FreeTalkSegment.objects.filter(user_id=user_id, verified=True).exclude(language="")]
    (d / "manifest.jsonl").write_text("\n".join(rows) + ("\n" if rows else ""), encoding="utf-8")


class VoiceProfileView(APIView):
    def get(self, request):
        qs = VoiceSample.objects.filter(user=request.user)
        stats = {r["language"]: {"samples": r["n"], "seconds": round(r["secs"] or 0, 1), "accuracy": r["acc"]}
                 for r in qs.values("language").annotate(n=Count("id"), secs=Sum("seconds"), acc=Avg("accuracy"))}
        return Response({"prompts": PROMPTS, "samples": [_sample(s) for s in qs[:300]], "stats": stats,
                         "dataset_dir": str(get_settings().media_root / "voice_profile")})


class VoiceSampleView(APIView):
    parser_classes = [MultiPartParser, JSONParser]

    def post(self, request):
        f = request.FILES.get("audio")
        if err := validate_audio(f):
            return Response({"detail": err}, status=400)
        lang = request.data.get("language", "")
        try:
            idx = int(request.data.get("index", -1))
        except ValueError:
            idx = -1
        if lang not in PROMPTS or not 0 <= idx < len(PROMPTS[lang]):
            return Response({"detail": "Unknown language or sentence."}, status=400)
        text = PROMPTS[lang][idx]
        path = save_upload(f)
        dest_dir = get_settings().media_root / "voice_profile" / str(request.user.id) / lang
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{idx:03d}{path.suffix}"
        path.replace(dest)
        try:
            tr = transcribe(dest, language=lang)
            heard, secs = tr.text, tr.audio_seconds
        except ASRError as e:
            return Response({"detail": str(e)}, status=422)
        s, _ = VoiceSample.objects.update_or_create(
            user=request.user, language=lang, prompt_index=idx,
            defaults={"text": text, "audio_file": str(dest), "heard": heard, "accuracy": round(char_accuracy(text, heard), 3),
                      "seconds": secs})
        write_manifest(request.user.id)
        return Response(_sample(s), status=201)

    def delete(self, request, sample_id):
        s = VoiceSample.objects.filter(user=request.user, pk=sample_id).first()
        if not s:
            return Response(status=404)
        Path(s.audio_file).unlink(missing_ok=True)
        s.delete()
        write_manifest(request.user.id)
        return Response(status=204)
