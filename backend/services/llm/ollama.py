"""Ollama chat client (Apple Silicon Metal-accelerated, local). Model choice is configuration-driven so a
remote OpenAI-compatible endpoint can be swapped in without touching the agent graph."""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Callable, Iterable

import httpx

from config.env import get_settings


class LLMUnavailable(RuntimeError):
    pass


@dataclass
class ResolvedModel:
    name: str
    is_fallback: bool


def auth_headers() -> dict:
    """Authorization header for a remote Ollama endpoint (OLLAMA_API_KEY); empty for a local Ollama."""
    k = get_settings().ollama_api_key
    return {"Authorization": f"Bearer {k}"} if k else {}


def _norm(name: str) -> str:
    return name if ":" in name else f"{name}:latest"


def cloud_llm() -> bool:
    return get_settings().llm_provider.lower() == "openai"


class OllamaClient:
    """Chat client. Talks to Ollama, or, when LLM_PROVIDER=openai, to an OpenAI-compatible cloud API with the same
    interface (list/resolve/stream_chat), so the agent graph is unchanged either way."""

    def __new__(cls, *a, **k):
        if cls is OllamaClient and cloud_llm():
            return super().__new__(OpenAICompatClient)
        return super().__new__(cls)

    def __init__(self, base_url: str | None = None, timeout: float | None = None):
        s = get_settings()
        self.base_url = (base_url or s.ollama_base_url).rstrip("/")
        self.timeout = timeout or s.llm_timeout_seconds

    def list_models(self) -> list[dict]:
        try:
            r = httpx.get(f"{self.base_url}/api/tags", timeout=5, headers=auth_headers())
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise LLMUnavailable(f"Ollama is not reachable at {self.base_url} ({e.__class__.__name__}).") from e
        return r.json().get("models", [])

    def loaded_models(self) -> list[dict]:
        try:
            r = httpx.get(f"{self.base_url}/api/ps", timeout=5, headers=auth_headers())
            r.raise_for_status()
            return r.json().get("models", [])
        except httpx.HTTPError:
            return []

    def resolve(self, preferred: str, fallbacks: Iterable[str]) -> ResolvedModel:
        installed = {_norm(m["name"]) for m in self.list_models()}
        if _norm(preferred) in installed:
            return ResolvedModel(preferred, False)
        for fb in fallbacks:
            if _norm(fb) in installed:
                return ResolvedModel(fb, True)
        raise LLMUnavailable(
            f"Model '{preferred}' is not installed in Ollama and no fallback is available. "
            f"Install it with: ollama pull {preferred}"
        )

    def stream_chat(self, model: str, messages: list[dict], on_token: Callable[[str], None] | None = None,
                    temperature: float = 0.3, json_mode: bool = False,
                    json_schema: dict | None = None, max_tokens: int = 1500) -> tuple[str, dict]:
        # num_predict is a hard cap: schema-constrained decoding can otherwise loop (e.g. endless whitespace)
        body = {"model": model, "messages": messages, "stream": True,
                "options": {"temperature": temperature, "num_predict": max_tokens}, "keep_alive": "15m"}
        if json_schema:
            body["format"] = json_schema
        elif json_mode:
            body["format"] = "json"
        out: list[str] = []
        stats: dict = {}
        t0 = time.perf_counter()
        first: float | None = None
        try:
            with httpx.stream("POST", f"{self.base_url}/api/chat", json=body, timeout=self.timeout, headers=auth_headers()) as r:
                if r.status_code != 200:
                    r.read()
                    raise LLMUnavailable(f"Ollama returned HTTP {r.status_code}: {r.text[:300]}")
                for line in r.iter_lines():
                    if not line:
                        continue
                    chunk = json.loads(line)
                    if "error" in chunk:
                        raise LLMUnavailable(f"Ollama error: {chunk['error']}")
                    delta = chunk.get("message", {}).get("content", "")
                    if delta:
                        if first is None:
                            first = time.perf_counter()
                        out.append(delta)
                        if on_token:
                            on_token(delta)
                    if chunk.get("done"):
                        stats = {
                            "prompt_tokens": chunk.get("prompt_eval_count"),
                            "completion_tokens": chunk.get("eval_count"),
                            "load_ms": int((chunk.get("load_duration") or 0) / 1e6),
                            "prompt_eval_ms": int((chunk.get("prompt_eval_duration") or 0) / 1e6),
                            "eval_ms": int((chunk.get("eval_duration") or 0) / 1e6),
                        }
        except httpx.HTTPError as e:
            raise LLMUnavailable(f"LLM request failed: {e.__class__.__name__}: {e}") from e
        stats["wall_ms"] = int((time.perf_counter() - t0) * 1000)
        if first is not None:
            stats["first_token_ms"] = int((first - t0) * 1000)
        if stats.get("completion_tokens") and stats.get("eval_ms"):
            stats["tokens_per_sec"] = round(stats["completion_tokens"] / (stats["eval_ms"] / 1000), 1)
        elif stats.get("completion_tokens") and stats["wall_ms"]:
            stats["tokens_per_sec"] = round(stats["completion_tokens"] / (stats["wall_ms"] / 1000), 1)
        return "".join(out), stats


