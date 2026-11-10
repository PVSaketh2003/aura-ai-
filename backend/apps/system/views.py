"""Health & model status. Never returns secrets — only whether they are configured."""
import shutil
import time

import psutil
from django.db import connection
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from config.env import BASE_DIR, get_settings

_HF_CACHE: dict = {}


def _hf_cache(scan):
    """scan_cache_dir walks every file; cache it for a minute."""
    if time.time() - _HF_CACHE.get("t", 0) > 60:
        _HF_CACHE.update(t=time.time(), repos=list(scan().repos))
    return _HF_CACHE["repos"]
from services.llm.ollama import LLMUnavailable, OllamaClient, _norm


def _timed(fn):
    t = time.perf_counter()
    try:
        detail = fn() or {}
        return {"status": "ok", "latency_ms": round((time.perf_counter() - t) * 1000, 1), **detail}
    except Exception as e:
        return {"status": "down", "error": f"{type(e).__name__}: {e}"[:300]}


def _db():
    with connection.cursor() as c:
        c.execute("select version()")
        return {"version": c.fetchone()[0].split(" on ")[0]}


def _redis():
    import redis

    redis.Redis.from_url(get_settings().redis_url, socket_timeout=2).ping()


class HealthView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        s = get_settings()
        components = {"database": _timed(_db), "realtime": _timed(_redis)}
        if not request.user.is_authenticated:
            ok = all(c["status"] == "ok" for c in components.values())
            return Response({"status": "ok" if ok else "degraded"})

        client = OllamaClient()
        try:
            installed = {_norm(m["name"]): m for m in client.list_models()}
            loaded = {_norm(m["name"]) for m in client.loaded_models()}
            ollama = {"status": "ok", "url": s.ollama_base_url}
        except LLMUnavailable as e:
            installed, loaded, ollama = {}, set(), {"status": "down", "error": str(e)}

        def model(role, name, runtime, phase=None):
            m = installed.get(_norm(name)) if runtime == "ollama" else None
            st = "installed" if m else ("planned" if phase else "missing")
            return {"role": role, "name": name, "runtime": runtime, "status": st,
                    "loaded": _norm(name) in loaded, "size_bytes": m.get("size") if m else None, "phase": phase}

        from services.asr import engine as asr
        from services.jobs.registry import registry
        from services.vector_store import chroma_store
        loaded_local = registry.loaded()

        def hf_cached(repo: str) -> bool:
            try:
                from huggingface_hub import scan_cache_dir
                return any(r.repo_id == repo for r in _hf_cache(scan_cache_dir))
            except Exception:
                return False

        def local(role, name, key, *, downloaded: bool, blocked: str = "", note: str = "", component: str = ""):
            st = registry.state(key)
            if st == "idle":
                st = "auth_required" if blocked == "auth" else "unavailable" if blocked else ("downloaded" if downloaded else "unavailable")
            return {"role": role, "name": name, "runtime": "local", "status": st, "component": component,
                    "loaded": st == "running", "size_bytes": None, "phase": None,
                    "note": registry.error(key) if st == "failed" else note}

        indic_ok, indic_why = asr.indic_available()
        indic_blocked = "" if indic_ok else ("auth" if "gated" in indic_why.lower() or "login" in indic_why.lower() else "missing")
        tts_ok = hf_cached("hexgrad/Kokoro-82M")

        def ollama_model(role, name, component):
            m = model(role, name, "ollama")
            m["status"] = "running" if m["loaded"] else ("available" if m["status"] == "installed" else "unavailable")
            m["component"] = component
            return m

        models = [ollama_model("Chat", s.llm_model, "llm")]
        models += [ollama_model("Chat fallback", fb, "llm") for fb in s.llm_fallback_models]
        models += [ollama_model("Embeddings", s.embedding_model, "embeddings"),
                   local("Speech recognition · Indian languages", "AI4Bharat IndicConformer-600M", "asr:indic",
                         downloaded=indic_ok, blocked=indic_blocked, note=indic_why or _indic_note(s), component="asr"),
                   local("Speech recognition · all languages", "Whisper large-v3-turbo (MLX, GPU)", "asr:whisper-mlx",
                         downloaded=asr._mlx_ok(), component="asr"),
                   local("Spoken-language identification", "SpeechBrain VoxLingua107 ECAPA", "asr:voxlingua",
                         downloaded=(BASE_DIR / "data" / "models" / "voxlingua" / "classifier.ckpt").exists(), component="lid"),
                   local("Text to speech", "Kokoro-82M (en, hi, es, fr, it, pt)", "tts:kokoro", downloaded=tts_ok, component="tts"),
                   local("Indic text to speech", "Meta MMS-TTS (te, ta, kn, ml, bn, mr, gu, …)", "tts:mms",
                         downloaded=hf_cached("facebook/mms-tts-tel"), note="one small model per language, loaded on demand",
                         component="tts")]
        if asr._personal_langs():
            models.append(local("Speech recognition · your voice", "Whisper fine-tuned on your recordings", "asr:whisper-personal",
                                downloaded=True, component="asr"))

        vm = psutil.virtual_memory()
        du = shutil.disk_usage("/")
        components["llm_runtime"] = ollama
        components["vector_store"] = chroma_store.health()
        from apps.local_connector.bridge import online_device
        from apps.local_connector.models import LocalAgentDevice
        paired = LocalAgentDevice.objects.filter(user=request.user, revoked=False).exists()
        components["local_agent"] = {"status": "ok" if online_device(request.user.id) else ("offline" if paired else "not_installed")}
        ok = all(c["status"] in ("ok",) for k, c in components.items() if k in ("database", "realtime", "llm_runtime", "vector_store"))
        return Response({
            "status": "ok" if ok else "degraded",
            "components": components,
            "models": models,
            "model_runtime": {"loaded_local": loaded_local, "loaded_ollama": sorted(loaded)},
            "resources": {
                "cpu_percent": psutil.cpu_percent(interval=0.1),
                "memory_total": vm.total, "memory_used": vm.total - vm.available, "memory_percent": vm.percent,
                "disk_total": du.total, "disk_free": du.free,
            },
        })


def _indic_note(s) -> str:
    """What IndicConformer build is really in use (the loaded encoder when running, else what will load)."""
    from services.asr.engine import _indic_int8_path
    from services.jobs.registry import registry
    m = registry._models.get("asr:indic-conformer-600m", {}).get("obj")
    enc = getattr(m, "encoder_path", None)
    int8 = ("int8" in enc.name) if enc else (s.indic_int8 and _indic_int8_path().exists())
    return f"{s.indic_decoding.upper()} decoding · {'int8' if int8 else 'fp32'} encoder · Telugu, Hindi + 20 Indian languages"

