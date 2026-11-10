"""LangGraph agent workflow.

Input → (ASR) → Language → Intent → Context → route by intent:
  save_memory       → MemorySave
  ingest_document   → DocumentIngest (FileSearch → Loader → OCR → Chunking → Embedding → VectorStore)
  file_search       → FileSearch
  recall_memory     → MemoryRetrieval (+ conversation history) → LLM
  document_question → MemoryRetrieval → DocumentRetrieval (Similarity → MultiQuery → MMR → Evaluation)
                      → [Wikipedia → Web] fallback unless "documents only" → LLM
  web_question      → WebSearch (→ Wikipedia) → LLM
  general           → knowledge questions take the document/Wikipedia path; small talk goes straight to the LLM
LLM → Validation → Response → TTS.  Only nodes on the chosen path execute; each is a traced step.

The answer language (text and voice) is the language the user asked in.
"""
from __future__ import annotations

import re
import time
from dataclasses import asdict
from datetime import datetime, timezone as dt_tz
from typing import Any, Literal, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel

from apps.execution_traces.tracer import StepFailed, Tracer
from config.env import get_settings
from services.language import INDIC, detect_text_language, language_name
from services.llm.ollama import LLMUnavailable
from services.llm.structured import StructuredOutputError, generate_answer, generate_structured, resolve_chat_model
from services.retrievers import pipeline as rp

from .intent import classify
from .schemas import (AgentResponse, ExternalSource, Intent, IntentResult, LLMAnswer, MemorySource, RetrievalStatus,
                      SourceDocument, SourceType)


class AgentState(TypedDict, total=False):
    user_id: int
    conversation_id: str
    user_message_id: str
    text: str
    modality: str
    audio_path: str
    prefs: dict
    language: dict
    intent: dict
    history: list[dict]
    evidence: list[dict]
    retrieval_status: str
    pdf_verdict: str  # answered | partial | none | no_documents (PDF-first decision)
    calc: dict  # exact arithmetic computed by Aura (calculator.py): {expression, result}
    pdf_assessment: dict
    wiki: dict  # what Wikipedia did: invoked, purpose, articles, sections, quality
    retrieval_t0: float
    attempted: list[str]
    response: dict
    model: str
    assistant_message_id: str
    speech_id: str


def _t(config: RunnableConfig) -> Tracer:
    return config["configurable"]["tracer"]


def _lang(state: AgentState) -> str:
    return (state.get("language") or {}).get("code", "en")


# ================================================================================================== input / speech
def input_node(state: AgentState, config: RunnableConfig) -> AgentState:
    with _t(config).step("input", "Receiving input") as s:
        if state.get("modality") == "voice":
            s.set("Voice recording received", modality="voice")
            return {}
        text = (state.get("text") or "").strip()
        if not text:
            raise StepFailed("Empty message.")
        s.set(f"Text input · {len(text)} characters")
    return {"text": text}


def asr_node(state: AgentState, config: RunnableConfig) -> AgentState:
    from pathlib import Path

    from apps.conversations.models import Message
    from apps.speech.profile import enrolled_languages
    from services.asr.engine import ASRError, transcribe
    tracer = _t(config)
    prefs = state.get("prefs") or {}
    msg = Message.objects.get(pk=state["user_message_id"])
    # A language chosen for this turn (picker / "which language did you mean?") is authoritative.
    selected = (msg.payload or {}).get("selected_language") or prefs.get("asr_language") or "auto"
    candidates = list(dict.fromkeys(list(prefs.get("spoken_languages") or ["te", "hi", "en"])
                                    + [l for l in enrolled_languages(state["user_id"]) if l in (prefs.get("spoken_languages") or [])]))
    label = "Transcribing speech" + (f" · {language_name(selected)} (your choice)" if selected != "auto" else "")
    with tracer.step("asr", label) as s:
        try:
            from apps.speech.free_talk import personal_model
            tr = transcribe(Path(state["audio_path"]), language=selected, candidates=candidates,
                            engine=prefs.get("asr_engine") or "auto", fallback=prefs.get("asr_fallback") or "whisper",
                            personal=personal_model(state["user_id"]))
        except ASRError as e:
            raise StepFailed(str(e)) from e
        except Exception as e:
            raise StepFailed(f"Speech recognition failed: {type(e).__name__}: {e}") from e
        if tr.status == "uncertain":
            s.set(f"Language unclear ({tr.language_probability:.0%} for {tr.language_name}) · asking you instead of guessing",
                  **tr.as_dict())
        else:
            conf = f" ({tr.language_probability:.0%})" if tr.language_probability is not None and selected == "auto" else ""
            how = "your choice" if selected != "auto" else "detected"
            s.set(f"{tr.engine} · {tr.language_name}{conf}, {how} · {tr.audio_seconds:.1f}s audio"
                  + (f" · {tr.note}" if tr.note else ""), **tr.as_dict())
    speech = {"selected_language": selected, "detected_language": tr.language, "lid_model": tr.lid_model,
              "lid_confidence": tr.language_probability, "asr_model": tr.engine, "asr_confidence": tr.asr_confidence,
              "original_transcript": tr.text, "normalized_transcript": re.sub(r"\s+", " ", tr.text).strip(),
              "audio_seconds": tr.audio_seconds, "asr_ms": tr.ms, "status": tr.status,
              "candidates_considered": (tr.debug or {}).get("candidates_considered")}
    msg.payload = {**(msg.payload or {}), "speech": speech}
    if tr.status == "uncertain":
        msg.content = "🎙 " + (tr.text or "(language unclear)")
        msg.save(update_fields=["content", "payload"])
        opts = tr.options or []
        lines = "\n".join(f"- **{o['language_name']}**: “{o['text']}”" for o in opts)
        answer = ("I couldn’t tell which language you spoke, so I won’t guess. Which of these did you say?\n\n" + lines
                  + "\n\nTap the right one and I’ll answer in that language. You can also pick your language next to the mic.")
        resp = system_response(answer, "en")
        resp["clarify"] = {"message_id": str(msg.id), "options": opts}
        tracer.emit("transcript", message_id=state["user_message_id"], text=msg.content, language="", language_name="unclear",
                    engine="—", speech=speech)
        return {"response": resp, "text": tr.text, "language": {"code": "en", "name": "English", "method": "clarify"}}
    msg.content = tr.text
    msg.language = tr.language
    msg.save(update_fields=["content", "language", "payload"])
    tracer.run.input_text = tr.text
    tracer.run.save(update_fields=["input_text"])
    tracer.emit("transcript", message_id=state["user_message_id"], text=tr.text, language=tr.language,
                language_name=tr.language_name, engine=tr.engine, speech=speech)
    return {"text": tr.text, "language": {"code": tr.language, "name": tr.language_name, "method": "speech",
                                           "selected": selected, "confidence": tr.language_probability}}


