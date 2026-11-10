"""Permanent memory: PostgreSQL is the source of truth, Chroma `memories` collection is the semantic index.

Save path: extract (LLM, schema-validated) → duplicate check → Postgres (transaction) → embed → Chroma.
If embedding/indexing fails, the Postgres record stays and is marked `pending`; the background sync job retries.
"""
from __future__ import annotations

import re

import logging
from datetime import timedelta

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from pydantic import BaseModel, Field

from apps.core.models import audit
from apps.memory.models import Memory
from config.env import get_settings
from services.embeddings.qwen import MEMORY_INSTRUCTION, EmbeddingError, QwenEmbeddings
from services.vector_store import chroma_store as vs

log = logging.getLogger(__name__)
CATEGORIES = [c.value for c in Memory.Category]
DUPLICATE_SIMILARITY = 0.93


class ExtractedMemory(BaseModel):
    content: str = Field(min_length=3, max_length=2000,
                         description="Self-contained statement of the fact, written about 'the user', in the user's language")
    category: str = Field(description="One of: " + ", ".join(CATEGORIES))
    tags: list[str] = Field(default_factory=list, max_length=8)


class MemoryExtraction(BaseModel):
    memories: list[ExtractedMemory] = Field(default_factory=list, max_length=10)


EXTRACT_PROMPT = """The user explicitly asked you to save information permanently. Extract ONLY the facts they asked to save.
- Write each memory as a standalone statement about "the user" (e.g. "The user's favourite backend programming language is Golang.").
- Keep the user's language: if they wrote in Hindi, write the memory in Hindi.
- Do not add facts that were not stated. Do not include the instruction itself ("save this").
- category must be one of: {cats}. tags: 1-5 short lowercase keywords.
Return JSON."""


_META_PREFIX = re.compile(r"^\W*(the\s+)?user\s+\w+\s+(me\s+|aura\s+)?to\s+(remember|save|store|know)\s+(that\s+)?", re.I)
_META_MEMORY = re.compile(
    r"^\W*(the\s+)?user\s+(is|was|has been)\s+(providing|giving|sharing|asking|telling|requesting|saving)\b"
    r"|providing (a|this|the) memory|\b(asked|wants?|wanted|requests?|requested)\s+(me\s+|aura\s+)?to\s+(remember|save|store)\b"
    r"|^\W*(save|remember|store)\s+(this|that|it)\W*$", re.I)


# Words that only describe the act of saving. A "memory" made only of these (e.g. "This in our database.", extracted
# from "…save this in our database") carries no fact and is dropped.
_STORAGE_ONLY = set("""this that it these those in into to on at our the my your a an database db memory memories
permanently permanent forever please save saved store stored keep remember note down here there is are was it's""".split())


def _no_content(text: str) -> bool:
    words = re.findall(r"[^\W\d_]+|\d+", text.lower())
    return not words or all(w in _STORAGE_ONLY for w in words)


def extract_memories(text: str, history: list[dict] | None = None) -> MemoryExtraction:
    from services.llm.structured import generate_structured
    msgs = [{"role": "system", "content": EXTRACT_PROMPT.format(cats=", ".join(CATEGORIES))}]
    if history:  # "save this" can refer to the previous turn
        ctx = "\n".join(f"{m['role']}: {m['content'][:600]}" for m in history[-4:])
        msgs.append({"role": "user", "content": f"<recent_conversation>\n{ctx}\n</recent_conversation>"})
    msgs.append({"role": "user", "content": text})
    result, _ = generate_structured(MemoryExtraction, msgs, temperature=0, max_tokens=500)
    # Drop "memories" about the act of remembering itself (small models emit e.g. "The user is providing a memory.")
    kept = []
    for m in result.memories:
        m.content = _META_PREFIX.sub("", m.content).strip()
        m.content = m.content[:1].upper() + m.content[1:]
        if m.content and not _META_MEMORY.search(m.content) and not _no_content(m.content):
            kept.append(m)
    result.memories = kept
    for m in result.memories:
        if m.category not in CATEGORIES:
            m.category = Memory.Category.OTHER
        m.tags = [t.strip().lower()[:32] for t in m.tags if t.strip()][:8]
    return result


def _embedder() -> QwenEmbeddings:
    return QwenEmbeddings(instruction=MEMORY_INSTRUCTION)


def _meta(m: Memory) -> dict:
    return {"memory_id": str(m.id), "user_id": m.user_id, "memory_type": m.category, "memory_text": m.content[:2000],
            "creation_timestamp": m.created_at.isoformat(), "tags": ",".join(m.tags), "language": m.language}


def index_memory(m: Memory, vector: list[float] | None = None) -> bool:
    try:
        vector = vector or _embedder().embed_documents([m.content])[0]
        vs.upsert(vs.MEMORIES, [str(m.id)], [vector], [m.content], [_meta(m)])
        Memory.objects.filter(pk=m.pk).update(vector_status=Memory.VectorStatus.SYNCED, vector_error="",
                                              vector_synced_at=timezone.now())
        return True
    except (EmbeddingError, vs.VectorStoreError) as e:
        Memory.objects.filter(pk=m.pk).update(vector_status=Memory.VectorStatus.FAILED, vector_error=str(e)[:1000])
        log.warning("memory %s not indexed yet: %s", m.id, e)
        return False


