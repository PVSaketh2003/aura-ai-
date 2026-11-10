from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class Intent(str, Enum):
    GENERAL = "general"
    SAVE_MEMORY = "save_memory"
    RECALL_MEMORY = "recall_memory"
    INGEST_DOCUMENT = "ingest_document"
    FILE_SEARCH = "file_search"
    DOCUMENT_QUESTION = "document_question"
    WEB_QUESTION = "web_question"


class IntentResult(BaseModel):
    intent: Intent
    confidence: float = Field(ge=0, le=1)
    method: str
    matched: str = ""
    forbid_memory: bool = False  # user said "do not remember this"
    documents_only: bool = False  # user asked to answer only from their documents


class SourceType(str, Enum):
    DOCUMENTS = "documents"
    MEMORIES = "memories"
    WIKIPEDIA = "wikipedia"
    WEB = "web"
    CONVERSATIONS = "conversation_history"
    COMBINED = "combined"
    MODEL = "model_knowledge"  # no retrieval: answer from the LLM's own training only
    SYSTEM = "system"


class RetrievalStatus(str, Enum):
    NOT_REQUIRED = "not_required"
    UNAVAILABLE = "unavailable"
    SUFFICIENT = "sufficient"
    PARTIAL = "partial"  # only part of the question is covered by the sources
    INSUFFICIENT = "insufficient"
    FAILED = "failed"


class SourceDocument(BaseModel):
    document_id: str
    filename: str
    page_numbers: list[int] = []


class MemorySource(BaseModel):
    memory_id: str
    content: str
    category: str = ""
    created_at: str


class ExternalSource(BaseModel):
    title: str
    url: str
    provider: str


class AgentResponse(BaseModel):
    answer: str = Field(min_length=1)
    summary: str = ""
    source_type: SourceType
    source_documents: list[SourceDocument] = []
    page_numbers: list[int] = []
    confidence: float = Field(ge=0, le=1)
    retrieval_status: RetrievalStatus
    external_sources: list[ExternalSource] = []
    language: str = "en"
    should_generate_audio: bool = False
    model: str = ""
    memory_sources: list[MemorySource] = []
    citations: dict[str, dict] = {}  # evidence id -> {kind, title, page, url, document_id}


class LLMAnswer(BaseModel):
    """What the chat model must return (Ollama constrains decoding to this schema; `answer` first for streaming)."""
    answer: str = Field(min_length=1, description="The full answer, in the requested language, citing sources like [D1]")
    summary: str = Field(default="", description="One-sentence summary in the same language")
    cited_sources: list[str] = Field(default_factory=list, description="IDs of sources actually used, e.g. D1, M2, W1")
    confidence: float = Field(ge=0, le=1, description="How well the sources support the answer")
