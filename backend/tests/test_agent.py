"""Agent graph tests. Network models (LLM, embeddings) are replaced by deterministic stand-ins;
PostgreSQL and ChromaDB writes are real."""
import json

import pytest

from apps.agent import runner
from apps.conversations.models import Message
from apps.execution_traces.models import ExecutionRun, Status
from apps.memory.models import Memory
from apps.preferences.models import Preferences
from services.agent_orchestrator.schemas import LLMAnswer
from services.llm.ollama import LLMUnavailable, OllamaClient, ResolvedModel

pytestmark = pytest.mark.django_db


class FakeLLM:
    """Returns schema-valid objects; records prompts so tests can assert on grounding/language instructions."""

    def __init__(self):
        self.prompts = []

    def __call__(self, schema, messages, *, model=None, on_answer_delta=None, temperature=None, retries=1, max_tokens=1500, on_token=None):
        self.prompts.append(messages)
        name = schema.__name__
        if name == "LLMAnswer":
            user = messages[-1]["content"]
            cited = ["M1"] if 'id="M1"' in user else (["D1"] if 'id="D1"' in user else [])
            text = "Golang [M1]." if cited == ["M1"] else "Hello there!"
            if on_token:
                on_token(1)
            if on_answer_delta:
                on_answer_delta(text)
            return LLMAnswer(answer=text + " [D9]", summary="s", cited_sources=cited + ["X7"], confidence=0.9), {"completion_tokens": 3}
        if name == "MemoryExtraction":
            from services.memory_manager.manager import MemoryExtraction
            return MemoryExtraction.model_validate({"memories": [{"content": "The user's favourite backend programming language is Golang.",
                                                                  "category": "personal_preference", "tags": ["golang"]}]}), {}
        if name == "LLMIntent":
            from services.agent_orchestrator.graph import LLMIntent
            return LLMIntent(intent="recall_memory"), {}
        raise AssertionError(name)


@pytest.fixture
def llm(monkeypatch, user, fake_embeddings, temp_chroma):
    fake = FakeLLM()
    monkeypatch.setattr("services.agent_orchestrator.graph.generate_structured", fake)
    monkeypatch.setattr("services.llm.structured.generate_structured", fake)
    def answer(messages, *, model=None, on_answer_delta=None, on_token=None, temperature=None, max_tokens=900):
        from services.agent_orchestrator.schemas import LLMAnswer
        return fake(LLMAnswer, messages, model=model, on_answer_delta=on_answer_delta, on_token=on_token)
    monkeypatch.setattr("services.agent_orchestrator.graph.generate_answer", answer)
    monkeypatch.setattr("services.agent_orchestrator.graph.resolve_chat_model", lambda: ResolvedModel("llama3.1:8b", False))
    monkeypatch.setattr("services.agent_orchestrator.graph.localize", lambda tracer, text, lang: text)
    Preferences.objects.update_or_create(user=user, defaults={"speak_replies": "never"})
    return fake


def run_sync(api, text, conversation_id=None):
    body = {"message": text, **({"conversation_id": conversation_id} if conversation_id else {})}
    r = api.post("/api/agent/chat/", body, format="json")
    assert r.status_code == 202
    runner.execute_run(r.json()["execution_id"])
    return r.json(), ExecutionRun.objects.get(pk=r.json()["execution_id"])


def keys(run):
    return [s.key for s in run.steps.all()]


def test_small_talk_skips_retrieval_and_strips_fabricated_citations(api, llm):
    data, run = run_sync(api, "Hi!")
    assert run.status == Status.COMPLETED, run.error
    assert keys(run) == ["input", "language", "intent", "context", "prompt", "llm_generation", "validation", "response"]
    reply = Message.objects.get(execution=run, role="assistant")
    assert reply.content == "Hello there!" and reply.payload["source_type"] == "model_knowledge"
    assert reply.payload["citations"] == {}  # [D9] and X7 did not exist → removed
    _, run2 = run_sync(api, "Thanks", data["conversation_id"])
    assert "2 previous messages" in run2.steps.get(key="context").summary


def test_save_then_recall_memory_across_conversations(api, llm, user):
    _, run = run_sync(api, "Remember that my favourite backend programming language is Golang. Save this in our database.")
    assert run.status == Status.COMPLETED, run.error
    assert {"memory_extraction", "memory_embedding", "memory_postgres", "memory_vector"} <= set(keys(run))
    m = Memory.objects.get(user=user)
    assert m.vector_status == "synced" and m.category == "personal_preference"
    # same fact again → detected as duplicate, not saved twice
    run_sync(api, "Remember that my favourite backend programming language is Golang.")
    assert Memory.objects.filter(user=user).count() == 1
    # new conversation, recall
    _, run3 = run_sync(api, "What programming language did I tell you I prefer for backend development?")
    assert run3.intent == "recall_memory" and "memory_retrieval" in keys(run3)
    reply = Message.objects.get(execution=run3, role="assistant")
    assert reply.payload["source_type"] == "memories"
    assert reply.payload["memory_sources"][0]["memory_id"] == str(m.id)
    assert reply.payload["memory_sources"][0]["created_at"]
    sys_prompt = llm.prompts[-1][0]["content"]
    assert "saved date" in sys_prompt and "untrusted data" in sys_prompt


def test_do_not_remember_never_saves(api, llm, user):
    _, run = run_sync(api, "Don't remember this: my locker code is 4417.")
    assert run.intent != "save_memory" and not Memory.objects.filter(user=user).exists()


