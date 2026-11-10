"""Document ingestion pipeline. Every stage is a traced step; document state is persisted as it progresses."""
from __future__ import annotations

import hashlib
import shutil
import tempfile
from pathlib import Path

from django.db import transaction
from django.utils import timezone

from apps.core.models import audit
from apps.execution_traces.tracer import StepFailed, Tracer, broadcast
from config.env import get_settings
from services.chunking.chunker import chunk_blocks
from services.document_loaders.inspector import inspect_pdf
from services.document_loaders.loaders import (AutoPDFLoader, ExtractionError, PageBlock, extract, ocr_pages,
                                               select_loader)
from services.embeddings.qwen import EmbeddingError, QwenEmbeddings
from services.vector_store import chroma_store as vs

from .models import Chunk, Document

PDF_MAGIC = b"%PDF-"


def media_dir() -> Path:
    d = get_settings().media_root / "documents"
    d.mkdir(parents=True, exist_ok=True)
    return d


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def validate_pdf_file(path: Path) -> None:
    size = path.stat().st_size
    if size == 0:
        raise StepFailed("The file is empty.")
    if size > get_settings().max_pdf_bytes:
        raise StepFailed(f"File is {size / 1e6:.0f} MB; the limit is {get_settings().max_pdf_bytes / 1e6:.0f} MB.")
    with open(path, "rb") as f:
        if not f.read(1024).lstrip().startswith(PDF_MAGIC):
            raise StepFailed("This file is not a valid PDF (missing %PDF header).")


def emit_document(doc: Document) -> None:
    from .serializers import DocumentSerializer
    broadcast(doc.user_id, {"kind": "document.updated", "document": DocumentSerializer(doc).data})


def _set(doc: Document, **fields) -> None:
    for k, v in fields.items():
        setattr(doc, k, v)
    doc.save(update_fields=[*fields.keys(), "updated_at"])
    emit_document(doc)


def register_file(tracer: Tracer, user, staged: Path, *, filename: str, source: str, source_path: str = "",
                  source_directory: str = "") -> tuple[Document, bool]:
    """Validate, hash and store the file. Returns (document, is_new)."""
    with tracer.step("dedupe", "Checking for duplicates") as s:
        validate_pdf_file(staged)
        digest = sha256_file(staged)
        existing = Document.objects.filter(user=user, content_hash=digest).first()
        if existing and existing.status == Document.Status.INDEXED:
            s.set(f"Already indexed as “{existing.filename}” — skipped re-ingestion", document_id=str(existing.id),
                  content_hash=digest[:12])
            return existing, False
        dest = media_dir() / f"{digest}.pdf"
        if not dest.exists():
            shutil.copyfile(staged, dest)
        if existing:
            doc = existing
            doc.status, doc.error = Document.Status.PENDING, ""
            doc.save(update_fields=["status", "error", "updated_at"])
        else:
            doc = Document.objects.create(user=user, filename=filename[:512], source=source, source_path=source_path[:2048],
                                          source_directory=source_directory[:256], content_hash=digest,
                                          size_bytes=staged.stat().st_size, stored_file=dest.name)
        s.set(f"New document · sha256 {digest[:12]}…", document_id=str(doc.id))
    emit_document(doc)
    audit(user, "document.registered", doc.filename, document_id=str(doc.id), source=source, path=source_path)
    return doc, True


class Progress:
    """Real in-stage progress → `ingest.progress` WebSocket events (throttled to ~6/s; the final value always goes out).
    Every event carries a per-run sequence number so the browser can drop duplicates and out-of-order deliveries."""

    def __init__(self, tracer: Tracer, doc: Document, stage: str, unit: str):
        self.tracer, self.doc, self.stage, self.unit = tracer, doc, stage, unit
        self.last = 0.0
        self.state: dict = {}

    def __call__(self, done: int, total: int, **extra) -> None:
        import time as _t
        self.state = {"done": done, "total": total, **extra}
        now = _t.monotonic()
        if done < total and now - self.last < 0.16:
            return
        self.last = now
        from apps.execution_traces.views import LAST_PROGRESS
        LAST_PROGRESS.setdefault(str(self.tracer.run.id), {})[self.stage] = {"unit": self.unit, **self.state}
        self.tracer.emit("ingest.progress", document_id=str(self.doc.id), filename=self.doc.filename, stage=self.stage,
                         unit=self.unit, seq=_next_seq(self.tracer), ts=_t.time(), **self.state)


def _next_seq(tracer: Tracer) -> int:
    tracer._progress_seq = getattr(tracer, "_progress_seq", 0) + 1
    return tracer._progress_seq