def language_node(state: AgentState, config: RunnableConfig) -> AgentState:
    if state.get("language"):
        with _t(config).step("language", "Detecting language") as s:
            s.set(f"{state['language']['name']} (from speech recognition)")
        return {}
    from apps.conversations.models import Message
    with _t(config).step("language", "Detecting language") as s:
        d = detect_text_language(state["text"])
        s.set(f"{d.name} · {d.method}", code=d.code, confidence=d.confidence)
    Message.objects.filter(pk=state["user_message_id"]).update(language=d.code)
    return {"language": {"code": d.code, "name": d.name, "method": d.method}}


# =========================================================================================================== intent
class LLMIntent(BaseModel):
    intent: Literal["general", "save_memory", "recall_memory", "ingest_document", "file_search", "document_question",
                    "web_question"]
    documents_only: bool = False


INTENT_PROMPT = """Classify the user's request (any language). Intents:
save_memory: user explicitly asks you to remember/save something permanently.
recall_memory: user asks what they told you, said, mentioned or saved earlier (e.g. "मैंने ... बताया था?",
  "నేను ... చెప్పాను?", "what did I tell you"). Questions about their own preferences/projects count.
ingest_document: user asks to load/index/read PDF files from their Mac.
file_search: user asks to find/list files on their Mac (without loading).
document_question: question about the content of their PDFs/notes/documents.
web_question: needs current/latest information (news, latest versions, prices, today's events).
general: anything else, including general knowledge questions.
documents_only: true only if the user says to answer only from their documents. JSON only."""


# Non-English requests go to the LLM intent classifier only if they contain a cue for a non-question intent
# (remember / what did I tell you / load a file / latest news). Plain questions skip a 3-5 s LLM call.
_ACTION_CUES = re.compile(
    r"remember|save|memory|told|said|pdf|file|folder|load|latest|news|today|price|"
    r"याद|सेव|सहेज|बताया|कहा था|फ़ाइल|फाइल|फ़ोल्डर|लोड|ताज़ा|ताजा|आज|खबर|समाचार|कीमत|"
    r"గుర్తు|సేవ్|చెప్పాను|చెప్పా|చెప్పిన|అన్నాను|ఫైల్|ఫోల్డర్|లోడ్|తాజా|వార్త|ఈరోజు|ధర|"
    r"நினைவ|சேமி|சொன்னேன்|சொன்ன|கோப்பு|ஏற்று|சமீப|செய்தி|இன்று|விலை|"
    r"ನೆನಪ|ಉಳಿಸ|ಹೇಳಿದ|ಫೈಲ್|ಇತ್ತೀಚ|ಸುದ್ದಿ|ಇಂದು|ಬೆಲೆ|"
    r"ഓർമ|സേവ്|പറഞ്ഞ|ഫയൽ|ഏറ്റവും പുതിയ|വാർത്ത|ഇന്ന്|വില|"
    r"আমার মনে|মনে রাখ|বলেছিলাম|ফাইল|খবর|আজ|"
    r"लक्षात|सांगितल|फाइल|बातम्या|"
    r"યાદ|કહ્યું|ફાઇલ|સમાચાર|"
    r"ਯਾਦ|ਦੱਸਿਆ|ਫਾਈਲ|ਖ਼ਬਰ", re.I)


def intent_node(state: AgentState, config: RunnableConfig) -> AgentState:
    tracer = _t(config)
    with tracer.step("intent", "Identifying intent") as s:
        result = classify(state["text"])
        if _lang(state) != "en" and result.intent is Intent.GENERAL and _ACTION_CUES.search(state["text"]):
            try:
                li, _ = generate_structured(LLMIntent, [{"role": "system", "content": INTENT_PROMPT},
                                                        {"role": "user", "content": state["text"]}], temperature=0, max_tokens=80)
                intent = Intent(li.intent)
                if intent is Intent.SAVE_MEMORY and result.forbid_memory:
                    intent = Intent.GENERAL  # "do not remember" always wins
                result = IntentResult(intent=intent, confidence=0.75, method="llm (multilingual)",
                                      forbid_memory=result.forbid_memory, documents_only=li.documents_only or result.documents_only)
            except (LLMUnavailable, StructuredOutputError):
                pass
        extra = " · will not save (user said don't remember)" if result.forbid_memory else ""
        extra += " · documents only" if result.documents_only else ""
        s.set(f"{result.intent.value.replace('_', ' ')} ({result.confidence:.0%}, {result.method}){extra}",
              **result.model_dump(mode="json"))
    tracer.run.intent = result.intent.value
    out: AgentState = {"intent": result.model_dump(mode="json")}
    if result.intent is Intent.GENERAL:
        from .calculator import detect
        calc = detect(state["text"])
        if calc:  # exact arithmetic beats a 4B model's mental maths; no retrieval needed
            with tracer.step("calculator", "Calculating exactly") as s:
                s.set(f"{calc.expression} = {calc.result}", **calc.as_dict())
            out["calc"] = calc.as_dict()
    return out


def context_node(state: AgentState, config: RunnableConfig) -> AgentState:
    from apps.conversations.models import Message
    n = get_settings().conversation_context_messages
    with _t(config).step("context", "Loading conversation context") as s:
        msgs = list(Message.objects.filter(conversation_id=state["conversation_id"]).exclude(pk=state["user_message_id"])
                    .order_by("-created_at").values("role", "content")[:n])[::-1]
        s.set(f"{len(msgs)} previous messages" if msgs else "New conversation", messages=len(msgs))
    return {"history": [{"role": m["role"], "content": m["content"]} for m in msgs]}


_SMALLTALK = re.compile(r"^\s*(hi|hello|hey|thanks|thank you|ok|okay|good (morning|night|evening)|bye|how are you)\b[\s!.?]*$", re.I)
_KNOWLEDGE = re.compile(r"\?|^\s*(what|who|why|how|when|where|which|explain|define|describe|tell me|summari[sz]e|compare|list)\b", re.I)


