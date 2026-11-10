"""Document workflows used by both the chat agent and the Library page. Each returns a TaskResult."""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import BaseModel, Field

from apps.execution_traces.tracer import StepFailed, Tracer
from apps.local_connector import bridge

from .ingestion import load_directory, new_staging_dir, process_document, register_file
from .models import Document


@dataclass
class TaskResult:
    answer: str
    documents: list[dict] = field(default_factory=list)
    extra: dict = field(default_factory=dict)


class FileRequest(BaseModel):
    filename: str | None = Field(None, description="Exact or approximate file name if the user named one")
    folder: str | None = Field(None, description="Folder name such as Documents, Downloads, Desktop or a custom folder")
    topic: str | None = Field(None, description="Subject the file should contain, if described by content")
    all_in_folder: bool = Field(False, description="True if the user wants every PDF in the folder")


_STD = {"documents": "Documents", "document": "Documents", "downloads": "Downloads", "download": "Downloads", "desktop": "Desktop"}
_FILE_RE = re.compile(r"(?:find|load|open|ingest|index|read|import|add|get|search for|locate)\s+(?:the\s+)?(?:file\s+)?[\"“']?(.+?\.pdf)\b", re.I)
_FOLDER_RE = re.compile(r"\b(?:my|the)\s+([\w\- ]{2,40}?)\s+(?:folder|directory)\b", re.I)
_TOPIC_RE = re.compile(r"\b(?:containing|contains|that has|with|about|regarding|related to|on the topic of)\s+"
                       r"(?:information\s+(?:about|on)\s+|details\s+(?:about|on)\s+)?(.+?)(?:[.?!]|$)", re.I)


def parse_file_request(text: str, *, use_llm: bool = True) -> FileRequest:
    req = FileRequest()
    if m := _FILE_RE.search(text):
        name = re.sub(r"^(?:my|the)\s+", "", m.group(1).strip(), flags=re.I)
        req.filename = re.split(r"\b(?:from|in)\s+(?:my|the)\b", name, flags=re.I)[-1].strip() if " from " in name.lower() else name
    regex_folder = None
    if m := _FOLDER_RE.search(text):
        name = re.split(r"\b(?:my|the|from|in)\s+", m.group(1), flags=re.I)[-1].strip()
        req.folder = _STD.get(name.lower(), name)
    else:
        for k, v in _STD.items():
            if re.search(rf"\b{k}\b", text, re.I):
                req.folder = v
                break
    regex_folder = req.folder
    if not req.filename and (m := _TOPIC_RE.search(text)):
        req.topic = m.group(1).strip()[:200]
    req.all_in_folder = bool(re.search(r"\b(all|every|each)\b.{0,25}\bpdfs?\b|\bpdfs\b.{0,20}\b(from|in)\b|"
                                       r"\bpdfs?\s+(files|documents|docs)\b.{0,20}\b(from|in)\b", text, re.I)) and not req.filename
    if use_llm and not (req.filename or req.topic or req.all_in_folder):
        from services.llm.structured import generate_structured
        try:
            req, _ = generate_structured(FileRequest, [
                {"role": "system", "content": "Extract which PDF(s) the user wants from their Mac. Return JSON."},
                {"role": "user", "content": text}], temperature=0, max_tokens=150)
        except Exception:
            pass
        # Small models invent plausible names ("document1.pdf"): keep a filename only if the user actually said it.
        if req.filename:
            stem = re.sub(r"\.pdf$", "", req.filename, flags=re.I)
            words = [w for w in re.findall(r"\w{3,}", stem.lower()) if w not in ("pdf", "file", "files", "document", "documents")]
            if not words or not any(w in text.lower() for w in words):
                req.filename = None
        if not req.folder:
            req.folder = regex_folder
    return req


def _transfer(tracer: Tracer, user_id: int, files: list[dict], staging: Path) -> list[tuple[dict, Path]]:
    out = []
    with tracer.step("transfer", f"Transferring {len(files)} file(s) securely") as s:
        for f in files:
            res = bridge.call(user_id, "read", {"path": f["path"]}, timeout=180)
            dest = staging / Path(res["staged_path"]).name
            shutil.move(res["staged_path"], dest)
            out.append((res, dest))
        s.set(f"{len(out)} file(s) · {sum(r['size'] for r, _ in out) / 1e6:.1f} MB · SHA-256 verified")
    return out


