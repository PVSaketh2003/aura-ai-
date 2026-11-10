"""Knowledge Galaxy: every indexed chunk projected from its 2560-dim embedding to 3-D with PCA, so the UI can draw the
user's documents as a star field where meaning = position. A question is projected into the same space and linked to
its nearest chunks (true cosine similarity in the full space, not in the projection)."""
from __future__ import annotations

import re
import threading

import numpy as np
from rest_framework.response import Response
from rest_framework.views import APIView

from services.vector_store import chroma_store as vs

_cache: dict[int, dict] = {}
_lock = threading.Lock()


def _model(user_id: int) -> dict:
    with _lock:
        n = vs.count(vs.DOCUMENTS, {"user_id": user_id})
        hit = _cache.get(user_id)
        if hit and hit["n"] == n:
            return hit
        res = vs.collection(vs.DOCUMENTS).get(where={"user_id": user_id}, include=["embeddings", "metadatas", "documents"])
        if not res["ids"]:
            m = {"n": 0, "points": [], "mean": None, "comp": None, "scale": 1.0, "E": None, "ids": []}
            _cache[user_id] = m
            return m
        E = np.asarray(res["embeddings"], dtype=np.float32)
        E /= np.linalg.norm(E, axis=1, keepdims=True) + 1e-9
        mean = E.mean(axis=0)
        X = E - mean
        _, _, vt = np.linalg.svd(X, full_matrices=False)
        comp = vt[:3]
        P = X @ comp.T
        scale = float(np.percentile(np.abs(P), 98)) or 1.0
        P = np.clip(P / scale, -1.4, 1.4)
        points = []
        for i, (cid, meta, doc) in enumerate(zip(res["ids"], res["metadatas"], res["documents"])):
            meta = meta or {}
            points.append({"id": cid, "x": round(float(P[i, 0]), 4), "y": round(float(P[i, 1]), 4), "z": round(float(P[i, 2]), 4),
                           "page": meta.get("page") or meta.get("page_number"), "doc": meta.get("document_id", ""),
                           "file": meta.get("filename") or meta.get("source") or "", "text": re.sub(r"\s+", " ", doc or "")[:180]})
        m = {"n": n, "points": points, "mean": mean, "comp": comp, "scale": scale, "E": E, "ids": res["ids"]}
        _cache[user_id] = m
        return m


class GalaxyView(APIView):
    def get(self, request):
        m = _model(request.user.id)
        return Response({"count": len(m["points"]), "points": m["points"]})

    def post(self, request):
        from services.embeddings.qwen import QwenEmbeddings
        q = (request.data.get("q") or "").strip()[:500]
        if not q:
            return Response({"detail": "q is required"}, status=400)
        m = _model(request.user.id)
        if m["E"] is None:
            return Response({"query": None, "nearest": []})
        v = np.asarray(QwenEmbeddings().embed_query(q), dtype=np.float32)
        v /= np.linalg.norm(v) + 1e-9
        p = np.clip(((v - m["mean"]) @ m["comp"].T) / m["scale"], -1.4, 1.4)
        sims = m["E"] @ v
        top = np.argsort(-sims)[:8]
        return Response({"query": {"x": float(p[0]), "y": float(p[1]), "z": float(p[2])},
                         "nearest": [{"id": m["ids"][i], "similarity": round(float(sims[i]), 4)} for i in top]})