def route(state: AgentState) -> str:
    intent = Intent(state["intent"]["intent"])
    if intent is Intent.SAVE_MEMORY:
        return "memory_save"
    if intent is Intent.INGEST_DOCUMENT:
        return "document_ingest"
    if intent is Intent.FILE_SEARCH:
        return "file_search"
    if intent is Intent.RECALL_MEMORY:
        return "memory_recall"
    if intent is Intent.WEB_QUESTION:
        return "web_search"
    if intent is Intent.DOCUMENT_QUESTION:
        return "memory_retrieval"
    if state.get("calc"):
        return "llm"
    text = state["text"]
    if _SMALLTALK.match(text) or (len(text.split()) < 3 and not _KNOWLEDGE.search(text)):
        return "llm"
    return "memory_retrieval" if (_KNOWLEDGE.search(text) or _lang(state) in INDIC or len(text.split()) > 5) else "llm"


# ========================================================================================================== helpers
def localize(tracer: Tracer, text: str, lang: str) -> str:
    """Action confirmations are templated in English; translate them so the reply matches the user's language."""
    if lang == "en":
        return text
    from services.llm.ollama import OllamaClient

    with tracer.step("localize", f"Writing reply in {language_name(lang)}") as s:
        try:
            out, _ = OllamaClient().stream_chat(resolve_chat_model().name, [
                {"role": "system", "content": f"Translate the message into {language_name(lang)}. Keep file names, numbers, "
                                              "Markdown formatting and quoted memory text meaning exactly. Output only the translation."},
                {"role": "user", "content": text}], temperature=0, max_tokens=600)
            s.set(f"Translated to {language_name(lang)}")
            return out.strip() or text
        except Exception as e:
            s.set(f"Kept English: {type(e).__name__}")
            return text


def system_response(answer: str, lang: str, source_type: SourceType = SourceType.SYSTEM, **kw) -> dict:
    return AgentResponse(answer=answer, summary=answer.split("\n")[0][:160], source_type=source_type, confidence=1.0,
                         retrieval_status=RetrievalStatus.NOT_REQUIRED, language=lang, **kw).model_dump(mode="json")


# ===================================================================================================== action nodes
def memory_save_node(state: AgentState, config: RunnableConfig) -> AgentState:
    from apps.conversations.models import Conversation, Message
    from apps.memory.models import Memory
    from services.embeddings.qwen import EmbeddingError
    from services.memory_manager import manager
    tracer, lang = _t(config), _lang(state)
    user = tracer.run.user
    with tracer.step("memory_extraction", "Extracting memory") as s:
        try:
            ext = manager.extract_memories(state["text"], state.get("history"))
        except (LLMUnavailable, StructuredOutputError) as e:
            raise StepFailed(f"Couldn't extract the memory: {e}") from e
        if not ext.memories:
            raise StepFailed("I couldn't find a specific fact to save in that message.")
        s.set(f"{len(ext.memories)} memor{'y' if len(ext.memories) == 1 else 'ies'} · Pydantic-validated",
              memories=[m.model_dump() for m in ext.memories])
    saved, dups = [], []
    conv = Conversation.objects.filter(pk=state["conversation_id"]).first()
    msg = Message.objects.filter(pk=state["user_message_id"]).first()
    for em in ext.memories:
        with tracer.step("memory_embedding", "Generating memory embedding") as s:
            try:
                vec = manager._embedder().embed_documents([em.content])[0]
                s.set(f"{len(vec)}-dim vector")
            except EmbeddingError as e:
                vec = None
                s.set(f"Embedding unavailable ({e}); will index in background")
        with tracer.step("memory_postgres", "Saving memory in PostgreSQL") as s:
            dup, sim = manager.find_duplicate(user.id, em.content, vec)
            if dup:
                dups.append(dup)
                s.set(f"Already saved on {dup.created_at:%d %b %Y} (similarity {sim:.2f}) — not duplicated", memory_id=str(dup.id))
                continue
            m = Memory.objects.create(user=user, content=em.content, category=em.category, tags=em.tags, language=lang,
                                      original_text=state["text"][:4000], source_conversation=conv, source_message=msg)
            from apps.core.models import audit
            audit(user, "memory.created", str(m.id), category=m.category)
            s.set(f"Memory {str(m.id)[:8]} · {m.get_category_display()}", memory_id=str(m.id))
        with tracer.step("memory_vector", "Storing memory vector in ChromaDB") as s:
            ok = manager.index_memory(m, vec) if vec else False
            s.set("Indexed in “memories” collection" if ok else "Saved in PostgreSQL; vector sync queued for retry")
        m.refresh_from_db()
        saved.append(m)
    lines = [f"- “{m.content}” ({m.get_category_display()})" for m in saved]
    if saved:
        answer = "Saved to your permanent memory:\n\n" + "\n".join(lines)
    else:
        answer = "I already had this saved:"
    if dups:
        answer += ("\n\n" if saved else "\n\n") + "\n".join(f"- “{d.content}” (saved {d.created_at:%d %b %Y})" for d in dups)
    answer = localize(tracer, answer, lang)
    mems = [MemorySource(memory_id=str(m.id), content=m.content, category=m.category, created_at=m.created_at.isoformat())
            for m in saved + dups]
    return {"response": system_response(answer, lang, SourceType.MEMORIES, memory_sources=mems)}


def document_ingest_node(state: AgentState, config: RunnableConfig) -> AgentState:
    from apps.documents.tasks import ingest_from_mac
    tracer = _t(config)
    result = ingest_from_mac(tracer, tracer.run.user, text=state["text"])
    answer = localize(tracer, result.answer, _lang(state))
    docs = [SourceDocument(document_id=d["document_id"], filename=d["filename"]) for d in result.documents]
    return {"response": system_response(answer, _lang(state), SourceType.DOCUMENTS, source_documents=docs)}


def file_search_node(state: AgentState, config: RunnableConfig) -> AgentState:
    from apps.documents.tasks import find_on_mac
    tracer = _t(config)
    result = find_on_mac(tracer, tracer.run.user, state["text"])
    return {"response": system_response(localize(tracer, result.answer, _lang(state)), _lang(state))}


