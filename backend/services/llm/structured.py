"""Schema-constrained generation with Pydantic validation.

Ollama's `format` accepts a JSON schema and constrains decoding to it. The schema puts `answer` first, so
`AnswerStreamExtractor` can stream the answer text to the UI while the rest of the JSON is still generating.
"""
from __future__ import annotations

import json
from typing import Callable, TypeVar

from pydantic import BaseModel, ValidationError

from config.env import get_settings

from .ollama import LLMUnavailable, OllamaClient, ResolvedModel

T = TypeVar("T", bound=BaseModel)


class StructuredOutputError(RuntimeError):
    pass


class AnswerStreamExtractor:
    """Incrementally decodes the string value of a top-level JSON key from a token stream."""

    def __init__(self, key: str = "answer"):
        self.buf = ""
        self.marker = f'"{key}"'
        self.state = "seek"  # seek -> colon -> value -> done
        self.pos = 0
        self.escape = ""

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        out: list[str] = []
        while self.pos < len(self.buf) and self.state != "done":
            if self.state == "seek":
                i = self.buf.find(self.marker, self.pos)
                if i == -1:
                    self.pos = max(self.pos, len(self.buf) - len(self.marker))
                    break
                self.pos = i + len(self.marker)
                self.state = "colon"
            elif self.state == "colon":
                c = self.buf[self.pos]
                self.pos += 1
                if c == '"':
                    self.state = "value"
            else:  # value
                c = self.buf[self.pos]
                if self.escape:
                    self.escape += c
                    if self.escape.startswith("\\u"):
                        if len(self.escape) == 6:
                            try:
                                out.append(chr(int(self.escape[2:], 16)))
                            except ValueError:
                                pass
                            self.escape = ""
                    else:
                        out.append({"n": "\n", "t": "\t", "r": "", '"': '"', "\\": "\\", "/": "/", "b": "", "f": ""}.get(c, c))
                        self.escape = ""
                elif c == "\\":
                    self.escape = "\\"
                elif c == '"':
                    self.state = "done"
                else:
                    out.append(c)
                self.pos += 1
        return "".join(out)


def resolve_chat_model() -> ResolvedModel:
    s = get_settings()
    return OllamaClient().resolve(s.llm_model, s.llm_fallback_models)


def generate_structured(schema: type[T], messages: list[dict], *, model: str | None = None,
                        on_answer_delta: Callable[[str], None] | None = None, temperature: float | None = None,
                        retries: int = 1, max_tokens: int = 1500,
                        on_token: Callable[[int], None] | None = None) -> tuple[T, dict]:
    """on_token(n) is called with the running count of generated tokens (first attempt only)."""
    client = OllamaClient()
    model = model or resolve_chat_model().name
    temperature = get_settings().llm_temperature if temperature is None else temperature
    attempt_msgs = list(messages)
    last_err = ""
    for attempt in range(retries + 1):
        extractor = AnswerStreamExtractor() if on_answer_delta else None

        count = [0]

        def on_tok(t: str) -> None:
            if attempt == 0 and on_token:
                count[0] += 1
                on_token(count[0])
            if extractor and attempt == 0:  # only stream the first attempt to avoid duplicated text
                d = extractor.feed(t)
                if d:
                    on_answer_delta(d)

        raw, stats = client.stream_chat(model, attempt_msgs, on_tok, temperature=temperature,
                                        json_schema=schema.model_json_schema(), max_tokens=max_tokens)
        try:
            parsed = schema.model_validate(json.loads(raw))
            stats.update(model=model, attempts=attempt + 1)
            return parsed, stats
        except (json.JSONDecodeError, ValidationError) as e:
            last_err = str(e)[:400]
            attempt_msgs = messages + [{"role": "assistant", "content": raw[:4000]},
                                       {"role": "user", "content": f"That output was invalid: {last_err}. "
                                                                   "Return only valid JSON matching the schema."}]
    raise StructuredOutputError(f"Model output failed validation after {retries + 1} attempts: {last_err}")


__all__ = ["generate_structured", "StructuredOutputError", "AnswerStreamExtractor", "resolve_chat_model", "LLMUnavailable"]


def generate_answer(messages: list[dict], *, model: str | None = None, on_answer_delta: Callable[[str], None] | None = None,
                    on_token: Callable[[int], None] | None = None, temperature: float | None = None,
                    max_tokens: int = 900):
    """Plain-text answer generation (no JSON). Native-script answers (Telugu, Hindi, …) often broke the JSON grammar
    ("Unterminated string"), and the JSON wrapper cost extra tokens. Citations are parsed from [D1]-style markers."""
    import re as _re

    from services.agent_orchestrator.schemas import LLMAnswer
    client = OllamaClient()
    model = model or resolve_chat_model().name
    temperature = get_settings().llm_temperature if temperature is None else temperature
    count = [0]

    def on_tok(t: str) -> None:
        count[0] += 1
        if on_token:
            on_token(count[0])
        if on_answer_delta:
            on_answer_delta(t)

    raw, stats = client.stream_chat(model, messages, on_tok, temperature=temperature, max_tokens=max_tokens)
    text = raw.strip()
    # normalise grouped citations "[W1, W2]" / "[D1; D3]" → "[W1][W2]" so they are parsed and rendered as chips
    text = _re.sub(r"\[((?:[DMWSC]\d+\s*[,;]\s*)+[DMWSC]\d+)\]",
                   lambda m: "".join(f"[{x.strip()}]" for x in _re.split(r"[,;]", m.group(1))), text)
    if not text:
        raise StructuredOutputError("The model returned an empty answer.")
    cited = list(dict.fromkeys(_re.findall(r"\[([DMWSC]\d+)\]", text)))
    first = _re.split(r"(?<=[.!?।])\s", _re.sub(r"```.*?```", "", text, flags=_re.S).strip(), maxsplit=1)[0]
    stats.update(model=model, attempts=1)
    return LLMAnswer(answer=text, summary=first[:200], cited_sources=cited, confidence=0.9 if cited else 0.6), stats
