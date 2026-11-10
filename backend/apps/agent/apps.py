import sys

from django.apps import AppConfig


def warm_all() -> None:
    """Load every model on the hot path once at server start, so the first question doesn't pay load times
    (Llama ~5 s, embedder ~3 s, Kokoro ~10 s, Whisper ~5 s)."""
    import logging
    log = logging.getLogger("aura.warmup")
    steps = []
    try:
        from services.retrievers.pipeline import prewarm_chat_model
        prewarm_chat_model(); steps.append("llm")
    except Exception as e:  # noqa: BLE001
        log.warning("llm warm-up failed: %s", e)
    try:
        from services.embeddings.qwen import QwenEmbeddings
        QwenEmbeddings().embed_query("warm up"); steps.append("embeddings")
    except Exception as e:  # noqa: BLE001
        log.warning("embedding warm-up failed: %s", e)
    try:
        from services.tts.engine import _synth
        _synth("Ready.", "en", None, 1.0); steps.append("kokoro")
    except Exception as e:  # noqa: BLE001
        log.warning("tts warm-up failed: %s", e)
    try:
        from services.asr.engine import _vox, warm
        warm(); _vox(); steps.append("whisper+voxlingua")
    except Exception as e:  # noqa: BLE001
        log.warning("asr warm-up failed: %s", e)
    try:  # Telugu/Hindi voice goes to IndicConformer — load it (~6 s, ~2.9 GB) only if its weights are already on disk
        from services.asr.engine import _indic, indic_available
        if indic_available()[0]:
            _indic(); steps.append("indic-conformer")
    except Exception as e:  # noqa: BLE001
        log.warning("IndicConformer warm-up failed: %s", e)
    log.info("warm-up done: %s", ", ".join(steps))


class AgentConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.agent"

    def ready(self):
        # `kill -USR1 <pid>` dumps every thread's Python stack to stderr — for diagnosing stalls without a debugger.
        import faulthandler
        import signal
        try:
            faulthandler.register(signal.SIGUSR1, all_threads=True)
        except (AttributeError, ValueError, RuntimeError):
            pass
        if any(cmd in sys.argv for cmd in ("runserver", "daphne")) or sys.argv[0].endswith("daphne"):
            import threading
            threading.Thread(target=warm_all, daemon=True, name="aura-warmup").start()