# ================================================================================================ retrieval nodes
def _ev(evs: list[rp.Evidence]) -> list[dict]:
    return [asdict(e) for e in evs]


def _renumber(existing: list[dict], new: list[dict]) -> list[dict]:
    counts: dict[str, int] = {}
    for e in existing:
        counts[e["id"][0]] = counts.get(e["id"][0], 0) + 1
    out = []
    for e in new:
        p = e["id"][0]
        counts[p] = counts.get(p, 0) + 1
        out.append({**e, "id": f"{p}{counts[p]}"})
    return out


def memory_recall_node(state: AgentState, config: RunnableConfig) -> AgentState:
    tracer = _t(config)
    rp.embed_question(tracer, state["text"])
    ev = rp.retrieve_memories(tracer, state["text"], state["user_id"], explicit=True)
    if not ev:  # saved memories are authoritative; raw past messages (e.g. ASR typos) only as a fallback
        ev = rp.search_conversations(tracer, state["text"], state["user_id"], state["conversation_id"])
    status = RetrievalStatus.SUFFICIENT if ev else RetrievalStatus.INSUFFICIENT
    return {"evidence": _ev(ev), "retrieval_status": status.value, "attempted": ["saved memories", "past conversations"]}


def memory_retrieval_node(state: AgentState, config: RunnableConfig) -> AgentState:
    tracer = _t(config)
    rp.embed_question(tracer, state["text"])
    ev = rp.retrieve_memories(tracer, state["text"], state["user_id"], explicit=False)
    return {"evidence": _ev(ev), "attempted": []}


def document_retrieval_node(state: AgentState, config: RunnableConfig) -> AgentState:
    prefs = state.get("prefs") or {}
    tracer = _t(config)
    en = None
    if _lang(state) != "en":
        # Cross-lingual retrieval: the PDFs are mostly English, so an English rendering is searched ALONGSIDE the
        # original Telugu/Hindi question (merged + deduplicated). The answer is still written for the original question.
        with tracer.step("translate_query", "Adding an English search query") as s:
            en = rp.english_query(state["text"], _lang(state))
            s.set(f"“{en}” (search only — your question is kept as asked)", query=en, original=state["text"])
    t0 = time.perf_counter()
    out = rp.retrieve_documents(tracer, state["text"], state["user_id"], _lang(state),
                                allow_multi_query=prefs.get("multi_query", True), english=en)
    evidence = state.get("evidence", []) + _renumber(state.get("evidence", []), _ev(out.evidence))
    status = out.status if out.status != "unavailable" else "insufficient"
    verdict = "no_documents" if out.status == "unavailable" else (out.metrics or {}).get("verdict", "none")
    assessment = {k: v for k, v in (out.metrics or {}).items() if k != "assessment"}
    return {"evidence": evidence, "retrieval_status": status, "attempted": state.get("attempted", []) + ["your documents"],
            "pdf_verdict": verdict, "pdf_assessment": assessment, "retrieval_t0": state.get("retrieval_t0") or t0}


STRONG_MEMORY = 0.6


def after_documents(state: AgentState) -> str:
    # PDF-first: a sufficient PDF answer never touches Wikipedia; "documents only" never leaves the PDFs.
    if state.get("retrieval_status") == "sufficient" or state["intent"].get("documents_only"):
        return "llm"
    if state.get("retrieval_status") == "partial":  # keep the PDF part; Wikipedia only fills the gap
        return "wikipedia" if (state.get("prefs") or {}).get("wikipedia", True) else "llm"
    if any(e["kind"] == "memory" and (e.get("similarity") or 0) >= STRONG_MEMORY for e in state.get("evidence", [])):
        return "llm"  # a saved memory answers this; no need for Wikipedia/web
    prefs = state.get("prefs") or {}
    if state["intent"]["intent"] == Intent.GENERAL.value and not _KNOWLEDGE.search(state["text"]) and _lang(state) == "en":
        return "llm"
    if prefs.get("wikipedia", True):
        return "wikipedia"
    return "web_search" if prefs.get("web_search", True) and get_settings().web_search_enabled else "llm"


def wikipedia_node(state: AgentState, config: RunnableConfig) -> AgentState:
    from services.retrievers.decision import Assessment, supplement_query
    partial = state.get("retrieval_status") == "partial"
    query, purpose = None, "answer"
    if partial:
        a = state.get("pdf_assessment") or {}
        en = rp.english_query(state["text"], _lang(state)) if _lang(state) != "en" else state["text"]
        fake = Assessment("partial", "", None, 0, 0, 0, a.get("coverage", 0), a.get("covered_terms", []),
                          a.get("missing_terms", []), judge_missing=a.get("judge_missing", ""))
        query, purpose = supplement_query(en, fake), "supplement"
    out = rp.retrieve_wikipedia(_t(config), state["text"], _lang(state), query=query, purpose=purpose)
    new = _renumber(state.get("evidence", []), _ev(out.evidence))
    if partial:  # PDF part + Wikipedia supplement = covered; without a supplement the answer stays partial
        status = "sufficient" if out.status == "sufficient" else "partial"
    else:
        status = "sufficient" if out.status == "sufficient" else state.get("retrieval_status", "insufficient")
    wiki = {"invoked": True, "purpose": purpose, "status": out.status, "query": query or "",
            "articles": sorted({e.extra.get("article", e.title) for e in out.evidence}), "sections": [e.title for e in out.evidence]}
    return {"evidence": state.get("evidence", []) + new, "retrieval_status": status,
            "attempted": state.get("attempted", []) + ["Wikipedia"], "wiki": wiki}


def after_wikipedia(state: AgentState) -> str:
    prefs = state.get("prefs") or {}
    if state.get("retrieval_status") in ("sufficient", "partial"):
        return "llm"
    if prefs.get("web_search", True) and get_settings().web_search_enabled and "the web" not in state.get("attempted", []):
        return "web_search"
    return "llm"


def web_search_node(state: AgentState, config: RunnableConfig) -> AgentState:
    prefs = state.get("prefs") or {}
    if not (prefs.get("web_search", True) and get_settings().web_search_enabled):
        with _t(config).step("web_search", "Searching the web") as s:
            s.set("Web search is turned off in Settings")
        return {"attempted": state.get("attempted", []) + ["the web (disabled)"]}
    out = rp.retrieve_web(_t(config), state["text"], _lang(state))
    new = _renumber(state.get("evidence", []), _ev(out.evidence))
    status = "sufficient" if out.status == "sufficient" else (state.get("retrieval_status") or "insufficient")
    return {"evidence": state.get("evidence", []) + new, "retrieval_status": status,
            "attempted": state.get("attempted", []) + ["the web"]}


