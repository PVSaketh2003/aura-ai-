"""Lazy model registry: load on first use, unload after idle time, track inference latency.
16 GB of unified memory can't hold every model at once, so heavy models never load eagerly."""
from __future__ import annotations

import gc
import logging
import threading
import time
from typing import Any, Callable

from config.env import get_settings

log = logging.getLogger(__name__)


class ModelRegistry:
    def __init__(self):
        self._models: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._key_locks: dict[str, threading.RLock] = {}
        self._reaper: threading.Thread | None = None
        self.stats: dict[str, dict] = {}
        self.loading: dict[str, float] = {}  # key -> load start time (shown as "loading" in Settings)
        self.failed: dict[str, str] = {}  # key -> last load error (shown as "failed")

    def get(self, key: str, loader: Callable[[], Any]) -> Any:
        # Per-model lock: a slow load (or first-time download) of one model must never block the others.
        with self._lock:
            klock = self._key_locks.setdefault(key, threading.RLock())
        with klock:
            entry = self._models.get(key)
            if entry is None:
                t = time.perf_counter()
                log.info("loading model %s", key)
                self.loading[key] = time.time()
                try:
                    obj = loader()
                except Exception as e:
                    self.failed[key] = f"{type(e).__name__}: {e}"[:300]
                    raise
                finally:
                    self.loading.pop(key, None)
                self.failed.pop(key, None)
                entry = {"obj": obj, "loaded_at": time.time(), "load_ms": int((time.perf_counter() - t) * 1000)}
                self._models[key] = entry
                self._ensure_reaper()
            entry["last_used"] = time.time()
            return entry["obj"]

    def record(self, key: str, ms: int) -> None:
        s = self.stats.setdefault(key, {"calls": 0, "total_ms": 0, "last_ms": 0})
        s["calls"] += 1
        s["total_ms"] += ms
        s["last_ms"] = ms

    def loaded(self) -> dict[str, dict]:
        return {k: {"loaded_at": v["loaded_at"], "load_ms": v["load_ms"], "idle_s": int(time.time() - v["last_used"]),
                    **self.stats.get(k, {})} for k, v in self._models.items()}

    def state(self, prefix: str) -> str:
        """running | loading | failed | idle — for any model whose registry key starts with prefix."""
        if any(k.startswith(prefix) for k in self._models):
            return "running"
        if any(k.startswith(prefix) for k in self.loading):
            return "loading"
        if any(k.startswith(prefix) for k in self.failed):
            return "failed"
        return "idle"

    def error(self, prefix: str) -> str:
        return next((v for k, v in self.failed.items() if k.startswith(prefix)), "")

    def unload(self, key: str) -> None:
        with self._lock:
            if self._models.pop(key, None) is not None:
                gc.collect()
                try:
                    import torch
                    if torch.backends.mps.is_available():
                        torch.mps.empty_cache()
                except Exception:
                    pass
                log.info("unloaded idle model %s", key)

    def _ensure_reaper(self):
        if self._reaper and self._reaper.is_alive():
            return

        def reap():
            while True:
                time.sleep(30)
                idle = get_settings().model_idle_unload_seconds
                for k, v in list(self._models.items()):
                    if time.time() - v["last_used"] > idle:
                        self.unload(k)

        self._reaper = threading.Thread(target=reap, daemon=True, name="model-reaper")
        self._reaper.start()


registry = ModelRegistry()