def find_duplicate(user_id: int, content: str, vector: list[float] | None) -> tuple[Memory | None, float]:
    norm = " ".join(content.lower().split())
    exact = Memory.objects.filter(user_id=user_id, status=Memory.Status.ACTIVE)
    for m in exact.filter(content__iexact=content)[:1]:
        return m, 1.0
    if vector is None:
        return None, 0.0
    try:
        hits = vs.query(vs.MEMORIES, vector, k=1, where={"user_id": user_id})
    except vs.VectorStoreError:
        return None, 0.0
    if hits and hits[0]["similarity"] >= DUPLICATE_SIMILARITY:
        m = exact.filter(pk=hits[0]["metadata"]["memory_id"]).first()
        if m and " ".join(m.content.lower().split()) != norm:
            return m, hits[0]["similarity"]
        return m, hits[0]["similarity"] if m else 0.0
    return None, hits[0]["similarity"] if hits else 0.0


def save_memory(user, content: str, category: str, tags: list[str], *, language: str = "en", original_text: str = "",
                conversation=None, message=None) -> tuple[Memory, str, bool]:
    """Returns (memory, outcome, indexed). outcome: created | duplicate."""
    vector = None
    try:
        vector = _embedder().embed_documents([content])[0]
    except EmbeddingError:
        pass  # still save to Postgres; background sync will index it
    dup, sim = find_duplicate(user.id, content, vector)
    if dup:
        return dup, "duplicate", dup.vector_status == Memory.VectorStatus.SYNCED
    with transaction.atomic():
        m = Memory.objects.create(user=user, content=content.strip(), category=category, tags=tags, language=language,
                                  original_text=original_text[:4000], source_conversation=conversation, source_message=message)
    audit(user, "memory.created", str(m.id), category=category)
    indexed = index_memory(m, vector) if vector else False
    return m, "created", indexed


def update_memory(m: Memory, **fields) -> Memory:
    for k, v in fields.items():
        setattr(m, k, v)
    m.vector_status = Memory.VectorStatus.PENDING
    m.save()
    audit(m.user, "memory.updated", str(m.id), fields=list(fields))
    index_memory(m)
    return m


def delete_memory(m: Memory) -> None:
    try:
        vs.delete_ids(vs.MEMORIES, [str(m.id)])
    except vs.VectorStoreError as e:
        log.warning("vector delete failed for %s: %s", m.id, e)
    audit(m.user, "memory.deleted", str(m.id), content_preview=m.content[:80])
    m.delete()


def search_memories(user_id: int, query: str, k: int = 6, vector: list[float] | None = None,
                    min_similarity: float | None = None) -> list[dict]:
    """Semantic search over the index, joined back to Postgres (authoritative), with a keyword fallback."""
    min_similarity = get_settings().memory_min_similarity if min_similarity is None else min_similarity
    results: dict[str, dict] = {}
    try:
        vector = vector or _embedder().embed_query(query)
        for h in vs.query(vs.MEMORIES, vector, k=k, where={"user_id": user_id}):
            if h["similarity"] >= min_similarity:
                results[h["metadata"]["memory_id"]] = {"similarity": round(h["similarity"], 3), "match": "semantic"}
    except (EmbeddingError, vs.VectorStoreError) as e:
        log.warning("semantic memory search unavailable: %s", e)
    words = [w for w in query.split() if len(w) > 3][:6]
    if words:
        q = Q()
        for w in words:
            q |= Q(content__icontains=w)
        for m in Memory.objects.filter(q, user_id=user_id, status=Memory.Status.ACTIVE).values_list("id", flat=True)[:k]:
            results.setdefault(str(m), {"similarity": None, "match": "keyword"})
    mems = {str(m.id): m for m in Memory.objects.filter(pk__in=list(results), user_id=user_id, status=Memory.Status.ACTIVE)}
    out = [{"memory": mems[i], **r} for i, r in results.items() if i in mems]
    out.sort(key=lambda x: -(x["similarity"] or 0.0))
    return out[:k]


def sync_pending(limit: int = 50) -> int:
    """Background job: index memories whose vector sync is pending/failed."""
    stale = timezone.now() - timedelta(seconds=30)
    n = 0
    for m in Memory.objects.filter(status=Memory.Status.ACTIVE, vector_status__in=["pending", "failed"],
                                   updated_at__lt=stale)[:limit]:
        n += index_memory(m)
    return n


def rebuild_index(user_id: int | None = None) -> int:
    qs = Memory.objects.filter(status=Memory.Status.ACTIVE)
    if user_id:
        qs = qs.filter(user_id=user_id)
        vs.delete_where(vs.MEMORIES, {"user_id": user_id})
    n = 0
    for m in qs.iterator():
        n += index_memory(m)
    return n