def after_web(state: AgentState) -> str:
    if state.get("retrieval_status") != "sufficient" and state["intent"]["intent"] == Intent.WEB_QUESTION.value \
            and "Wikipedia" not in state.get("attempted", []) and (state.get("prefs") or {}).get("wikipedia", True):
        return "wikipedia"
    return "llm"


# ====================================================================================================== generation
SOURCE_CHARS = 1300  # per passage; prompt reading is ~140 tokens/s on this Mac, so every passage costs time


def _source_block(evidence: list[dict]) -> str:
    def attrs(e):
        bits = [f'id="{e["id"]}"', f'type="{e["kind"]}"']
        if e.get("title"):
            bits.append(f'title="{e["title"][:120]}"')
        if e.get("page"):
            pg = e["page"] if not e.get("page_end") or e["page_end"] == e["page"] else f'{e["page"]}-{e["page_end"]}'
            bits.append(f'page="{pg}"')
        if e.get("created_at"):
            bits.append(f'saved="{e["created_at"][:10]}"')
        return " ".join(bits)
    safe = lambda t: t.replace("</source>", "</ source>")  # noqa: E731
    return "\n\n".join(f"<source {attrs(e)}>\n{safe(e['text'][:SOURCE_CHARS])}\n</source>" for e in evidence)


def build_prompt(state: AgentState) -> list[dict]:
    """Dynamic prompt: sections chosen per request (task, language, grounding mode, voice) — see prompts.py."""
    from .prompts import plan_prompt
    lang = (state.get("language") or {}).get("code", "en")
    ev = state.get("evidence", [])
    calc = state.get("calc")
    plan = plan_prompt(
        question=state["text"] + (f" ({calc['expression']})" if calc else ""), language=lang, evidence=ev, status=state.get("retrieval_status") or "not_required",
        attempted=state.get("attempted", []), documents_only=bool(state["intent"].get("documents_only")),
        recall=state["intent"]["intent"] == Intent.RECALL_MEMORY.value, voice=state.get("modality") == "voice",
        strong_memory=any(e["kind"] == "memory" and (e.get("similarity") or 0) >= STRONG_MEMORY for e in ev))
    state["_plan"] = plan.describe()  # type: ignore[typeddict-unknown-key]
    msgs = [{"role": "system", "content": plan.system()},
            *[{"role": h["role"], "content": h["content"][:1200]} for h in state.get("history", [])[-6:]]]
    q = state["text"]
    if state.get("modality") == "voice":
        q = (f"{q}\n\n(This question was transcribed from speech and may contain recognition errors or English words "
             "written in native script; silently infer the most likely intended question and answer it directly. Do "
             "not apologise or say you did not understand unless the question is truly unintelligible.)")
    if calc:
        q += (f"\n\n[Calculator — exact result computed by Aura with standard operator precedence (× and ÷ before + "
              f"and −): {calc['expression']} = {calc['result']}. Give this result; show the working briefly. If the user "
              "may have meant a different order of operations, say so in one line.]")
    if ev and plan.mode == "grounded":
        ids = ", ".join(e["id"] for e in ev)
        q += (f"\n\n[Answer in {language_name(lang)}. Put the id of the source you used in square brackets right "
              f"after each fact, e.g. [{ev[0]['id']}]. Available ids: {ids}.]")
    content = q if not ev else f"<sources>\n{_source_block(ev)}\n</sources>\n\nQuestion: {q}"
    msgs.append({"role": "user", "content": content})
    return msgs


def _prompt_view(messages: list[dict], evidence: list[dict]) -> dict:
    chars = sum(len(m["content"]) for m in messages)
    return {
        "messages": [{"role": m["role"], "content": m["content"][:14000], "chars": len(m["content"])} for m in messages],
        "sources": [{"id": e["id"], "kind": e["kind"], "title": e.get("title", "")[:120], "page": e.get("page"),
                     "page_end": e.get("page_end"), "similarity": e.get("similarity"), "chars": len(e["text"][:SOURCE_CHARS]),
                     "chunk_id": (e.get("extra") or {}).get("chunk_id")} for e in evidence],
        "chars": chars, "est_tokens": round(chars / 3.6),
    }


_STREAMERS: dict[str, Any] = {}


def _wants_audio(state: AgentState) -> bool:
    speak = (state.get("prefs") or {}).get("speak_replies", "always")
    return speak == "always" or (speak == "voice_only" and state.get("modality") == "voice")


def _start_speech(state: AgentState, tracer: Tracer, mid: str):
    """Starts speaking the answer while it is being written (sentence by sentence)."""
    if not _wants_audio(state):
        return None
    from apps.speech.storage import tts_dir
    from services.tts.engine import SpeechStreamer, TTSError
    prefs = state.get("prefs") or {}
    lang = _lang(state)
    try:
        st = SpeechStreamer(lang, tts_dir(mid), voice=(prefs.get("tts_voices") or {}).get(lang),
                            speed=float(prefs.get("tts_speed") or 1.0),
                            on_segment=lambda seg: tracer.emit("audio.segment", message_id=mid, index=seg.index,
                                                               url=f"/api/speech/audio/{mid}/{seg.index}/",
                                                               seconds=round(seg.seconds, 2)))
    except TTSError:
        return None
    _STREAMERS[mid] = st
    return st