def _connect(tracer: Tracer, user_id: int) -> None:
    with tracer.step("local_agent", "Connecting to Local Mac Agent") as s:
        try:
            info = bridge.call(user_id, "roots", timeout=10)
        except (bridge.AgentOffline, bridge.AgentError) as e:
            raise StepFailed(str(e)) from e
        ok = [r["name"] for r in info["roots"] if r["accessible"]]
        blocked = [r for r in info["roots"] if not r["accessible"]]
        s.set(f"Connected · access to {', '.join(ok) or 'no folders'}" + (f" · {len(blocked)} blocked by macOS" if blocked else ""),
              roots=info["roots"])
        if not ok:
            raise StepFailed(blocked[0]["error"] if blocked else "No authorized folders are available.")


def _ingest_one(tracer: Tracer, user, staged: Path, meta: dict, source: str) -> Document:
    doc, new = register_file(tracer, user, staged, filename=meta.get("name") or staged.name, source=source,
                             source_path=meta.get("display", ""), source_directory=meta.get("root", ""))
    return process_document(tracer, doc) if new else doc


def locate_files(tracer: Tracer, user_id: int, req: FileRequest) -> list[dict]:
    root = req.folder if req.folder in ("Documents", "Downloads", "Desktop") else None
    if req.folder and not root and (req.all_in_folder or not req.filename):
        with tracer.step("find_folder", f"Locating folder “{req.folder}”") as s:
            dirs = bridge.call(user_id, "find_directory", {"name": req.folder})["results"]
            if not dirs:
                raise StepFailed(f"I couldn't find a folder named “{req.folder}” in your authorized folders.")
            s.set(f"Found {dirs[0]['display']}")
        with tracer.step("list_files", f"Listing PDFs in {dirs[0]['display']}") as s:
            res = bridge.call(user_id, "list", {"path": dirs[0]["path"]})
            s.set(f"{res['total']} PDF(s)" + (" (showing first 200)" if res["truncated"] else ""))
            return res["results"]
    if req.all_in_folder and root:
        with tracer.step("list_files", f"Listing PDFs in {root}") as s:
            res = bridge.call(user_id, "list", {"path": root})
            s.set(f"{res['total']} PDF(s)")
            return res["results"]
    if req.filename:
        where = root or "authorized folders"
        with tracer.step("file_search", f"Searching {where} for “{req.filename}”") as s:
            res = bridge.call(user_id, "search", {"query": req.filename, "root": root}, timeout=40)
            hits = res["results"]
            s.set(f"{len(hits)} match(es) among {res['scanned']} PDFs" + (f" · best: {hits[0]['display']}" if hits else ""),
                  matches=[h["display"] for h in hits[:5]])
            return hits
    if req.topic:
        with tracer.step("content_search", f"Searching PDF contents for “{req.topic}”") as s:
            res = bridge.call(user_id, "search_content", {"topic": req.topic, "root": root}, timeout=40)
            s.set(f"{len(res['results'])} PDF(s) mention {', '.join(res.get('terms', []))} (Spotlight index)",
                  matches=[h["display"] for h in res["results"][:5]])
            return res["results"]
    raise StepFailed("I couldn't tell which file you mean. Try e.g. “load Machine Learning Notes.pdf from Documents”.")


def find_on_mac(tracer: Tracer, user, text: str) -> TaskResult:
    _connect(tracer, user.id)
    with tracer.step("parse_request", "Understanding the file request") as s:
        req = parse_file_request(text)
        if req.folder and not (req.filename or req.topic):
            req.all_in_folder = True  # "find PDFs in Documents" → list them (finding only; never used for loading)
        s.set(", ".join(f"{k}: {v}" for k, v in req.model_dump().items() if v) or "nothing specific", **req.model_dump())
    hits = locate_files(tracer, user.id, req)
    if not hits:
        return TaskResult("I couldn't find any matching PDFs in your authorized folders.")
    lines = "\n".join(f"- **{h['name']}** — {h['display']} ({h['size'] / 1e6:.1f} MB)" for h in hits[:10])
    return TaskResult(f"I found {len(hits)} matching PDF(s):\n\n{lines}\n\nSay “load” followed by a name to index one.",
                      extra={"files": hits[:10]})


