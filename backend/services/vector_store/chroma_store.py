"""ChromaDB vector store (persistent, local). Two separate collections act as namespaces:
`documents` for PDF chunks and `memories` for explicitly saved memories. Cosine space, fixed dimension."""
from __future__ import annotations

import threading
import time
from functools import lru_cache
from typing import Any

import chromadb
from chromadb.config import Settings as ChromaSettings

from config.env import get_settings

DOCUMENTS = "documents"
MEMORIES = "memories"
_lock = threading.Lock()


class VectorStoreError(RuntimeError):
    pass


@lru_cache
def client() -> chromadb.ClientAPI:
    path = get_settings().chroma_path
    path.mkdir(parents=True, exist_ok=True)
    return chromadb.PersistentClient(path=str(path), settings=ChromaSettings(anonymized_telemetry=False, allow_reset=False))


def collection(name: str):
    dim = get_settings().embedding_dim
    with _lock:
        col = client().get_or_create_collection(name, metadata={"hnsw:space": "cosine", "dimension": dim,
                                                               "embedding_model": get_settings().embedding_model})
    if (col.metadata or {}).get("dimension") not in (None, dim):
        raise VectorStoreError(f"Collection '{name}' was built with dimension {col.metadata['dimension']}, "
                               f"but the embedding model produces {dim}. Re-index required.")
    return col


def _retry(fn, attempts=3):
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # chroma raises assorted errors; retry transient ones
            if i == attempts - 1:
                raise VectorStoreError(f"{type(e).__name__}: {e}") from e
            time.sleep(0.5 * (i + 1))


def upsert(name: str, ids: list[str], embeddings: list[list[float]], documents: list[str],
           metadatas: list[dict[str, Any]], batch: int = 128, on_progress=None) -> int:
    col = collection(name)
    for i in range(0, len(ids), batch):
        sl = slice(i, i + batch)
        _retry(lambda: col.upsert(ids=ids[sl], embeddings=embeddings[sl], documents=documents[sl], metadatas=metadatas[sl]))
        if on_progress:
            on_progress(min(len(ids), i + batch), len(ids))
    return len(ids)


def delete_where(name: str, where: dict) -> None:
    _retry(lambda: collection(name).delete(where=where))


def delete_ids(name: str, ids: list[str]) -> None:
    if ids:
        _retry(lambda: collection(name).delete(ids=ids))


def query(name: str, embedding: list[float], k: int, where: dict | None = None, with_embeddings: bool = False) -> list[dict]:
    include = ["documents", "metadatas", "distances"] + (["embeddings"] if with_embeddings else [])
    res = _retry(lambda: collection(name).query(query_embeddings=[embedding], n_results=k, where=where, include=include))
    out = []
    for i, id_ in enumerate(res["ids"][0]):
        out.append({"id": id_, "text": res["documents"][0][i], "metadata": res["metadatas"][0][i],
                    "similarity": 1.0 - float(res["distances"][0][i]),
                    "embedding": list(res["embeddings"][0][i]) if with_embeddings else None})
    return out


def count(name: str, where: dict | None = None) -> int:
    col = collection(name)
    if where is None:
        return col.count()
    return len(col.get(where=where, include=[])["ids"])


def health() -> dict:
    t = time.perf_counter()
    try:
        info = {n: collection(n).count() for n in (DOCUMENTS, MEMORIES)}
        return {"status": "ok", "latency_ms": round((time.perf_counter() - t) * 1000, 1), "vectors": info,
                "dimension": get_settings().embedding_dim, "path": str(get_settings().chroma_path)}
    except Exception as e:
        return {"status": "down", "error": f"{type(e).__name__}: {e}"[:300]}
