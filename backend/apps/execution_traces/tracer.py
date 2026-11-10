"""Real execution tracing.

Each `with tracer.step(...)` persists an ExecutionStep row *before* the work starts and updates it
when the work finishes or fails, broadcasting each transition to the user's WebSocket group.
The UI therefore only ever shows steps that actually ran.
"""
from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.utils import timezone

from .models import ExecutionRun, ExecutionStep, Status
from .serializers import ExecutionStepSerializer

log = logging.getLogger(__name__)


def user_group(user_id: int) -> str:
    return f"user.{user_id}.executions"


def broadcast(user_id: int, event: dict[str, Any]) -> None:
    layer = get_channel_layer()
    if layer is None:
        return
    try:
        async_to_sync(layer.group_send)(user_group(user_id), {"type": "execution.event", "event": event})
    except Exception:  # broadcasting must never break the agent; state is still persisted in Postgres
        log.exception("WebSocket broadcast failed")


@dataclass
class StepHandle:
    step: ExecutionStep
    summary: str = ""
    detail: dict[str, Any] = field(default_factory=dict)

    def set(self, summary: str | None = None, **detail: Any) -> None:
        if summary is not None:
            self.summary = summary[:500]
        self.detail.update(detail)


class StepFailed(Exception):
    """Raised inside a step to mark it failed with a user-facing message (no traceback shown)."""


class Tracer:
    def __init__(self, run: ExecutionRun):
        self.run = run
        self._seq = run.steps.count()
        self._t0 = time.perf_counter()

    def _emit(self, kind: str, **payload: Any) -> None:
        broadcast(self.run.user_id, {"kind": kind, "execution_id": str(self.run.id), **payload})

    def emit(self, kind: str, **payload: Any) -> None:
        self._emit(kind, **payload)

    def start(self) -> None:
        self.run.status = Status.RUNNING
        self.run.save(update_fields=["status"])
        self._emit("run.started", conversation_id=str(self.run.conversation_id), input_text=self.run.input_text)

    @contextmanager
    def step(self, key: str, name: str) -> Iterator[StepHandle]:
        self._seq += 1
        step = ExecutionStep.objects.create(run=self.run, seq=self._seq, key=key, name=name, status=Status.RUNNING)
        self._emit("step.updated", step=ExecutionStepSerializer(step).data)
        handle = StepHandle(step)
        t = time.perf_counter()
        try:
            yield handle
        except BaseException as exc:
            step.status = Status.FAILED
            step.error = str(exc)[:2000] if isinstance(exc, StepFailed) else f"{type(exc).__name__}: {exc}"[:2000]
            raise
        else:
            step.status = Status.COMPLETED
        finally:
            step.summary = handle.summary
            step.detail = handle.detail
            step.finished_at = timezone.now()
            step.duration_ms = int((time.perf_counter() - t) * 1000)
            step.save()
            self._emit("step.updated", step=ExecutionStepSerializer(step).data)

    def finish(self, status: str = Status.COMPLETED, error: str = "", **payload: Any) -> None:
        self.run.status = status
        self.run.error = error[:2000]
        self.run.finished_at = timezone.now()
        self.run.duration_ms = int((time.perf_counter() - self._t0) * 1000)
        self.run.save(update_fields=["status", "error", "finished_at", "duration_ms", "intent"])
        self._emit("run.finished", status=status, error=self.run.error, duration_ms=self.run.duration_ms, **payload)