def test_answer_language_instruction_follows_question(api, llm):
    _, run = run_sync(api, "నేను బ్యాకెండ్ కోసం ఏ ప్రోగ్రామింగ్ భాషను ఇష్టపడతానని చెప్పాను?")
    assert run.status == Status.COMPLETED, run.error
    assert "Telugu" in run.steps.get(key="language").summary
    assert "Write the ENTIRE answer in Telugu" in llm.prompts[-1][0]["content"]
    assert Message.objects.get(execution=run, role="assistant").payload["language"] == "te"


def test_documents_only_without_documents_refuses_outside_knowledge(api, llm):
    _, run = run_sync(api, "Using only my documents, what does my PDF say about CNNs?")
    assert "wikipedia" not in keys(run) and "web_search" not in keys(run)
    assert "ONLY from their documents" in llm.prompts[-1][0]["content"]


def test_ingest_without_mac_agent_fails_honestly(api, llm):
    _, run = run_sync(api, "Go to my Documents folder and load Machine Learning Notes.pdf.")
    step = run.steps.get(key="local_agent")
    assert run.status == Status.FAILED and step.status == Status.FAILED and "offline" in step.error


def test_llm_unavailable_fails_step_honestly(api, llm, monkeypatch):
    def down():
        raise LLMUnavailable("Model 'llama3.1:8b' is not installed")
    monkeypatch.setattr("services.agent_orchestrator.graph.resolve_chat_model", down)
    _, run = run_sync(api, "Hello")
    step = run.steps.get(key="llm_generation")
    assert run.status == Status.FAILED and step.status == Status.FAILED and "not installed" in step.error


def test_memory_api_crud(api, llm, user):
    r = api.post("/api/memory/save/", {"content": "The user is building a computer vision project.", "category": "project"}, format="json")
    assert r.status_code == 201 and r.json()["indexed"]
    mid = r.json()["memory"]["id"]
    assert api.post("/api/memory/search/", {"query": "computer vision project"}, format="json").json()["results"][0]["id"] == mid
    assert api.put(f"/api/memory/{mid}/", {"content": "The user is building a robotics project."}, format="json").status_code == 200
    assert api.delete(f"/api/memory/{mid}/").status_code == 204
    assert not Memory.objects.filter(pk=mid).exists()


def test_memory_survives_vector_store_failure_and_resyncs(api, llm, user, monkeypatch):
    from services.memory_manager import manager
    from services.vector_store import chroma_store as vs
    real = vs.upsert
    monkeypatch.setattr(vs, "upsert", lambda *a, **k: (_ for _ in ()).throw(vs.VectorStoreError("down")))
    m, outcome, indexed = manager.save_memory(user, "The user likes filter coffee.", "personal_preference", [])
    assert outcome == "created" and not indexed and Memory.objects.get(pk=m.pk).vector_status == "failed"
    monkeypatch.setattr(vs, "upsert", real)
    Memory.objects.filter(pk=m.pk).update(updated_at=m.updated_at.replace(year=2020))
    assert manager.sync_pending() == 1 and Memory.objects.get(pk=m.pk).vector_status == "synced"


def test_other_users_cannot_read_runs(api, django_user_model):
    from rest_framework.test import APIClient
    data = api.post("/api/agent/chat/", {"message": "x"}, format="json").json()
    other = APIClient()
    other.force_authenticate(django_user_model.objects.create_user("eve", password="x" * 12))
    assert other.get(f"/api/agent/execution/{data['execution_id']}/").status_code == 404
    assert other.get(f"/api/conversations/{data['conversation_id']}/").status_code == 404


def test_restart_recovery_only_touches_runs_from_previous_process(api):
    from datetime import timedelta
    old = api.post("/api/agent/chat/", {"message": "x"}, format="json").json()["execution_id"]
    live = api.post("/api/agent/chat/", {"message": "y"}, format="json").json()["execution_id"]
    ExecutionRun.objects.filter(pk=old).update(status=Status.RUNNING, started_at=runner.PROCESS_STARTED - timedelta(minutes=5))
    ExecutionRun.objects.filter(pk=live).update(status=Status.RUNNING)
    assert runner.recover_interrupted_runs() == 1
    assert ExecutionRun.objects.get(pk=old).status == Status.FAILED
    assert ExecutionRun.objects.get(pk=live).status == Status.RUNNING


def test_strong_memory_answers_without_external_fallbacks(api, llm, user):
    """A general-intent knowledge question that a saved memory answers must not go to Wikipedia/web.
    (The stand-in embedder is bag-of-words, so the question shares the memory's words; Qwen is multilingual.)"""
    from services.memory_manager import manager
    manager.save_memory(user, "The user's favourite backend programming language is Golang.", "personal_preference", [])
    _, run = run_sync(api, "Is the user's favourite backend programming language Golang?")
    assert run.intent == "general" and run.status == Status.COMPLETED, run.error
    assert "memory_retrieval" in keys(run) and "wikipedia" not in keys(run) and "web_search" not in keys(run)


def test_recall_prefers_saved_memory_over_raw_conversation(api, llm, user):
    run_sync(api, "Remember that my favourite backend programming language is Golang. Save this in our database.")
    _, run = run_sync(api, "What programming language did I tell you I prefer for backend development?")
    assert "conversation_search" not in keys(run)  # a memory matched, so raw history wasn't consulted
