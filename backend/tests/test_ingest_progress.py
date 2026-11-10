"""Live document-processing journey: the real ingestion pipeline emits ordered, owner-scoped progress events and
persists real statistics for every stage; failures are reported as failures."""
import pytest

from apps.documents import tasks
from apps.documents.models import Document
from apps.execution_traces.models import ExecutionRun, Status
from apps.execution_traces.tracer import StepFailed, Tracer

from .test_documents_pipeline import make_pdf

pytestmark = pytest.mark.django_db


@pytest.fixture
def events(monkeypatch):
    got = []
    monkeypatch.setattr("apps.execution_traces.tracer.broadcast", lambda uid, e: got.append((uid, e)))
    return got


def _run(user):
    r = ExecutionRun.objects.create(user=user, input_text="Upload notes.pdf", intent="task")
    t = Tracer(r)
    t.start()
    return r, t


def test_upload_emits_real_stage_progress_and_stats(user, fake_embeddings, temp_chroma, events, tmp_path):
    pages = [("Backpropagation computes gradients of the loss for every weight. " * 30), ("Gradient descent updates weights. " * 30),
             ("Dropout and weight decay reduce overfitting. " * 30)]
    staged = tmp_path / "stage" / "notes.pdf"
    staged.parent.mkdir()
    make_pdf(staged, pages)
    run, tracer = _run(user)
    tasks.ingest_uploaded(tracer, user, staged=str(staged), filename="notes.pdf")
    tracer.finish(Status.COMPLETED)
    steps = {s.key: s for s in run.steps.all()}
    assert [k for k in ["dedupe", "inspect", "loader", "extract", "chunking", "embedding", "vector_store", "metadata"]] == \
        [s.key for s in run.steps.order_by("seq")]
    assert all(s.status == Status.COMPLETED for s in steps.values())
    assert "ocr" not in steps  # OCR is only a stage when the backend actually runs it
    ch, em, vs = steps["chunking"].detail, steps["embedding"].detail, steps["vector_store"].detail
    doc = Document.objects.get(user=user, filename="notes.pdf")
    assert ch["chunks"] == doc.chunk_count == len(ch["lengths"]) and ch["strategy"] and sum(ch["lengths"]) == ch["chunk_chars"]
    assert em["embedded"] == ch["chunks"] and em["failed"] == 0 and em["dim"] == 2560 and em["model"]
    assert vs["stored"] == vs["expected"] == ch["chunks"] and vs["collection"] == "documents"
    assert steps["extract"].detail["pages"] == 3 and steps["extract"].detail["chars"] > 0

    prog = [e for uid, e in events if e["kind"] == "ingest.progress"]
    assert all(uid == user.id for uid, e in events)  # every event goes to the owner's group only
    seqs = [e["seq"] for e in prog]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    by = {}
    for e in prog:
        by.setdefault(e["stage"], []).append(e)
    assert by["extract"][-1]["done"] == by["extract"][-1]["total"] == 3
    assert by["embedding"][-1]["done"] == by["embedding"][-1]["total"] == ch["chunks"]
    assert by["vector_store"][-1]["done"] == ch["chunks"]
    for stage in by.values():  # progress never goes backwards
        assert [e["done"] for e in stage] == sorted(e["done"] for e in stage)


def test_embedding_failure_is_a_failed_stage_not_a_ready_document(user, temp_chroma, events, tmp_path, monkeypatch):
    from services.embeddings.qwen import EmbeddingError, QwenEmbeddings

    def down(self, texts, attempts=3, keep_alive="60s"):
        raise EmbeddingError("Embedding request failed: ConnectError")
    monkeypatch.setattr(QwenEmbeddings, "_embed", down)
    staged = tmp_path / "s" / "x.pdf"
    staged.parent.mkdir()
    make_pdf(staged, ["Some text about kernels. " * 40])
    run, tracer = _run(user)
    with pytest.raises(StepFailed):
        tasks.ingest_uploaded(tracer, user, staged=str(staged), filename="x.pdf")
    emb = run.steps.get(key="embedding")
    assert emb.status == Status.FAILED and "ConnectError" in emb.error
    assert not run.steps.filter(key="vector_store").exists()
    doc = Document.objects.get(user=user, filename="x.pdf")
    assert doc.status == Document.Status.FAILED and doc.embedding_status == "failed"


def test_active_runs_endpoint_restores_progress_for_the_owner_only(api, user, django_user_model):
    from rest_framework.test import APIClient

    from apps.execution_traces.views import LAST_PROGRESS
    r = ExecutionRun.objects.create(user=user, input_text="Upload a.pdf", intent="task", status=Status.RUNNING)
    LAST_PROGRESS[str(r.id)] = {"embedding": {"unit": "chunks", "done": 16, "total": 40}}
    data = api.get("/api/agent/runs/active/").json()
    mine = next(x for x in data if x["id"] == str(r.id))
    assert mine["progress"]["embedding"]["done"] == 16
    other = APIClient()
    other.force_authenticate(django_user_model.objects.create_user("mallory", password="x" * 12))
    assert all(x["id"] != str(r.id) for x in other.get("/api/agent/runs/active/").json())
