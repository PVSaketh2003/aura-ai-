"""In-process background jobs: memory vector resync (Postgres → Chroma) on an interval."""
import logging
import threading
import time

from django.db import close_old_connections

log = logging.getLogger(__name__)
_started = threading.Event()


def _memory_sync_loop(interval: int = 60):
    from services.memory_manager.manager import sync_pending
    while True:
        time.sleep(interval)
        close_old_connections()
        try:
            n = sync_pending()
            if n:
                log.info("memory sync: indexed %s pending memories", n)
        except Exception:
            log.exception("memory sync failed")
        finally:
            close_old_connections()


def start_background_jobs():
    if _started.is_set():
        return
    _started.set()
    threading.Thread(target=_memory_sync_loop, daemon=True, name="memory-sync").start()
