"""Train my voice → Talk freely: upload up to ~5 minutes of free speech, see every utterance Aura heard (language +
transcript), confirm or correct it, and let Aura learn from the corrections. See services/asr/free_talk.py."""
from __future__ import annotations

import logging
import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from django.db import close_old_connections
from django.db.models import Avg, Count, Sum
from django.http import FileResponse, Http404
from rest_framework.parsers import JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from config.env import get_settings
from services.asr import free_talk as ft
from services.asr.enrollment import char_accuracy
from services.language import language_name

from .models import FreeTalkSegment, FreeTalkSession
from .storage import save_upload
from .views import validate_audio

log = logging.getLogger(__name__)
_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="free-talk")  # one long recording at a time (RAM)
_cache: dict[int, dict] = {}
_cache_lock = threading.Lock()


# ------------------------------------------------------------------------------------------- personal model
def _pairs(user_id: int) -> list[tuple[str, str, str]]:
    return [(s.language, s.heard, s.corrected) for s in
            FreeTalkSegment.objects.filter(user_id=user_id, verified=True).exclude(language="").only("language", "heard", "corrected")]


def personal_model(user_id: int) -> dict:
    """What Aura learned from this user's confirmed recordings, passed to services.asr.engine.transcribe(personal=…)."""
    with _cache_lock:
        if user_id in _cache:
            return _cache[user_id]
    pairs = _pairs(user_id)
    m = {"vocabulary": ft.learn_vocabulary(pairs), "corrections": ft.learn_corrections(pairs)}
    with _cache_lock:
        _cache[user_id] = m
    return m


def forget_cache(user_id: int) -> None:
    with _cache_lock:
        _cache.pop(user_id, None)


def language_mix(user_id: int) -> dict[str, float]:
    """Seconds spoken per language in free talk (confident detections only) — a prior for language detection."""
    rows = (FreeTalkSegment.objects.filter(user_id=user_id, language_uncertain=False).exclude(language="")
            .values("language").annotate(n=Count("id")))
    return {r["language"]: r["n"] for r in rows}


# ------------------------------------------------------------------------------------------------ processing
def _candidates(user) -> list[str]:
    from apps.preferences.models import Preferences
    return list(Preferences.for_user(user).spoken_languages or ["te", "hi", "en"])


def _session_dir(s: FreeTalkSession) -> Path:
    return get_settings().media_root / "voice_profile" / str(s.user_id) / "free" / str(s.id)


def process_session(session_id) -> None:
    """Split → per-utterance language ID + transcript. Runs on the background worker; progress is visible because
    segments are saved as they are transcribed."""
    from services.asr.engine import ASRError, load_audio, transcribe
    worker = threading.current_thread().name.startswith("free-talk")
    if worker:
        close_old_connections()
    s = FreeTalkSession.objects.select_related("user").get(pk=session_id)
    s.status = "processing"
    s.save(update_fields=["status"])
    d = _session_dir(s)
    wav = None
    try:
        wav = d / "full.wav"
        cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", s.audio_file, "-ac", "1",
               "-ar", "16000", "-t", str(ft.MAX_SESSION_SECONDS), "-f", "wav", str(wav)]
        subprocess.run(cmd, check=True, capture_output=True, timeout=180)
        audio = load_audio(wav)
        s.seconds = round(len(audio) / ft.SR, 1)
        spans = ft.split_speech(audio)
        if not spans:
            raise ASRError("No speech was found in the recording.")
        s.total_segments = len(spans)
        s.save(update_fields=["seconds", "total_segments"])
        import soundfile as sf
        cands, personal = _candidates(s.user), personal_model(s.user_id)
        for i, (a, b) in enumerate(spans):
            seg = d / f"seg-{i:03d}.wav"
            sf.write(str(seg), audio[int(a * ft.SR):int(b * ft.SR)], ft.SR)
            row = {"start": a, "end": b, "audio_file": str(seg)}
            try:
                tr = transcribe(seg, language="auto", candidates=cands, personal=personal)
                uncertain = tr.status == "uncertain"
                if ft.likely_hallucination(tr.text, b - a, tr.engine):
                    row.update(language=tr.language, heard="", engine="probably not speech (breath or noise)")
                    FreeTalkSegment.objects.update_or_create(session=s, index=i, defaults={"user_id": s.user_id, **row})
                    continue
                row.update(language=tr.language, language_probability=tr.language_probability, language_uncertain=uncertain,
                           heard=tr.text, confidence=tr.asr_confidence, engine=tr.engine if not uncertain else "language unclear")
            except ASRError as e:
                row.update(heard="", engine=f"nothing recognised ({str(e)[:60]})")
            FreeTalkSegment.objects.update_or_create(session=s, index=i, defaults={"user_id": s.user_id, **row})
        s.status = "done"
        s.save(update_fields=["status"])
    except Exception as e:  # noqa: BLE001
        log.warning("free-talk session %s failed: %s", session_id, e)
        s.status, s.error = "failed", (str(e) if isinstance(e, ASRError) else f"{type(e).__name__}: {e}")[:300]
        s.save(update_fields=["status", "error"])
    finally:
        if wav:
            wav.unlink(missing_ok=True)
        if worker:
            close_old_connections()


