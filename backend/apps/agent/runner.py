"""Executes agent runs off the request thread. All state is persisted in PostgreSQL; on restart, runs left
'running' are marked failed (interrupted) instead of silently disappearing."""
from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from django.db import close_old_connections, transaction
from django.utils import timezone

from apps.conversations.models import Conversation, Message
from apps.execution_traces.models import ExecutionRun, Status
from apps.execution_traces.tracer import StepFailed, Tracer
from services.agent_orchestrator.graph import run_graph

log = logging.getLogger(__name__)
_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="agent")
_recovered = threading.Event()
PROCESS_STARTED = timezone.now()
VOICE_PLACEHOLDER = "🎙 Voice message"


def recover_interrupted_runs() -> int:
    # only runs from a previous server process; runs created by this process are live
    n = ExecutionRun.objects.filter(status__in=[Status.RUNNING, Status.PENDING], started_at__lt=PROCESS_STARTED).update(
        status=Status.FAILED, error="Interrupted by a server restart.", finished_at=timezone.now())
    _recovered.set()
    from services.jobs.background import start_background_jobs
    start_background_jobs()
    return n


@transaction.atomic
def create_run(user, text: str, conversation: Conversation | None, modality: str = "text",
               language: str = "", audio_file: str = "", selected_language: str = "") -> tuple[ExecutionRun, Message]:
    if conversation is None:
        conversation = Conversation.objects.create(user=user, title=(text if modality == "text" else "Voice conversation")[:80])
    run = ExecutionRun.objects.create(user=user, conversation=conversation, input_text=text)
    msg = Message.objects.create(conversation=conversation, role=Message.Role.USER, content=text or VOICE_PLACEHOLDER,
                                 modality=modality, language=language, execution=run,
                                 payload={k: v for k, v in (("audio_file", audio_file),
                                                             ("selected_language", selected_language)) if v})
    Conversation.objects.filter(pk=conversation.pk).update(updated_at=timezone.now())
    return run, msg


def _prefs(user) -> dict:
    from apps.preferences.models import Preferences
    p = Preferences.for_user(user)
    return {"asr_language": p.asr_language, "spoken_languages": p.spoken_languages, "asr_engine": p.asr_engine,
            "asr_fallback": p.asr_fallback, "speak_replies": p.speak_replies, "tts_voices": p.tts_voices,
            "tts_speed": p.tts_speed, "web_search": p.web_search, "wikipedia": p.wikipedia, "multi_query": p.multi_query}


def execute_run(run_id) -> None:
    run = ExecutionRun.objects.select_related("conversation", "user").get(pk=run_id)
    tracer = Tracer(run)
    tracer.start()
    user_msg = run.messages.filter(role=Message.Role.USER).first()
    try:
        final = run_graph({
            "user_id": run.user_id, "conversation_id": str(run.conversation_id), "user_message_id": str(user_msg.id),
            "text": run.input_text, "modality": user_msg.modality, "prefs": _prefs(run.user),
            "audio_path": (user_msg.payload or {}).get("audio_file", ""),
        }, tracer)
        msg = Message.objects.get(pk=final["assistant_message_id"])
        tracer.finish(Status.COMPLETED, message={"id": str(msg.id), "role": "assistant", "content": msg.content,
                                                 "payload": msg.payload, "created_at": msg.created_at.isoformat(),
                                                 "execution": str(run.id)})
    except StepFailed as e:
        if user_msg and user_msg.content == VOICE_PLACEHOLDER:
            user_msg.content = "🎙 (not transcribed)"
            user_msg.save(update_fields=["content"])
        tracer.finish(Status.FAILED, error=str(e))
    except Exception as e:
        log.exception("Agent run %s crashed", run_id)
        tracer.finish(Status.FAILED, error=f"Internal error: {type(e).__name__}: {str(e)[:200]}")


def _execute(run_id) -> None:
    close_old_connections()
    try:
        execute_run(run_id)
    finally:
        close_old_connections()


def submit(run: ExecutionRun) -> None:
    if not _recovered.is_set():
        recover_interrupted_runs()
    transaction.on_commit(lambda: _pool.submit(_execute, run.id))


# ------------------------------------------------------------------------------- non-chat tasks (Library actions)
def start_task(user, label: str, fn: Callable, **kwargs) -> ExecutionRun:
    """Run a traced task (ingest, re-index…) outside a conversation. The live trace shows it like any agent run."""
    if not _recovered.is_set():
        recover_interrupted_runs()
    run = ExecutionRun.objects.create(user=user, conversation=None, input_text=label, intent="task")

    def work():
        close_old_connections()
        try:
            r = ExecutionRun.objects.select_related("user").get(pk=run.id)
            tracer = Tracer(r)
            tracer.start()
            try:
                result = fn(tracer, r.user, **kwargs)
                tracer.finish(Status.COMPLETED, result={"answer": result.answer, "documents": result.documents})
            except StepFailed as e:
                tracer.finish(Status.FAILED, error=str(e))
            except Exception as e:
                log.exception("task %s crashed", run.id)
                tracer.finish(Status.FAILED, error=f"Internal error: {type(e).__name__}: {str(e)[:200]}")
        finally:
            close_old_connections()

    transaction.on_commit(lambda: _pool.submit(work))
    return run