def llm_node(state: AgentState, config: RunnableConfig) -> AgentState:
    import uuid
    tracer = _t(config)
    messages = build_prompt(state)
    mid = str(uuid.uuid4())  # the assistant message id, allocated now so speech can stream before the message is saved
    if "your documents" in state.get("attempted", []) or state.get("wiki"):
        retrieval_trace(state, tracer)
    with tracer.step("prompt", "Assembling the prompt") as s:
        view = _prompt_view(messages, state.get("evidence", []))
        hist = len(state.get("history", [])[-8:])
        plan = state.get("_plan") or {}
        view["plan"] = plan
        s.set(f"{plan.get('template', 'answer')} template · {plan.get('mode', '')} · {language_name(_lang(state))}"
              + (" · voice" if plan.get("voice") else "") + f" · {len(view['sources'])} source(s)"
              + (f" + {hist} earlier message(s)" if hist else "") + f" · ~{view['est_tokens']:,} tokens", **view)
    with tracer.step("llm_generation", "Generating answer") as s:
        try:
            model = resolve_chat_model()
        except LLMUnavailable as e:
            raise StepFailed(str(e)) from e
        note = f" (fallback — {get_settings().llm_model} not installed)" if model.is_fallback else ""
        s.set(f"{model.name}{note} · {_lang(state)}", model=model.name)
        buf: list[str] = []
        last = [time.perf_counter()]
        speech = _start_speech(state, tracer, mid)

        def on_delta(d: str) -> None:
            if speech:
                speech.feed(d)
            buf.append(d)
            if time.perf_counter() - last[0] > 0.05:
                tracer.emit("answer.delta", delta="".join(buf))
                buf.clear()
                last[0] = time.perf_counter()
        t_gen = time.perf_counter()
        progress = {"tokens": 0, "first_ms": None}

        def on_token(n: int) -> None:
            progress["tokens"] = n
            if progress["first_ms"] is None:
                progress["first_ms"] = int((time.perf_counter() - t_gen) * 1000)
                tracer.emit("llm.progress", phase="writing", tokens=n, first_token_ms=progress["first_ms"])
            elif n % 8 == 0:
                tracer.emit("llm.progress", phase="writing", tokens=n, first_token_ms=progress["first_ms"],
                            elapsed_ms=int((time.perf_counter() - t_gen) * 1000))
        tracer.emit("llm.progress", phase="reading", tokens=0, prompt_tokens=view["est_tokens"])
        try:
            plan = state.get("_plan") or {}
            cap = 1300 if plan.get("template") == "code" else (480 if _lang(state) in INDIC else 360) if plan.get("voice") \
                else 1100 if _lang(state) in INDIC else 800
            ans, stats = generate_answer(messages, model=model.name, on_answer_delta=on_delta, on_token=on_token,
                                         max_tokens=cap, temperature=0.1 if plan.get("mode") == "grounded" else None)
        except (LLMUnavailable, StructuredOutputError) as e:
            if speech:
                speech.cancel()
                _STREAMERS.pop(mid, None)
            raise StepFailed(str(e)) from e
        if buf:
            tracer.emit("answer.delta", delta="".join(buf))
        tps = f" · {stats['tokens_per_sec']} tok/s" if stats.get("tokens_per_sec") else ""
        read = f" · read {stats['prompt_tokens']:,}-token prompt in {stats['prompt_eval_ms'] / 1000:.1f}s" \
            if stats.get("prompt_tokens") and stats.get("prompt_eval_ms") else ""
        ok_lang, share = answer_language_ok(ans.answer, _lang(state))
        s.set(f"{model.name}{note} · {stats.get('completion_tokens') or '?'} tokens{tps}{read}" +
              (f" · {stats['attempts']} attempts" if stats.get("attempts", 1) > 1 else "")
              + (f" · written in {language_name(_lang(state))} ✓" if ok_lang else ""), **stats, language_check=round(share, 2))
    if not ok_lang:
        # Language validation: the answer drifted into another language/script (the old "Telugu question → Gujarati
        # answer" bug). Rewrite it in the user's language; speech restarts from the corrected text.
        if speech:
            speech.cancel()
            _STREAMERS.pop(mid, None)
        with tracer.step("language_fix", f"Rewriting the answer in {language_name(_lang(state))}") as s2:
            fixed = rewrite_in_language(ans.answer, _lang(state), model.name)
            ok2, share2 = answer_language_ok(fixed, _lang(state))
            if ok2:
                ans.answer = fixed
            s2.set(f"Answer was only {share:.0%} {language_name(_lang(state))} → rewritten ({share2:.0%})" if ok2
                   else f"Could not fix the language ({share2:.0%}); kept the original", before=round(share, 2), after=round(share2, 2))
    return {"response": {"_llm": ans.model_dump()}, "model": model.name, "speech_id": mid}


def retrieval_trace(state: AgentState, tracer: Tracer) -> dict:
    """One transparent summary of the PDF-first decision (no reasoning text, only facts the pipeline produced)."""
    from services.retrievers.decision import ROUTES
    ev = state.get("evidence", [])
    verdict = state.get("pdf_verdict") or "none"
    wiki = state.get("wiki") or {}
    final = state.get("retrieval_status")
    if verdict == "answered":
        route = ROUTES["answered"]
    elif verdict == "no_documents":
        route = ROUTES["no_documents"] + (" → FOUND" if final == "sufficient" else " → INSUFFICIENT")
    elif verdict == "partial":
        route = ROUTES["partial"] + (" → COMBINED ANSWER" if any(e["kind"] == "wikipedia" for e in ev) else " → WIKIPEDIA HAD NOTHING MORE")
    elif any(e["kind"] == "wikipedia" for e in ev):
        route = ROUTES["none"] + " → WIKIPEDIA ANSWER FOUND"
    elif any(e["kind"] == "web" for e in ev):
        route = ROUTES["none"] + " → WEB ANSWER FOUND"
    elif wiki.get("invoked"):
        route = ROUTES["none_none"]
    else:
        route = "PDF SEARCH → INSUFFICIENT EVIDENCE" + (" (Wikipedia off)" if not (state.get("prefs") or {}).get("wikipedia", True) else "")
    kinds = sorted({e["kind"] for e in ev})
    source = {(): "none — will say it couldn't find it", ("document",): "your PDFs", ("wikipedia",): "Wikipedia",
              ("document", "wikipedia"): "your PDFs + Wikipedia (kept separate)", ("web",): "the web"}.get(tuple(k for k in kinds if k != "memory"), ", ".join(kinds))
    a = state.get("pdf_assessment") or {}
    secs = time.perf_counter() - state["retrieval_t0"] if state.get("retrieval_t0") else None
    detail = {"route": route, "question": state["text"], "language": _lang(state),
              "english_query": (rp._EN_QUERY.get(state["text"]) if _lang(state) != "en" else ""),
              "pdf_verdict": verdict, "pdf_top_similarity": a.get("top_similarity"), "pdf_coverage": a.get("coverage"),
              "pdf_judge": a.get("judge"), "pdf_missing": a.get("judge_missing") or "", "reasons": a.get("reasons", []),
              "documents": sorted({e["title"] for e in ev if e["kind"] == "document"}),
              "chunks": [{"id": e["id"], "title": e["title"], "page": e.get("page"), "similarity": e.get("similarity")}
                         for e in ev if e["kind"] == "document"],
              "wikipedia_invoked": bool(wiki.get("invoked")), "wikipedia_purpose": wiki.get("purpose", ""),
              "wikipedia_articles": wiki.get("articles", []), "wikipedia_sections": wiki.get("sections", []),
              "final_source": source, "retrieval_ms": int(secs * 1000) if secs else None}
    with tracer.step("retrieval_route", "Retrieval decision") as s:
        s.set(f"{route} · answer source: {source}" + (f" · retrieval {secs:.1f}s" if secs else ""), **detail)
    return detail