class OpenAICompatClient(OllamaClient):
    def __init__(self, base_url: str | None = None, timeout: float | None = None):
        s = get_settings()
        self.base_url = (base_url or s.llm_base_url).rstrip("/")
        self.timeout = timeout or s.llm_timeout_seconds
        self.headers = {"Authorization": f"Bearer {s.llm_api_key}"} if s.llm_api_key else {}
        if not self.base_url:
            raise LLMUnavailable("LLM_PROVIDER=openai needs LLM_BASE_URL (and usually LLM_API_KEY).")

    def list_models(self) -> list[dict]:
        try:
            r = httpx.get(f"{self.base_url}/models", timeout=10, headers=self.headers)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise LLMUnavailable(f"LLM API is not reachable at {self.base_url} ({e.__class__.__name__}).") from e
        return [{"name": m.get("id", ""), "size": None} for m in r.json().get("data", [])]

    def loaded_models(self) -> list[dict]:
        return []

    def resolve(self, preferred: str, fallbacks: Iterable[str]) -> ResolvedModel:
        return ResolvedModel(preferred, False)  # the provider validates the model name on the first request

    def stream_chat(self, model: str, messages: list[dict], on_token: Callable[[str], None] | None = None,
                    temperature: float = 0.3, json_mode: bool = False,
                    json_schema: dict | None = None, max_tokens: int = 1500) -> tuple[str, dict]:
        body: dict = {"model": model, "messages": messages, "stream": True, "temperature": temperature,
                      "max_tokens": max_tokens, "stream_options": {"include_usage": True}}
        if json_schema:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "aura_output", "schema": json_schema}}
        elif json_mode:
            body["response_format"] = {"type": "json_object"}
        out: list[str] = []
        stats: dict = {}
        t0 = time.perf_counter()
        first: float | None = None

        def run(b: dict) -> int:
            nonlocal first
            with httpx.stream("POST", f"{self.base_url}/chat/completions", json=b, timeout=self.timeout, headers=self.headers) as r:
                if r.status_code != 200:
                    r.read()
                    return r.status_code if not out else 200
                for line in r.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    chunk = json.loads(data)
                    if chunk.get("usage"):
                        u = chunk["usage"]
                        stats.update(prompt_tokens=u.get("prompt_tokens"), completion_tokens=u.get("completion_tokens"))
                    for ch in chunk.get("choices") or []:
                        delta = (ch.get("delta") or {}).get("content") or ""
                        if delta:
                            if first is None:
                                first = time.perf_counter()
                            out.append(delta)
                            if on_token:
                                on_token(delta)
            return 200

        try:
            code = run(body)
            if code == 400 and json_schema:  # provider without strict JSON-schema support: plain JSON mode + schema hint
                body["response_format"] = {"type": "json_object"}
                body["messages"] = messages + [{"role": "system", "content": "Reply with JSON matching this schema: " + json.dumps(json_schema)[:6000]}]
                code = run(body)
            if code == 400 and not out:  # some providers reject optional fields: last try without them
                body.pop("stream_options", None)
                code = run(body)
            if code != 200:
                raise LLMUnavailable(f"LLM API returned HTTP {code}.")
        except httpx.HTTPError as e:
            raise LLMUnavailable(f"LLM request failed: {e.__class__.__name__}: {e}") from e
        stats["wall_ms"] = int((time.perf_counter() - t0) * 1000)
        if first is not None:
            stats["first_token_ms"] = int((first - t0) * 1000)
        if stats.get("completion_tokens") and stats["wall_ms"]:
            stats["tokens_per_sec"] = round(stats["completion_tokens"] / (stats["wall_ms"] / 1000), 1)
        return "".join(out), stats
