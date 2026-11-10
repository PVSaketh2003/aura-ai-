"""Filename search (fuzzy, local walk) and content search (macOS Spotlight via mdfind, no shell)."""
from __future__ import annotations

import re
import subprocess
import time
from difflib import SequenceMatcher
from pathlib import Path

from local_agent.config import AgentConfig
from local_agent.file_access.guard import AccessDenied, describe, root_for, walk

STOP = {"the", "a", "an", "my", "pdf", "file", "document", "of", "and", "for", "notes"}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def _score(query: str, name: str) -> float:
    q, n = _norm(query.removesuffix(".pdf")), _norm(Path(name).stem)
    if not q:
        return 0.0
    if q == n:
        return 1.0
    qt, nt = set(q.split()) - STOP or set(q.split()), set(n.split())
    overlap = len(qt & nt) / len(qt)
    return round(0.6 * overlap + 0.4 * SequenceMatcher(None, q, n).ratio(), 3)


def _roots(cfg: AgentConfig, root: str | None):
    rs = cfg.active_roots
    if root:
        rs = [r for r in rs if r.name.lower() == root.lower()]
        if not rs:
            raise AccessDenied(f"'{root}' is not an authorized folder.")
    return rs


def search_files(cfg: AgentConfig, query: str, root: str | None = None, limit: int = 10, budget_s: float = 8.0) -> dict:
    t0, scanned, hits = time.monotonic(), 0, []
    for r in _roots(cfg, root):
        for dirpath, _, files in walk(r.path):
            for f in files:
                if not f.lower().endswith(".pdf") or f.startswith("."):
                    continue
                scanned += 1
                s = _score(query, f)
                if s >= 0.45:
                    p = dirpath / f
                    hits.append({**describe(cfg, p, r), "score": s})
            if time.monotonic() - t0 > budget_s:
                break
    hits.sort(key=lambda h: (-h["score"], -h["modified"]))
    return {"results": hits[:limit], "scanned": scanned, "truncated": time.monotonic() - t0 > budget_s}


def search_content(cfg: AgentConfig, topic: str, root: str | None = None, limit: int = 10) -> dict:
    words = [w for w in re.findall(r"[A-Za-z0-9ऀ-෿]{3,}", topic) if w.lower() not in STOP][:6]
    if not words:
        return {"results": [], "engine": "spotlight"}
    clauses = " && ".join(f'kMDItemTextContent == "*{w}*"cd' for w in words)
    query = f'kMDItemContentTypeTree == "com.adobe.pdf" && ({clauses})'
    results = []
    for r in _roots(cfg, root):
        try:
            out = subprocess.run(["/usr/bin/mdfind", "-onlyin", str(r.path), query], capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            continue
        for line in out.stdout.splitlines():
            p = Path(line).resolve()
            rr = root_for(cfg, p)
            if rr and p.suffix.lower() == ".pdf" and not any(x.startswith(".") for x in p.relative_to(rr.path).parts):
                results.append({**describe(cfg, p, rr), "score": 0.7})
    results.sort(key=lambda h: -h["modified"])
    return {"results": results[:limit], "engine": "spotlight", "terms": words}


def find_directory(cfg: AgentConfig, name: str, limit: int = 5) -> dict:
    hits = []
    for r in cfg.active_roots:
        if _norm(r.name) == _norm(name):
            hits.append({**describe(cfg, r.path, r), "score": 1.0})
        for dirpath, dirnames, _ in walk(r.path, max_depth=5):
            for d in dirnames:
                s = _score(name, d)
                if s >= 0.7:
                    hits.append({**describe(cfg, dirpath / d, r), "score": s})
    hits.sort(key=lambda h: -h["score"])
    return {"results": hits[:limit]}


def list_pdfs(cfg: AgentConfig, directory: Path, limit: int = 200) -> dict:
    r = root_for(cfg, directory)
    files = []
    for dirpath, _, fs in walk(directory, max_depth=4):
        for f in fs:
            if f.lower().endswith(".pdf") and not f.startswith("."):
                files.append(describe(cfg, dirpath / f, r))
    files.sort(key=lambda x: x["display"])
    return {"results": files[:limit], "total": len(files), "truncated": len(files) > limit}