def ingest_from_mac(tracer: Tracer, user, text: str = "", query: str = "", path: str = "", directory: str = "") -> TaskResult:
    _connect(tracer, user.id)
    if path:
        with tracer.step("file_search", "Locating requested file") as s:
            meta = bridge.call(user.id, "stat", {"path": path})
            s.set(meta["display"])
        files = [meta]
    else:
        with tracer.step("parse_request", "Understanding the file request") as s:
            req = parse_file_request(text or query or "")
            if directory:
                req.folder, req.all_in_folder = directory, True
            s.set(", ".join(f"{k}: {v}" for k, v in req.model_dump().items() if v) or "nothing specific", **req.model_dump())
        hits = locate_files(tracer, user.id, req)
        if not hits:
            target = req.filename or req.topic or req.folder
            raise StepFailed(f"I couldn't find “{target}” in your authorized folders.")
        files = hits if req.all_in_folder else [hits[0]]
        if not req.all_in_folder and req.filename and hits[0]["score"] < 0.75:
            raise StepFailed(f"No exact match for “{req.filename}”. Closest: " + ", ".join(h["display"] for h in hits[:3]))

    staging = new_staging_dir()
    try:
        transferred = _transfer(tracer, user.id, files[:50], staging)
        docs, failures = [], []
        if len(transferred) == 1:
            meta, p = transferred[0]
            docs.append(_ingest_one(tracer, user, p, meta, Document.Source.LOCAL_AGENT))
        else:
            reports = load_directory(tracer, staging)
            for meta, p in transferred:
                rep = reports.get(str(p))
                if not rep or not rep["ok"]:
                    failures.append(f"{meta['name']}: {rep['error'] if rep else 'not loaded'}")
                    continue
                try:
                    doc, new = register_file(tracer, user, p, filename=meta["name"], source=Document.Source.LOCAL_AGENT,
                                             source_path=meta["display"], source_directory=meta["root"])
                    docs.append(process_document(tracer, doc, preloaded=rep) if new else doc)
                except StepFailed as e:
                    failures.append(f"{meta['name']}: {e}")
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    if not docs:
        raise StepFailed("No documents were loaded. " + "; ".join(failures[:3]))
    lines = "\n".join(f"- **{d.filename}** — {d.page_count} pages, {d.chunk_count} chunks via {d.loader}" for d in docs)
    msg = f"Document loaded successfully.\n\n{lines}" if len(docs) == 1 else f"Loaded {len(docs)} documents successfully.\n\n{lines}"
    if failures:
        msg += "\n\nCouldn't load:\n" + "\n".join(f"- {f}" for f in failures)
    return TaskResult(msg, documents=[{"document_id": str(d.id), "filename": d.filename} for d in docs])


def ingest_uploaded(tracer: Tracer, user, staged: str, filename: str) -> TaskResult:
    p = Path(staged)
    try:
        doc = _ingest_one(tracer, user, p, {"name": filename}, Document.Source.UPLOAD)
    finally:
        shutil.rmtree(p.parent, ignore_errors=True)
    return TaskResult(f"Document loaded successfully: **{doc.filename}** — {doc.page_count} pages, {doc.chunk_count} chunks via {doc.loader}.",
                      documents=[{"document_id": str(doc.id), "filename": doc.filename}])


def reindex(tracer: Tracer, user, document_id: str) -> TaskResult:
    doc = Document.objects.get(pk=document_id, user=user)
    doc = process_document(tracer, doc, reindex=True)
    return TaskResult(f"Re-indexed **{doc.filename}**: {doc.chunk_count} chunks.",
                      documents=[{"document_id": str(doc.id), "filename": doc.filename}])