def answer_language_ok(answer: str, lang: str) -> tuple[bool, float]:
    """Share of the answer's prose (code and citation markers removed) written in the expected script."""
    from services.asr.engine import script_share
    prose = re.sub(r"```.*?(```|$)", " ", answer, flags=re.S)
    prose = re.sub(r"`[^`]*`|\[[DMWSC]\d+\]|https?://\S+", " ", prose)
    if sum(c.isalpha() for c in prose) < 20:
        return True, 1.0
    share = script_share(prose, lang)
    return (share >= 0.35 if lang in INDIC else share >= 0.6), share


def rewrite_in_language(answer: str, lang: str, model: str) -> str:
    from services.llm.ollama import OllamaClient
    try:
        out, _ = OllamaClient().stream_chat(model, [
            {"role": "system", "content": f"Rewrite the text entirely in {language_name(lang)}"
                                          + (f" (native {language_name(lang)} script)" if lang in INDIC else "")
                                          + ". Keep English technical terms, code blocks, numbers and citation markers "
                                            "like [D1] exactly as they are. Output only the rewritten text."},
            {"role": "user", "content": answer}], temperature=0, max_tokens=1200)
        return out.strip() or answer
    except Exception:
        return answer


_KIND_TO_SOURCE = {"document": SourceType.DOCUMENTS, "memory": SourceType.MEMORIES, "wikipedia": SourceType.WIKIPEDIA,
                   "web": SourceType.WEB, "conversation": SourceType.CONVERSATIONS}


def _attribute(answer: str, evidence: list[dict]) -> list[str]:
    """When the model used the sources but didn't write [D1]-style markers, find which sources the answer actually
    draws on by embedding similarity (answer vs. each passage). Only clear matches are attributed."""
    try:
        import numpy as np

        from services.embeddings.qwen import QwenEmbeddings
        emb = QwenEmbeddings()
        a = np.array(emb.embed_documents([re.sub(r"```.*?```", " ", answer, flags=re.S)[:2000]])[0])
        vs = np.array(emb.embed_documents([e["text"][:1500] for e in evidence]))
        sims = vs @ a / (np.linalg.norm(vs, axis=1) * np.linalg.norm(a) + 1e-9)
        best = float(sims.max())
        return [e["id"] for e, sim in zip(evidence, sims) if sim >= max(0.5, best - 0.08)][:3]
    except Exception:
        return []


def validation_node(state: AgentState, config: RunnableConfig) -> AgentState:
    with _t(config).step("validation", "Validating structured response") as s:
        llm = LLMAnswer.model_validate(state["response"]["_llm"])
        ev = {e["id"]: e for e in state.get("evidence", [])}
        cited = [c for c in dict.fromkeys(llm.cited_sources) if c in ev]
        in_text = set(re.findall(r"\[([DMWSC]\d+)\]", llm.answer))
        cited += [c for c in in_text if c in ev and c not in cited]
        dropped = [c for c in set(llm.cited_sources) | in_text if c not in ev]
        attributed = False
        if not cited and ev and state.get("retrieval_status") in ("sufficient", "partial"):
            cited = _attribute(llm.answer, list(ev.values()))
            attributed = bool(cited)
        answer = llm.answer
        for d in dropped:  # remove fabricated citation markers
            answer = answer.replace(f"[{d}]", "")
        used = [ev[c] for c in cited]
        kinds = {e["kind"] for e in used}
        status = state.get("retrieval_status") or RetrievalStatus.NOT_REQUIRED.value
        if not used:
            source_type = SourceType.MODEL
        elif len(kinds) == 1:
            source_type = _KIND_TO_SOURCE[kinds.pop()]
        else:
            source_type = SourceType.COMBINED
        docs: dict[str, SourceDocument] = {}
        for e in used:
            if e["kind"] == "document":
                d = docs.setdefault(e["document_id"], SourceDocument(document_id=e["document_id"], filename=e["title"]))
                for p in range(e["page"], (e.get("page_end") or e["page"]) + 1):
                    if p not in d.page_numbers:
                        d.page_numbers.append(p)
        cap = 0.95 if status == "sufficient" and used else 0.75 if status == "partial" and used else 0.35 if status == "insufficient" else 0.6
        resp = AgentResponse(
            answer=answer.strip(), summary=llm.summary, source_type=source_type, source_documents=list(docs.values()),
            page_numbers=sorted({p for d in docs.values() for p in d.page_numbers}), confidence=min(llm.confidence, cap),
            retrieval_status=status, language=_lang(state), model=state.get("model", ""),
            external_sources=[ExternalSource(title=e["title"], url=e["url"], provider=e["kind"]) for e in used if e["kind"] in ("wikipedia", "web")],
            memory_sources=[MemorySource(memory_id=e["extra"]["memory_id"], content=e["text"], category=e["title"],
                                         created_at=e["created_at"]) for e in used if e["kind"] == "memory"],
            citations={c: {"kind": ev[c]["kind"], "title": ev[c]["title"], "page": ev[c].get("page"), "url": ev[c].get("url", ""),
                           "document_id": ev[c].get("document_id", ""), "created_at": ev[c].get("created_at", ""),
                           "page_end": ev[c].get("page_end"), "similarity": ev[c].get("similarity"),
                           "snippet": re.sub(r"\s+", " ", ev[c]["text"])[:320]} for c in cited},
        )
        s.set(f"AgentResponse valid · source: {source_type.value} · {len(cited)} citation(s)"
              + (" (matched by content)" if attributed else "")
              + (f" · removed {len(dropped)} invalid" if dropped else ""), cited=cited, dropped=dropped)
    return {"response": resp.model_dump(mode="json")}