def process_document(tracer: Tracer, doc: Document, *, reindex: bool = False, preloaded: dict | None = None) -> Document:
    """Inspect → select loader → extract → OCR → chunk → embed → store vectors → save metadata."""
    path = str(media_dir() / doc.stored_file)
    _set(doc, status=Document.Status.PROCESSING, error="", embedding_status="pending", index_status="pending")
    label = doc.filename if len(doc.filename) < 40 else doc.filename[:37] + "…"
    try:
        if preloaded:  # already extracted by DirectoryLoader
            insp_dict, loader, reason = preloaded["inspection"], preloaded["loader"], preloaded["reason"]
            blocks: list[PageBlock] = preloaded["blocks"]
            with tracer.step("loader", f"Loader selected · {label}") as s:
                s.set(f"{loader} — {reason}", loader=loader)
            _set(doc, page_count=insp_dict["pages"], inspection=insp_dict, loader=loader, loader_reason=reason[:500])
        else:
            with tracer.step("inspect", f"Inspecting PDF · {label}") as s:
                try:
                    insp = inspect_pdf(path)
                except Exception as e:
                    raise StepFailed(f"Could not open PDF: {e}") from e
                bits = [f"{insp.pages} pages", f"{insp.text_pages} with text"]
                if insp.scanned_pages:
                    bits.append(f"{len(insp.scanned_pages)} scanned")
                if insp.table_pages:
                    bits.append(f"tables on {len(insp.table_pages)}")
                if insp.multicolumn_pages:
                    bits.append(f"{len(insp.multicolumn_pages)} multi-column")
                s.set(" · ".join(bits), **insp.as_dict())
            with tracer.step("loader", "Selecting PDF loader") as s:
                try:
                    choice = select_loader(insp)
                except ExtractionError as e:
                    raise StepFailed(str(e)) from e
                s.set(f"{choice.loader} — {choice.reason}", loader=choice.loader)
            _set(doc, page_count=insp.pages, inspection=insp.as_dict(), loader=choice.loader, loader_reason=choice.reason[:500])
            with tracer.step("extract", f"Extracting content with {choice.loader}") as s:
                prog = Progress(tracer, doc, "extract", "pages")
                try:
                    blocks = extract(path, choice, insp, on_page=prog)
                except ExtractionError as e:
                    raise StepFailed(str(e)) from e
                tables = sum(1 for b in blocks if b.kind == "table")
                chars = sum(len(b.text) for b in blocks)
                s.set(f"{len({b.page for b in blocks})} pages · {chars:,} chars"
                      + (f" · {tables} tables" if tables else ""), pages=insp.pages, pages_with_text=len({b.page for b in blocks}),
                      chars=chars, tables=tables, loader=choice.loader)
            if choice.ocr_pages:
                with tracer.step("ocr", f"Running OCR on {len(choice.ocr_pages)} scanned page(s)") as s:
                    ocr = ocr_pages(path, choice.ocr_pages, on_page=Progress(tracer, doc, "ocr", "pages"))
                    blocks += ocr
                    s.set(f"Recovered text on {len(ocr)}/{len(choice.ocr_pages)} pages (Tesseract)", pages=len(choice.ocr_pages),
                          recovered=len(ocr), engine="Tesseract")

        if not any(b.text.strip() for b in blocks):
            raise StepFailed("No text could be extracted from this PDF, even with OCR.")

        emb = QwenEmbeddings()
        forced = doc.chunking_config.get("strategy") if reindex else None
        with tracer.step("chunking", "Splitting document into chunks") as s:
            try:
                chunks, config = chunk_blocks(blocks, embeddings=emb, forced=forced)
            except EmbeddingError:
                chunks, config = chunk_blocks(blocks, embeddings=None, forced="recursive")
            config["embedding_model"] = emb.model
            lens = [len(c.text) for c in chunks]
            s.set(f"{len(chunks)} chunks · {config['strategy']} — {config['reason']}", **{**{k: v for k, v in config.items() if k != "separators"},
                  "chunks": len(chunks)}, input_chars=sum(len(b.text) for b in blocks), chunk_chars=sum(lens),
                  min_chars=min(lens) if lens else 0, max_chars=max(lens) if lens else 0,
                  avg_chars=int(sum(lens) / len(lens)) if lens else 0, lengths=lens[:48],
                  table_chunks=sum(1 for c in chunks if c.kind == "table"),
                  previews=[c.text[:90] for c in chunks[:6]])

        with tracer.step("embedding", f"Generating embeddings with {emb.model}") as s:
            emb.on_progress = Progress(tracer, doc, "embedding", "chunks")
            try:
                vectors = emb.embed_documents([c.text for c in chunks])
            except EmbeddingError as e:
                _set(doc, embedding_status="failed")
                s.set(f"Embedding failed after {emb.on_progress.state.get('done', 0)} of {len(chunks)} chunks",
                      embedded=emb.on_progress.state.get("done", 0), failed=len(chunks) - emb.on_progress.state.get("done", 0),
                      model=emb.model, dim=emb.dim)
                raise StepFailed(str(e)) from e
            finally:
                emb.on_progress = None
            s.set(f"{len(vectors)} vectors · {emb.dim} dims · {emb.last_stats['ms'] / 1000:.1f}s", **emb.last_stats,
                  model=emb.model, embedded=len(vectors), failed=0, batch=emb.batch)
        _set(doc, embedding_status="completed")

        ids = [f"{doc.id}:{i}" for i in range(len(chunks))]
        now = timezone.now().isoformat()
        with tracer.step("vector_store", "Storing vectors in ChromaDB") as s:
            try:
                vs.delete_where(vs.DOCUMENTS, {"document_id": str(doc.id)})
                vs.upsert(vs.DOCUMENTS, ids, vectors, [c.text for c in chunks], on_progress=Progress(tracer, doc, "vector_store", "vectors"), metadatas=[{
                    "document_id": str(doc.id), "user_id": doc.user_id, "filename": doc.filename,
                    "page_number": c.page, "page_end": c.page_end, "chunk_id": ids[i], "chunk_index": i,
                    "kind": c.kind, "source_path": doc.source_path, "creation_timestamp": now,
                } for i, c in enumerate(chunks)])
            except vs.VectorStoreError as e:
                _set(doc, index_status="failed")
                raise StepFailed(f"ChromaDB upsert failed: {e}") from e
            stored = vs.count(vs.DOCUMENTS, {"document_id": str(doc.id)})
            if stored != len(ids):
                _set(doc, index_status="failed")
                raise StepFailed(f"ChromaDB reports {stored} stored vectors, expected {len(ids)}")
            s.set(f"{len(ids)} vectors upserted to “{vs.DOCUMENTS}” collection · verified", collection=vs.DOCUMENTS,
                  stored=stored, expected=len(ids))

        with tracer.step("metadata", "Saving metadata in PostgreSQL") as s:
            with transaction.atomic():
                Chunk.objects.filter(document=doc).delete()
                Chunk.objects.bulk_create([Chunk(id=ids[i], document=doc, index=i, page_number=c.page, page_end=c.page_end,
                                                 text=c.text, kind=c.kind) for i, c in enumerate(chunks)], batch_size=500)
                _set(doc, chunk_count=len(chunks), chunking_config=config, embedding_model=emb.model,
                     index_status="completed", status=Document.Status.INDEXED, indexed_at=timezone.now())
            s.set(f"Document, {len(chunks)} chunks and chunking config saved")
        audit(doc.user, "document.indexed", doc.filename, document_id=str(doc.id), chunks=len(chunks))
        return doc
    except StepFailed as e:
        _set(doc, status=Document.Status.FAILED, error=str(e)[:2000])
        raise
    except Exception as e:
        _set(doc, status=Document.Status.FAILED, error=f"{type(e).__name__}: {e}"[:2000])
        raise


