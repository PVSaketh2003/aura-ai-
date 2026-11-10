"""LLM_PROVIDER=openai: Aura talks to any OpenAI-compatible cloud API (needed on Render, which can't run Ollama).
A real local HTTP server plays the provider: streaming chat (SSE), JSON-schema output with a fallback for providers
that reject json_schema, and embeddings."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from config.env import get_settings

seen: list[dict] = []


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        seen.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        if self.path.endswith("/embeddings"):
            data = [{"index": i, "embedding": [3.0, 4.0]} for i, _ in enumerate(body["input"])]
            return self._json({"data": data})
        fmt = (body.get("response_format") or {}).get("type")
        if fmt == "json_schema":  # this provider only supports json_object
            self.send_response(400); self.end_headers(); return
        text = '{"answer": "Paris"}' if fmt == "json_object" else "Hello from the cloud"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for piece in (text[:5], text[5:]):
            self.wfile.write(f"data: {json.dumps({'choices': [{'delta': {'content': piece}}]})}\n\n".encode())
        self.wfile.write(b'data: {"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 3}}\n\ndata: [DONE]\n\n')

    def _json(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)


@pytest.fixture
def cloud(monkeypatch):
    srv = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    s = get_settings()
    for k, v in {"llm_provider": "openai", "llm_base_url": f"http://127.0.0.1:{srv.server_port}/v1", "llm_api_key": "test-key",
                 "embedding_provider": "", "embedding_base_url": "", "embedding_api_key": "", "embedding_dim": 2}.items():
        monkeypatch.setattr(s, k, v)
    seen.clear()
    yield
    srv.shutdown()


def test_streaming_chat_goes_to_the_cloud_api_with_the_key(cloud):
    from services.llm.ollama import OllamaClient, OpenAICompatClient
    c = OllamaClient()
    assert isinstance(c, OpenAICompatClient)
    tokens = []
    text, stats = c.stream_chat("llama-3.1-8b-instant", [{"role": "user", "content": "hi"}], tokens.append)
    assert text == "Hello from the cloud" and tokens == ["Hello", " from the cloud"]
    assert stats["completion_tokens"] == 3 and seen[0]["auth"] == "Bearer test-key" and seen[0]["path"] == "/v1/chat/completions"


def test_structured_output_falls_back_to_json_mode(cloud):
    from pydantic import BaseModel

    from services.llm.structured import generate_structured

    class A(BaseModel):
        answer: str
    out, stats = generate_structured(A, [{"role": "user", "content": "capital of France?"}], model="m")
    assert out.answer == "Paris"
    assert [s["body"].get("response_format", {}).get("type") for s in seen] == ["json_schema", "json_object"]


def test_embeddings_use_the_same_provider(cloud):
    from services.embeddings.qwen import QwenEmbeddings
    vecs = QwenEmbeddings().embed_documents(["a", "b"])
    assert vecs == [[0.6, 0.8], [0.6, 0.8]] and seen[0]["path"] == "/v1/embeddings" and "keep_alive" not in seen[0]["body"]


def test_ollama_stays_the_default():
    from services.llm.ollama import OllamaClient, OpenAICompatClient
    assert get_settings().llm_provider == "ollama" and not isinstance(OllamaClient(), OpenAICompatClient)


def test_without_local_speech_voice_fails_clearly_and_nothing_heavy_loads(monkeypatch, tmp_path):
    from services.asr import engine as asr
    from services.tts import engine as tts
    monkeypatch.setattr(get_settings(), "local_speech", False)
    with pytest.raises(asr.ASRError, match="type your message"):
        asr.transcribe(tmp_path / "x.webm")
    assert asr.warm() is False
    with pytest.raises(tts.TTSError, match="shown as text"):
        tts.engine_for("en")
    loaded = []
    monkeypatch.setattr("services.retrievers.pipeline.prewarm_chat_model", lambda: None)
    monkeypatch.setattr("services.embeddings.qwen.QwenEmbeddings.embed_query", lambda self, t: [0.0])
    monkeypatch.setattr("services.tts.engine._synth", lambda *a: loaded.append("tts"))
    monkeypatch.setattr("services.asr.engine._vox", lambda: loaded.append("vox"))
    from apps.agent.apps import warm_all
    warm_all()
    assert loaded == []