def submit(session_id) -> None:
    _worker.submit(process_session, session_id)


# ------------------------------------------------------------------------------------------------------- API
def _seg(x: FreeTalkSegment) -> dict:
    return {"id": str(x.id), "index": x.index, "start": x.start, "end": x.end, "language": x.language,
            "language_name": language_name(x.language) if x.language else "", "language_probability": x.language_probability,
            "language_uncertain": x.language_uncertain, "heard": x.heard, "confidence": x.confidence, "engine": x.engine,
            "corrected": x.corrected, "verified": x.verified, "accuracy": x.accuracy}


def _session(s: FreeTalkSession, segments: bool = False) -> dict:
    out = {"id": str(s.id), "seconds": s.seconds, "status": s.status, "total_segments": s.total_segments,
           "done_segments": s.segments.count(), "verified": s.segments.filter(verified=True).count(),
           "error": s.error, "created_at": s.created_at.isoformat()}
    if segments:
        out["segments"] = [_seg(x) for x in s.segments.all()]
    return out


def summary(user_id: int) -> dict:
    qs = FreeTalkSegment.objects.filter(user_id=user_id)
    v = qs.filter(verified=True)
    agg = v.aggregate(acc=Avg("accuracy"), n=Count("id"))
    per = {r["language"]: {"verified": r["n"], "accuracy": r["acc"]}
           for r in v.values("language").annotate(n=Count("id"), acc=Avg("accuracy"))}
    m = personal_model(user_id)
    secs = FreeTalkSession.objects.filter(user_id=user_id, status="done").aggregate(t=Sum("seconds"))["t"] or 0
    return {"seconds": round(secs, 1), "segments": qs.count(), "verified": agg["n"], "accuracy": agg["acc"],
            "per_language": per, "language_mix": language_mix(user_id), "vocabulary": m["vocabulary"],
            "corrections": {L: [{"wrong": w, "right": r, "times": n} for w, r, n in rules[:40]]
                            for L, rules in m["corrections"].items()}}


class FreeTalkSessionsView(APIView):
    parser_classes = [MultiPartParser]

    def get(self, request):
        return Response({"sessions": [_session(s) for s in FreeTalkSession.objects.filter(user=request.user)[:30]],
                         "summary": summary(request.user.id)})

    def post(self, request):
        f = request.FILES.get("audio")
        if err := validate_audio(f):
            return Response({"detail": err}, status=400)
        if FreeTalkSession.objects.filter(user=request.user, status__in=["queued", "processing"]).exists():
            return Response({"detail": "Aura is still listening to your previous recording — wait for it to finish."}, status=409)
        tmp = save_upload(f)
        s = FreeTalkSession(user=request.user)
        d = _session_dir(s)
        d.mkdir(parents=True, exist_ok=True)
        dest = d / f"recording{tmp.suffix}"
        shutil.move(str(tmp), dest)
        s.audio_file = str(dest)
        s.save()
        submit(s.id)
        return Response(_session(s), status=202)


class FreeTalkSessionView(APIView):
    def get(self, request, session_id):
        s = FreeTalkSession.objects.filter(user=request.user, pk=session_id).first()
        if not s:
            raise Http404
        return Response(_session(s, segments=True))

    def delete(self, request, session_id):
        s = FreeTalkSession.objects.filter(user=request.user, pk=session_id).first()
        if not s:
            raise Http404
        if s.status in ("queued", "processing"):
            return Response({"detail": "Still processing — delete it when it finishes."}, status=409)
        d = _session_dir(s)
        s.delete()
        shutil.rmtree(d, ignore_errors=True)  # only this session's own folder (UUID path built server-side)
        forget_cache(request.user.id)
        from .profile import write_manifest
        write_manifest(request.user.id)
        return Response(status=204)


class FreeTalkSegmentView(APIView):
    parser_classes = [JSONParser]

    def _get(self, request, segment_id) -> FreeTalkSegment:
        x = FreeTalkSegment.objects.filter(user=request.user, pk=segment_id).first()
        if not x:
            raise Http404
        return x

    def get(self, request, segment_id):
        """The utterance's audio (owner only)."""
        x = self._get(request, segment_id)
        p = Path(x.audio_file)
        if not p.exists():
            raise Http404
        return FileResponse(open(p, "rb"), content_type="audio/wav")

    def patch(self, request, segment_id):
        """{"text": what I actually said, "language"?: code}  → confirmed; {"verified": false} → unconfirm."""
        x = self._get(request, segment_id)
        if request.data.get("verified") is False:
            x.verified, x.corrected, x.accuracy = False, "", None
        else:
            text = " ".join(str(request.data.get("text", x.heard)).split())[:2000]
            if not text:
                return Response({"detail": "Type what you said (or delete the recording)."}, status=400)
            lang = request.data.get("language") or x.language
            if lang not in set(_candidates(request.user)) | {x.language}:
                return Response({"detail": "Pick one of your languages."}, status=400)
            if lang != x.language:
                x.language, x.language_uncertain = lang, False
            x.corrected, x.verified = text, True
            x.accuracy = round(char_accuracy(text, x.heard), 3) if x.heard else 0.0
        x.save()
        forget_cache(request.user.id)
        from .profile import write_manifest
        write_manifest(request.user.id)
        return Response(_seg(x))
