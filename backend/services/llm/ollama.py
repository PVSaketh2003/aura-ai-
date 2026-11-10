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


class OllamaClient:
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
