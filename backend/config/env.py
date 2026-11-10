"""Typed application configuration loaded from environment variables / backend/.env.

Secrets live only here (server side). Nothing in this module is ever serialized to the frontend
except through explicit, redacted views in apps.system.
"""
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from typing import Annotated

from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

CSV = Annotated[list[str], NoDecode]

BASE_DIR = Path(__file__).resolve().parent.parent


class AppSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BASE_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    django_secret_key: str = Field(min_length=32)
    django_debug: bool = False
    allowed_hosts: CSV = ["127.0.0.1", "localhost"]
    frontend_origins: CSV = ["http://localhost:5173", "http://127.0.0.1:5173"]

    database_url: str = "postgresql://localhost/ai_rag_agent"
    redis_url: str = "redis://127.0.0.1:6379/0"

    # --- LLM (Ollama by default; any OpenAI-compatible remote endpoint can be added later) ---
    ollama_base_url: str = "http://127.0.0.1:11434"
    # Bearer token for a remote/hosted Ollama endpoint (e.g. Ollama behind an authenticating proxy). Empty = none.
    ollama_api_key: str = ""
    # "ollama" (default: local Ollama, the Mac setup) or "openai": any OpenAI-compatible cloud API (OpenAI, Groq,
    # OpenRouter, Together, …) — used where Ollama can't run, e.g. on Render. Key and URL come only from the environment.
    llm_provider: str = "ollama"
    llm_base_url: str = ""          # e.g. https://api.groq.com/openai/v1
    llm_api_key: str = ""
    # Embeddings follow the same switch; by default they reuse the LLM provider's URL and key.
    embedding_provider: str = ""    # "" = same as llm_provider
    embedding_base_url: str = ""
    embedding_api_key: str = ""
    llm_model: str = "gemma3:4b"  # best Indic-language quality + ~2x speed on a 16 GB Mac (vs llama3.1:8b)
    llm_fallback_models: CSV = []
    llm_timeout_seconds: float = 180.0
    llm_temperature: float = 0.3
    conversation_context_messages: int = 12

    # --- Embeddings / vector store ---
    embedding_model: str = "qwen3-embedding:4b"
    embedding_dim: int = 2560
    embedding_batch_size: int = 16
    chroma_path: Path = BASE_DIR / "data" / "chroma"

    # --- Storage & limits ---
    media_root: Path = BASE_DIR / "media"
    max_pdf_bytes: int = 150 * 1024 * 1024
    max_audio_bytes: int = 25 * 1024 * 1024
    max_audio_seconds: int = 120

    # --- Speech ---
    whisper_model: str = "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    indic_asr_model: str = "ai4bharat/indic-conformer-600m-multilingual"
    indic_decoding: str = "ctc"  # ctc (fast greedy) or rnnt (transducer); chosen from evaluation/asr results
    # int8 encoder: 1.7 GB instead of 2.7 GB RAM, 30% faster, same CER (evaluation/asr/README.md). Built once from the
    # downloaded fp32 weights into data/models/indic-conformer-int8/ (needs ~3 GB free disk while building).
    indic_int8: bool = True
    # Local speech models (Whisper, IndicConformer, VoxLingua, Kokoro TTS) need ~3–4 GB RAM. Off on small cloud
    # instances (Render 512 MB): voice input then answers with a clear message and replies are text-only.
    local_speech: bool = True
    model_idle_unload_seconds: int = 600

    # --- Retrieval (defaults are overridden by data/retrieval_calibration.json when calibrated) ---
    retrieval_fetch_k: int = 24
    retrieval_k: int = 4  # passages sent to the LLM; each costs ~2 s of prompt reading on a 16 GB M4
    retrieval_mmr_lambda: float = 0.55
    retrieval_min_similarity: float = 0.45
    # PDF-first decision (services/retrievers/decision.py): share of the question's key terms the passages must cover
    # before strong similarity alone may skip the relevance judge; and Wikipedia's evidence-quality floor.
    evidence_coverage_min: float = 0.6
    wiki_coverage_min: float = 0.5
    memory_min_similarity: float = 0.5
    web_search_enabled: bool = True

    # --- Local Mac Agent ---
    local_agent_timeout_seconds: float = 30.0

    # --- Production / hosting ---
    # Share the session + CSRF cookies across subdomains (e.g. ".pvsairamsaketh.in": frontend aura.…, API api.aura.…)
    cookie_domain: str = ""
    secure_cookies: bool = False  # HTTPS-only cookies; enable in production
    behind_https_proxy: bool = False  # trust X-Forwarded-Proto from the hosting proxy (Render)

    # --- Messenger ---
    # SMS delivery for phone verification: "twilio" (Twilio Verify) or "dev" (DEBUG-only local outbox file); "" = off
    sms_backend: str = ""
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_verify_service_sid: str = ""
    messenger_max_upload_bytes: int = 100 * 1024 * 1024
    messenger_quota_bytes: int = 2 * 1024 * 1024 * 1024  # per user
    # WebRTC ICE servers as JSON, e.g. [{"urls":"stun:stun.example.org:3478"},{"urls":"turn:…","username":"…","credential":"…"}]
    # Empty = host candidates only (works on localhost / the same network; calls across the internet need STUN/TURN).
    webrtc_ice_servers: str = "[]"

    @field_validator("llm_fallback_models", "allowed_hosts", "frontend_origins", mode="before")
    @classmethod
    def _split_csv(cls, v):
        if isinstance(v, str):
            return [s.strip() for s in v.split(",") if s.strip()]
        return v


@lru_cache
def get_settings() -> AppSettings:
    return AppSettings()  # type: ignore[call-arg]