# ===================================================================================================== response/tts
def response_node(state: AgentState, config: RunnableConfig) -> AgentState:
    from django.utils import timezone

    from apps.conversations.models import Conversation, Message
    tracer = _t(config)
    resp = state["response"]
    prefs = state.get("prefs") or {}
    resp["should_generate_audio"] = _wants_audio(state) and not resp.get("clarify")
    with tracer.step("response", "Saving response") as s:
        msg = Message.objects.create(
            **({"pk": state["speech_id"]} if state.get("speech_id") else {}),
            conversation_id=state["conversation_id"], role=Message.Role.ASSISTANT, content=resp["answer"], payload=resp,
            execution=tracer.run, language=resp.get("language", ""),
            referenced_documents=[d["document_id"] for d in resp.get("source_documents", [])],
            referenced_memories=[m["memory_id"] for m in resp.get("memory_sources", [])])
        Conversation.objects.filter(pk=state["conversation_id"]).update(updated_at=timezone.now())
        s.set("Stored in PostgreSQL", message_id=str(msg.id))
    tracer.emit("answer.final", message={"id": str(msg.id), "role": "assistant", "content": msg.content, "payload": resp,
                                         "created_at": msg.created_at.isoformat(), "execution": str(tracer.run.id)})
    return {"response": resp, "assistant_message_id": str(msg.id)}


def tts_node(state: AgentState, config: RunnableConfig) -> AgentState:
    from apps.conversations.models import Message
    from services.tts.engine import TTSError, engine_for, synthesize
    from apps.speech.storage import tts_dir
    tracer = _t(config)
    resp = state["response"]
    if not resp.get("should_generate_audio"):
        return {}
    lang = resp.get("language") or "en"
    prefs = state.get("prefs") or {}
    mid = state["assistant_message_id"]
    try:
        _, label = engine_for(lang)
    except TTSError as e:
        label = "TTS"
    streamer = _STREAMERS.pop(mid, None)
    if streamer:
        try:
            with tracer.step("tts", f"Speaking while writing · {label}") as s:
                try:
                    path, secs, engine = streamer.finish()
                except TTSError as e:
                    raise StepFailed(str(e)) from e
                audio = {"url": f"/api/speech/audio/{mid}/", "seconds": round(secs, 1), "engine": engine, "language": lang}
                msg = Message.objects.get(pk=mid)
                msg.payload = {**msg.payload, "audio": audio}
                msg.save(update_fields=["payload"])
                first = f" · first audio {streamer.first_audio_at:.1f}s after writing began" if streamer.first_audio_at else ""
                s.set(f"{engine} · {language_name(lang)} · {secs:.1f}s of audio{first}", **audio,
                      first_audio_s=round(streamer.first_audio_at or 0, 2))
            tracer.emit("audio.ready", message_id=mid, audio=audio)
        except Exception:
            pass
        return {}
    try:
        with tracer.step("tts", f"Generating speech · {label}") as s:
            def on_segment(seg):
                tracer.emit("audio.segment", message_id=mid, index=seg.index, url=f"/api/speech/audio/{mid}/{seg.index}/",
                            seconds=round(seg.seconds, 2))
            try:
                path, secs, engine = synthesize(resp["answer"], lang, tts_dir(mid), voice=(prefs.get("tts_voices") or {}).get(lang),
                                                speed=float(prefs.get("tts_speed") or 1.0), on_segment=on_segment)
            except TTSError as e:
                raise StepFailed(str(e)) from e
            audio = {"url": f"/api/speech/audio/{mid}/", "seconds": round(secs, 1), "engine": engine, "language": lang}
            msg = Message.objects.get(pk=mid)
            msg.payload = {**msg.payload, "audio": audio}
            msg.save(update_fields=["payload"])
            s.set(f"{engine} · {language_name(lang)} · {secs:.1f}s of audio", **audio)
        tracer.emit("audio.ready", message_id=mid, audio=audio)
    except StepFailed:
        pass  # TTS failure is non-fatal: the text answer stands; the failed step is visible in the trace
    except Exception:
        pass
    return {}


# ============================================================================================================ graph
def build_graph():
    g = StateGraph(AgentState)
    nodes = {
        "input": input_node, "asr": asr_node, "language": language_node, "intent": intent_node, "context": context_node,
        "memory_save": memory_save_node, "document_ingest": document_ingest_node, "file_search": file_search_node,
        "memory_recall": memory_recall_node, "memory_retrieval": memory_retrieval_node,
        "document_retrieval": document_retrieval_node, "wikipedia": wikipedia_node, "web_search": web_search_node,
        "llm": llm_node, "validate": validation_node, "respond": response_node, "tts": tts_node,
    }
    for k, fn in nodes.items():
        g.add_node(k, fn)
    g.add_edge(START, "input")
    g.add_conditional_edges("input", lambda s: "asr" if s.get("modality") == "voice" else "language", ["asr", "language"])
    g.add_conditional_edges("asr", lambda s: "respond" if (s.get("response") or {}).get("clarify") else "language",
                            ["respond", "language"])
    g.add_edge("language", "intent")
    g.add_edge("intent", "context")
    g.add_conditional_edges("context", route, ["memory_save", "document_ingest", "file_search", "memory_recall",
                                               "memory_retrieval", "web_search", "llm"])
    for action in ("memory_save", "document_ingest", "file_search"):
        g.add_edge(action, "respond")
    g.add_edge("memory_recall", "llm")
    g.add_edge("memory_retrieval", "document_retrieval")
    g.add_conditional_edges("document_retrieval", after_documents, ["llm", "wikipedia", "web_search"])
    g.add_conditional_edges("wikipedia", after_wikipedia, ["llm", "web_search"])
    g.add_conditional_edges("web_search", after_web, ["llm", "wikipedia"])
    g.add_edge("llm", "validate")
    g.add_edge("validate", "respond")
    g.add_edge("respond", "tts")
    g.add_edge("tts", END)
    return g.compile()


_GRAPH = None


def get_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_graph()
    return _GRAPH


def run_graph(state: AgentState, tracer: Tracer) -> dict[str, Any]:
    return get_graph().invoke(state, config={"configurable": {"tracer": tracer}, "recursion_limit": 40})
