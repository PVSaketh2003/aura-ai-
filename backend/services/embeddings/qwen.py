"""Qwen3-Embedding-4B served by Ollama (Metal). Implements LangChain's Embeddings interface.

Qwen3-Embedding is instruction-aware: queries get a task instruction, documents are embedded raw.
The same model, normalization and dimension are used for both, so vectors are directly comparable.
"""
from __future__ import annotations

import math
import threading
import time
from collections import OrderedDict

import httpx

from services.llm.ollama import auth_headers
from langchain_core.embeddings import Embeddings

from config.env import get_settings

QUERY_INSTRUCTION = "Given a user question, retrieve passages from personal documents or notes that answer it"
MEMORY_INSTRUCTION = "Given a user question, retrieve personal facts the user previously asked to remember"


# Question-time embeddings keep the model warm (a cold load of the 4B embedder costs 3-5 s on every question).
# Large ingestion batches still unload the chat model first, so the two never fight for memory while indexing.
QUERY_KEEP_ALIVE = "15m"

# Small per-process cache: the same question is embedded for memory search and document search, and MultiQuery
# and re-asks hit it too. Keyed by the exact instruction-prefixed text.
_CACHE: "OrderedDict[str, list[float]]" = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_MAX = 128


def _cache_get(key: str) -> list[float] | None:
    with _CACHE_LOCK:
        v = _CACHE.get(key)
        if v is not None:
            _CACHE.move_to_end(key)
        return v


def _cache_put(key: str, v: list[float]) -> None:
    with _CACHE_LOCK:
        _CACHE[key] = v
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)


class EmbeddingError(RuntimeError):
    pass


def _normalize(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class QwenEmbeddings(Embeddings):
    def __init__(self, instruction: str = QUERY_INSTRUCTION):
        s = get_settings()
        self.model = s.embedding_model
        self.dim = s.embedding_dim
        self.batch = s.embedding_batch_size
        prov = (s.embedding_provider or s.llm_provider).lower()
        self.cloud = prov == "openai"
        if self.cloud:  # OpenAI-compatible /embeddings (on Render, where Ollama can't run)
            base = (s.embedding_base_url or s.llm_base_url).rstrip("/")
            key = s.embedding_api_key or s.llm_api_key
            self.url, self.headers = base + "/embeddings", ({"Authorization": f"Bearer {key}"} if key else {})
        else:
            self.url, self.headers = s.ollama_base_url.rstrip("/") + "/api/embed", auth_headers()
        self.instruction = instruction
        self.last_stats: dict = {}

    def _embed(self, texts: list[str], attempts: int = 3, keep_alive: str = "60s") -> list[list[float]]:
        out: list[list[float]] = []
        t0 = time.perf_counter()
        for i in range(0, len(texts), self.batch):
            batch = [t[:8000] for t in texts[i:i + self.batch]]
            for attempt in range(attempts):
                try:
                    body = {"model": self.model, "input": batch} if self.cloud else {"model": self.model, "input": batch, "keep_alive": keep_alive}
                    r = httpx.post(self.url, json=body, timeout=300, headers=self.headers)
                    if not self.cloud and (r.status_code == 404 or "not found" in r.text[:200].lower()):
                        raise EmbeddingError(f"Embedding model '{self.model}' is not installed. Run: ollama pull {self.model}")
                    r.raise_for_status()
                    vecs = [d["embedding"] for d in sorted(r.json()["data"], key=lambda d: d.get("index", 0))] if self.cloud else r.json()["embeddings"]
                    break
                except EmbeddingError:
                    raise
                except (httpx.HTTPError, KeyError) as e:
                    if attempt == attempts - 1:
                        raise EmbeddingError(f"Embedding request failed: {type(e).__name__}: {e}") from e
                    time.sleep(1.5 * (attempt + 1))
            for v in vecs:
                if len(v) != self.dim:
                    raise EmbeddingError(f"Embedding dimension {len(v)} does not match configured {self.dim}.")
                out.append(_normalize(v))
        self.last_stats = {"count": len(texts), "ms": int((time.perf_counter() - t0) * 1000), "dim": self.dim}
        return out

    def _free_chat_model(self) -> None:
        """Large batches: unload the chat model first. On a 16 GB Mac, the 8B chat model and the 4B embedder
        together push the system into swap and slow both down by an order of magnitude; the chat model
        reloads from disk in seconds when the next question arrives."""
        s = get_settings()
        if self.cloud or s.llm_provider.lower() == "openai":
            return  # nothing to unload on a cloud API
        try:
            httpx.post(f"{s.ollama_base_url.rstrip('/')}/api/generate", json={"model": s.llm_model, "keep_alive": 0}, timeout=15, headers=auth_headers())
        except httpx.HTTPError:
            pass

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if len(texts) > 64:
            self._free_chat_model()
        cb = getattr(self, "on_progress", None)
        if not cb:
            return self._embed(texts)
        out: list[list[float]] = []
        t0 = time.perf_counter()
        for i in range(0, len(texts), self.batch):  # batch by batch, so progress is the real embedded count
            out += self._embed(texts[i:i + self.batch])
            cb(len(out), len(texts))
        self.last_stats = {"count": len(texts), "ms": int((time.perf_counter() - t0) * 1000), "dim": self.dim}
        return out

    def _q(self, text: str, instruction: str | None = None) -> str:
        return f"Instruct: {instruction or self.instruction}\nQuery: {text}"

    def cached_query(self, text: str) -> list[float] | None:
        return _cache_get(self._q(text))

    def embed_query(self, text: str) -> list[float]:
        key = self._q(text)
        hit = _cache_get(key)
        if hit is not None:
            self.last_stats = {"count": 1, "ms": 0, "dim": self.dim, "cached": True}
            return hit
        v = self._embed([key], keep_alive=QUERY_KEEP_ALIVE)[0]
        _cache_put(key, v)
        return v

    def embed_queries(self, texts: list[str]) -> list[list[float]]:
        keys = [self._q(t) for t in texts]
        missing = [k for k in dict.fromkeys(keys) if _cache_get(k) is None]
        if missing:
            for k, v in zip(missing, self._embed(missing, keep_alive=QUERY_KEEP_ALIVE)):
                _cache_put(k, v)
        return [_cache_get(k) for k in keys]  # type: ignore[misc]

    def embed_for(self, text: str, instructions: list[str]) -> list[list[float]]:
        """One HTTP round-trip for the same question under several instructions (documents + memories)."""
        keys = [self._q(text, ins) for ins in instructions]
        missing = [k for k in dict.fromkeys(keys) if _cache_get(k) is None]
        t0 = time.perf_counter()
        if missing:
            for k, v in zip(missing, self._embed(missing, keep_alive=QUERY_KEEP_ALIVE)):
                _cache_put(k, v)
        self.last_stats = {"count": len(missing), "ms": int((time.perf_counter() - t0) * 1000), "dim": self.dim,
                           "cached": not missing}
        return [_cache_get(k) for k in keys]  # type: ignore[misc]


def vector_preview(v: list[float], buckets: int = 96) -> list[float]:
    """Downsample a vector for display: mean of each bucket, scaled to [-1, 1]. Purely visual."""
    n = len(v)
    step = n / buckets
    out = [sum(v[int(i * step):int((i + 1) * step)]) / max(1, int((i + 1) * step) - int(i * step)) for i in range(buckets)]
    m = max(abs(x) for x in out) or 1.0
    return [round(x / m, 3) for x in out]