def load_directory(tracer: Tracer, staged_dir: Path) -> dict[str, dict]:
    """Batch extraction with LangChain's DirectoryLoader; AutoPDFLoader picks a loader per file."""
    from langchain_community.document_loaders import DirectoryLoader

    with tracer.step("directory_loader", "Loading PDFs with DirectoryLoader") as s:
        AutoPDFLoader.reports = {}
        DirectoryLoader(str(staged_dir), glob="**/*.pdf", loader_cls=AutoPDFLoader, silent_errors=True,
                        use_multithreading=False, show_progress=False).load()
        reports = dict(AutoPDFLoader.reports)
        ok = sum(1 for r in reports.values() if r["ok"])
        s.set(f"{ok}/{len(reports)} files extracted" + (f" · {len(reports) - ok} failed" if ok < len(reports) else ""),
              files={Path(k).name: (v.get("loader") if v["ok"] else v["error"]) for k, v in reports.items()})
    return reports


def new_staging_dir() -> Path:
    d = get_settings().media_root / "staging"
    d.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(dir=d))


def delete_document(doc: Document) -> None:
    vs.delete_where(vs.DOCUMENTS, {"document_id": str(doc.id)})
    stored = media_dir() / doc.stored_file
    others = Document.objects.filter(stored_file=doc.stored_file).exclude(pk=doc.pk).exists()
    audit(doc.user, "document.deleted", doc.filename, document_id=str(doc.id))
    doc.delete()
    if not others:
        stored.unlink(missing_ok=True)  # server-side copy only; the original on the Mac is never touched
