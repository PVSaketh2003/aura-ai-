# Aura: voice-first, multilingual personal RAG agent

Talk or type in Telugu, Hindi, English or another Indian language — including code-mixed speech like
*“Naaku YOLO model training gurinchi explain cheyyi”*. Aura works out what you want and picks the workflow: answer
from your PDFs with page citations, fall back to Wikipedia or the web, load PDFs from your Mac, or remember something
permanently. **It answers in the language you asked in, as text and voice**, and every step is streamed live to
Mission control (Steps / X-ray).

Everything runs locally on an Apple-silicon Mac (built and tuned on an M4 with 16 GB).

## Run it

```bash
# one-time services (Homebrew): postgresql@15, redis, ollama, tesseract, ffmpeg, espeak-ng, poppler
brew services start postgresql@15 && brew services start redis && brew services start ollama
ollama pull gemma3:4b && ollama pull qwen3-embedding:4b        # llama3.1:8b / qwen2.5:3b = optional fallbacks

# backend — always with --noreload (autoreload loads every model twice; 16 GB can't hold that)
cd backend && .venv/bin/python manage.py migrate
cd backend && .venv/bin/python manage.py runserver 127.0.0.1:8000 --noreload
# frontend
cd frontend && npm run dev                                       # http://localhost:5173
# Local Mac Agent (launchd, pairs automatically)
./scripts/install_local_agent.sh
```

Stop the backend with Ctrl+C, or `kill -9 $(lsof -ti tcp:8000 -sTCP:LISTEN)`.
The first start takes a while: Gemma, the embedder, Kokoro, Whisper, VoxLingua and IndicConformer are warmed up before the first question.

### IndicConformer (AI4Bharat) — the speech engine for Indian languages

AI4Bharat IndicConformer-600M (22 Indian languages) transcribes Telugu, Hindi and the other Indian languages; Whisper
handles English. Measured on the same recordings, Telugu word error rate fell from 80% (Whisper) to 21%
(`backend/evaluation/asr/README.md`). The model is gated on Hugging Face, so a one-time setup is needed:

1. Signed in at huggingface.co, open <https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual> and click
   **Agree and access repository**.
2. Use a token of type **Read**, or a fine-grained token with *“Read access to contents of all public gated repos you
   can access”* ticked, and run `cd backend && .venv/bin/hf auth login` in Terminal (don't paste tokens into chats).
3. The first use downloads 2.4 GB into `~/.cache/huggingface` (Aura refuses if less than 4.5 GB of disk is free).

Aura runs the model from its ONNX/TorchScript files with its own loader (`services/asr/indic_conformer.py`); it does
not execute the repository's `trust_remote_code` Python. Once the weights are on disk it works offline. Until then
Settings shows *Login required* and Whisper is used.

## Architecture

```
React (Vite, Tailwind, motion) ──REST + WebSocket──▶ Django / DRF / Channels (Daphne, ASGI)
                                                     │
                     LangGraph agent ◀───────────────┤  PostgreSQL: users, conversations, messages (+ per-turn speech
  input → asr → language → intent → context → route  │    metadata), traces, documents, chunks, memories, audit log
   ├ memory_save   ├ document_ingest   ├ file_search  │  ChromaDB: "documents", "memories" (cosine, 2560-d)
   ├ memory_recall ├ memory_retrieval → document_retrieval → wikipedia → web
   └ prompt → LLM (Gemma 3 4B, streamed) → validate → respond → TTS (sentence by sentence)
                                                     │  Redis: Channels layer + Local Agent RPC
Local Mac Agent (launchd) ══ device-token WebSocket ══╡  file bytes over HTTP, SHA-256 verified
  allow-listed folders only · no shell · no writes/deletes
```

| Concern | Choice |
|---|---|
| Chat | Gemma 3 4B via Ollama (fallbacks Llama 3.1 8B, Qwen 2.5 3B), plain-text streaming with `[D1]`/`[W1]` citations |
| Embeddings | Qwen3-Embedding-4B via Ollama, instruction-prefixed queries, L2-normalised, 2560-d, LRU-cached |
| Vectors | ChromaDB persistent (`backend/data/chroma`) |
| Speech → text | AI4Bharat IndicConformer-600M (ONNX, CTC) for Indian languages; MLX Whisper large-v3-turbo on the GPU for English and as fallback; your own fine-tuned Whisper if trained |
| Spoken-language ID | SpeechBrain VoxLingua107 **fused with** Whisper LID and a trial transcription per candidate language |
| Text → speech | Kokoro-82M (en, hi, es, fr, it, pt); Meta MMS-TTS (te, ta, kn, ml, bn, mr, gu, pa, or, as, ur) |
| PDFs | inspection (PyMuPDF), then PyPDF / PDFPlumber / PyMuPDF / Unstructured+OCR; DirectoryLoader for folders |
| Retrieval | similarity → MultiQuery (only near the threshold) → MMR → calibrated gate + LLM relevance check → Wikipedia → web |

## Speech recognition and language routing

ASR (what was said) and language identification (which language) are separate problems, solved by separate models.

```
recording → 16 kHz WAV ─┬─ you picked a language ──────────▶ that language is FINAL (no detector can override it)
                        └─ Auto ─▶ candidates = Settings → “Languages I speak” (default te, hi, en)
                           stage 1  English or Indian?   0.75·Whisper LID(en) + 0.25·VoxLingua107(en)
                           stage 2  which Indian?        IndicConformer: one encoder pass, CTC per candidate language;
                                                         the language whose vocabulary explains the audio best wins
                           → winner < 0.55, or no Indian language fits (confidence < 0.45) → Aura ASKS which
                             language you spoke (transcripts as buttons) instead of guessing
language ─▶ engine: your fine-tuned Whisper → IndicConformer-600M (Indian languages) → Whisper large-v3-turbo (MLX)
         ─▶ validation (script, repetition) — a rejected transcript falls back to the next engine
         ─▶ original-language transcript → agent → answer in that language → TTS voice for that language
```

**Root cause of “Telugu heard as Marathi/Tamil/Gujarati”, measured on the owner's recordings
(`backend/evaluation/asr/README.md`):** the transcriber itself was Whisper, which writes Telugu poorly (80% WER on
FLEURS Telugu even with Telugu selected); and its language ID heard the owner's Telugu as *Hindi* (0.76–0.99) while
VoxLingua107 heard the accent (English → Telugu, code-mixed Telugu → Marathi). Now Whisper only answers “is this
English?”, which it does reliably, and IndicConformer — trained on Indian speech — both picks the Indian language and
transcribes it. On 95 labelled clips: language ID 100% (was 93.7%), Telugu WER 21% (was 81%), Hindi 11% (was 35%).

Code-mixed speech stays in its language: IndicConformer writes the English terms in the native script — the owner's
*“konchem naaku support vector machine gurinchi detail information istara”* comes out as
*కొంచెం నాకు సపోర్ట్ వెక్టర్ మెషిన్ గురించి డీటెయిల్ ఇన్ఫర్మేషన్ ఇస్తారా* — which the agent understands, retrieves on
(via an English retrieval query) and answers in Telugu with the technical terms kept.

Every voice turn stores (on the user message, `payload.speech`): selected language, detected language, LID method and
confidence, ASR model and confidence, original and normalised transcript, audio length and timing. The chat shows it
under each voice message; the voice screen and X-ray show the per-language evidence.

Typed text: native script decides; romanized Telugu/Hindi (*naaku, gurinchi, cheyyi / mujhe, samjhao, baare*) is
recognised as Telugu/Hindi, not English; code-mixed text keeps its language.

## Multilingual retrieval

The original question is never replaced. For a non-English question Aura also writes a retrieval-only English query
(qualifiers, names and numbers kept; the language name is never added), searches the PDFs with **both**, merges and
de-duplicates the candidates (each scored by its best match), then applies MMR and the relevance gate. Answers say where
each fact came from — `D` your PDFs, `W` Wikipedia, `S` web, `M` your memory — and anything unsourced is labelled
*general knowledge · unverified*. Citation ids that weren't retrieved are removed.

## Answers

Prompt templates are chosen per question: explain, code (complete runnable block, shown not spoken), comparison
(table), summary, maths (step by step), how-to (numbered), research (sectioned, cited), translate, chat. Responses
stream token by token; speech starts sentence by sentence while writing; code and citation markers are never read aloud.

## Memory

Only explicit requests (“remember that…”, “save this in our database”) are saved; “don't remember this” always wins.
LLM extraction (Pydantic) → junk filter → duplicate check → PostgreSQL (transaction) → embedding → ChromaDB, with a
background retry if indexing fails. `POST /api/memory/rebuild/` rebuilds the vector index from PostgreSQL.

## Aura Messenger

Chats, groups, calls and file sharing with people you save by phone number, next to the Aura AI assistant
(left rail → Messenger). Backend: `backend/apps/messenger/`; frontend: `pages/MessengerPage.tsx`,
`components/messenger/`, `context/MessengerContext.tsx`.

| Area | What is implemented |
|---|---|
| Accounts | Owner login unchanged. New people sign up / sign in with a phone number + one-time SMS code (E.164, `phonenumbers`). Codes: 10-min expiry, 5 attempts, 3 per number per 15 min, 10 per IP per hour; only an HMAC of the code is stored (dev) or none at all (Twilio Verify). Sign-up responses never reveal whether a number is registered. |
| Contacts | Save any number; "on Aura" only when a verified, discoverable account owns it. Exact-number lookup only (rate limited), no directory. Edit, delete, search, invite text for people not on Aura. |
| Chats | Real-time over `/ws/messenger/` (Django Channels). Per-chat `seq` ordering, `client_id` de-duplication on retries, catch-up after reconnects (`?after=<seq>`), gap detection. Reply, forward, edit (15 min), delete for everyone, copy, react, pin, typing, sent → delivered → read derived from members' acknowledged positions. Message requests when you only accept messages from contacts. Block & report. |
| Groups | Create from saved contacts (name, photo, description, review). Owner / admin / member roles enforced by the backend: add, remove, promote/demote, rename, photo, description, pin, delete group (owner), leave (ownership passes on). New members don't see earlier history. Mute, archive. |
| Files | Images, video, audio, voice messages, PDFs, Office/text documents. Drag & drop, paste, multi-file, real upload progress, cancel, retry. Content-addressed storage (one physical copy per SHA-256), served only to members of chats containing the file, with `Content-Security-Policy: sandbox` and `nosniff`; executables/HTML/SVG refused. 100 MB per file, 2 GB quota per user (env). Media & Files view with filters. |
| Calls | One-to-one voice and video calls with WebRTC (media goes browser-to-browser, DTLS-SRTP encrypted); signalling relayed by the server only between the two members of the call. Ringing, answer, decline, missed, busy, duration, call history, mute, camera on/off. |
| Aura AI in chats | Summarise, action items, translate (Telugu/Hindi/English), explain. Reads only the chat you're in (from when you joined), treats it as untrusted data, and shows the result only to you. |

**Configure SMS** (`backend/.env`): `SMS_BACKEND=twilio` + `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_VERIFY_SERVICE_SID` (Twilio Verify service). `SMS_BACKEND=dev` is for local testing only: it works only with
`DJANGO_DEBUG=true` and writes codes to `backend/data/dev_sms_outbox/`.

**Calls across networks** need STUN/TURN: set `WEBRTC_ICE_SERVERS` to a JSON list (e.g. your own coturn server).
Without it, calls work on the same machine/network only. Friends on other devices also need to reach this server:
serve Aura over HTTPS on a reachable host and add it to `ALLOWED_HOSTS` / `FRONTEND_ORIGINS` (browsers only allow
microphone/camera on HTTPS or localhost).

**Encryption:** messages and files are encrypted in transit when served over HTTPS and access-controlled at rest on
this server, but they are **not end-to-end encrypted**: the server owner can read them. Call media is encrypted
end-to-end between the two browsers by WebRTC.

**Not yet implemented:** group calls, speaker-device selection, contact-book sync, invitations by SMS (an invite text
is copied for you to send), push notifications when the browser is closed (desktop notifications work while Aura is open).

## Deployment on Render (aura.pvsairamsaketh.in)

```
git push ─► GitHub Actions: backend tests (Postgres+Redis) · frontend lint/types/build · Docker builds
                 │ all green
                 ▼
Render (render.yaml, autoDeployTrigger: checksPass, per-folder buildFilter)
   aura-frontend  https://aura.pvsairamsaketh.in       nginx + React build   frontend/Dockerfile   (free)
   aura-backend   https://api.aura.pvsairamsaketh.in   Daphne + Django       backend/Dockerfile    (starter + 5 GB disk)
   aura-db        PostgreSQL 16 (private)              aura-redis  Key Value for Channels (free, private)
```

* The browser calls the API host directly: REST over HTTPS and `wss://` WebSockets (`VITE_API_URL`, built into the
  bundle). Media links in the page (images, voice notes, files, spoken answers) are pointed at the API host too.
* Login across subdomains: over HTTPS on `*.pvsairamsaketh.in` the session/CSRF cookies get `Domain=.pvsairamsaketh.in`,
  `Secure`, `HttpOnly` (session) and `SameSite=Lax`. `aura.` and `api.aura.` are the same *site*, so Lax is correct
  (SameSite=None isn't needed). CORS and CSRF trust exactly `https://aura.pvsairamsaketh.in`; CSRF stays on, also for
  sign-in. On localhost the cookies stay plain, so local development is unchanged (`apps/core/cookies.py`).
* `/healthz` on both services is the liveness probe; `https://api.aura.pvsairamsaketh.in/api/health/` checks the
  database and Redis. Migrations run at every backend start and only add tables or columns.

**What runs differently on Render (and how to get it back)**

| Local Mac feature | On Render | To restore |
|---|---|---|
| Ollama LLM (gemma3:4b) + qwen3 embeddings | `LLM_PROVIDER=openai`: any OpenAI-compatible API for chat **and** embeddings | — (set the provider variables) |
| Voice in/out (Whisper, IndicConformer, VoxLingua, Kokoro) | `LOCAL_SPEECH=false`: voice input asks you to type; replies are text | Backend plan **pro** (4 GB) + `LOCAL_SPEECH=true` + `HF_TOKEN` |
| MLX Whisper on the Apple GPU | not available in Linux containers | CPU faster-whisper is used automatically when speech is on |
| Local Mac Agent (load PDFs from your Mac) | needs the agent on a Mac that can reach the API | install the agent and point it at `api.aura…` |
| Your local PDFs, memories, chats | the cloud database starts empty | upload PDFs again in Library (they're re-embedded with the cloud model) |

**Deploy (one time)**
1. Push to `main`.
2. Render → **New → Blueprint** → connect GitHub → `PVSaketh2003/aura-ai-` → it reads `render.yaml` → enter the
   `sync: false` values (table below) → **Apply**. Render asks for a card: the backend (starter + disk) and Postgres are
   paid, about **US$14/month** in total; the frontend and Key Value are free.
3. Wait for both services to be **Live**. Each one's **Settings → Custom Domains** already lists its domain from the
   Blueprint, together with the exact target Render wants.
4. Cloudflare → `pvsairamsaketh.in` → **DNS → Records** → *Add record* (leave every existing record alone, including
   the root `A` record and `www` used by the Vercel site, and all email records):

   | Type | Name | Target (copy it from Render) | Proxy status |
   |---|---|---|---|
   | CNAME | `aura` | the target Render shows for **aura-frontend** (normally `aura-frontend.onrender.com`) | **DNS only** (grey) |
   | CNAME | `api.aura` | the target Render shows for **aura-backend** (normally `aura-backend.onrender.com`) | **DNS only** (grey) |

   If a CNAME `aura` already exists, edit it instead of adding a second one.
5. In Render press **Verify** on each domain; certificates are issued in a few minutes.
6. Optional, after both show *Certificate issued*: switch the two records to **Proxied** (orange) and set Cloudflare
   **SSL/TLS → Overview → Full (strict)**. Render supports this; keep DNS only if anything misbehaves.
7. GitHub → Actions → CI/CD → **Run workflow** → `smoke_test` checks the live site.

**Environment variables**

*aura-backend* (Render → aura-backend → Environment). Secrets are typed here only, never committed:

| Variable | Value |
|---|---|
| `DJANGO_SECRET_KEY` | generated by Render |
| `DJANGO_DEBUG` | `false` |
| `ALLOWED_HOSTS` | `api.aura.pvsairamsaketh.in,aura.pvsairamsaketh.in,.onrender.com` |
| `FRONTEND_ORIGINS` | `https://aura.pvsairamsaketh.in` (used for both CORS allowed origins and CSRF trusted origins) |
| `COOKIE_DOMAIN` | `.pvsairamsaketh.in` |
| `SECURE_COOKIES`, `BEHIND_HTTPS_PROXY` | `true` |
| `DATABASE_URL` | from `aura-db` (internal URL) |
| `REDIS_URL` | from `aura-redis` (internal URL) |
| `MEDIA_ROOT`, `CHROMA_PATH` | `/var/data/media`, `/var/data/app/chroma` (persistent disk) |
| `LLM_PROVIDER` | `openai` |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | your provider, e.g. `https://api.openai.com/v1`, your key, `gpt-4o-mini` |
| `EMBEDDING_MODEL`, `EMBEDDING_DIM` | e.g. `text-embedding-3-small`, `1536` (`EMBEDDING_BASE_URL`/`_API_KEY` default to the LLM ones) |
| `LOCAL_SPEECH` | `false` (see above) |
| `SMS_BACKEND`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` | optional: `twilio` + Twilio Verify credentials enable phone sign-up |
| `WEBRTC_ICE_SERVERS` | STUN by default; add a TURN server for calls across strict networks |
| `PORT` | set by Render automatically |

*aura-frontend* (public, built into the JavaScript): `VITE_API_URL=https://api.aura.pvsairamsaketh.in`. No secrets.
Render passes it to the Docker build as a build argument.

**Any OS with Docker:** `cp .env.docker.example .env`, set the values, then `docker compose up -d` → http://localhost:8080.

## Configuration

`backend/.env` (mode 600; never sent to the browser) — see `backend/.env.example` and `backend/config/env.py`:

| Variable | Default | |
|---|---|---|
| `LLM_MODEL` / `LLM_FALLBACK_MODELS` | `gemma3:4b` / — | chat model and fallbacks (Ollama) |
| `EMBEDDING_MODEL` | `qwen3-embedding:4b` | |
| `INDIC_ASR_MODEL` | `ai4bharat/indic-conformer-600m-multilingual` | gated (see above) |
| `INDIC_DECODING` | `ctc` | `ctc` (best Telugu WER) or `rnnt` |
| `WHISPER_MODEL` | `mobiuslabsgmbh/faster-whisper-large-v3-turbo` | CPU fallback, only used if the MLX weights are missing |
| `RETRIEVAL_K` / `RETRIEVAL_MIN_SIMILARITY` | 4 / 0.45 | passages sent to the LLM / gate |
| `MODEL_IDLE_UNLOAD_SECONDS` | 600 | idle models are unloaded (16 GB) |
| `WEB_SEARCH_ENABLED` | true | |

Per-user settings (Settings page): languages I speak, default spoken language, preferred ASR engine
(best available / IndicConformer / Whisper), fallback engine, reply voice and speed, Wikipedia, web, MultiQuery.
Settings also shows every model's real state: running, loading, available/downloaded, login required, failed.

## Testing

```bash
cd backend && .venv/bin/python -m pytest                          # unit + integration (real Postgres/Chroma, model stand-ins)
cd frontend && npm run build && npm run lint
# speech recognition on real audio, real models (WER, CER, language-ID accuracy, latency) — see evaluation/asr/README.md:
cd backend && .venv/bin/python -m evaluation.asr_eval evaluation/asr/fleurs/{te,hi,en}.tsv evaluation/asr/user/lid.tsv \
    media/voice_profile/<user id>/manifest.jsonl --systems legacy,auto,selected,indic --out evaluation/asr/results.json
cd backend && .venv/bin/python -m evaluation.run <dataset.jsonl>  # retrieval/answer quality
```

`evaluation/asr/` holds the datasets (FLEURS test clips with human-verified transcripts; the owner's labelled
recordings) and the measured results. Recordings made on **Train my voice** — including code-mixed Telugu+English
and Hindi+English sentences — become a personal, reference-checked test set (and LoRA fine-tuning data:
`scripts/finetune_voice.py`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Telugu heard as another language | Settings → *Languages I speak*: keep only yours; or pick తెలుగు next to the mic (authoritative) |
| Aura asks “which language did you say?” | Detection wasn't confident — tap the right transcript; it re-runs the same recording |
| Settings: IndicConformer *Login required* | see *IndicConformer* above (terms + a token that can read gated repos) |
| Voice: “couldn't make out any speech (whisper failed (RuntimeError))” | fixed: audio is now decoded to NumPy; MLX ≥0.30 rejects MLX arrays created on another thread |
| `Errno 48 address in use` | the backend is already running: `kill -9 $(lsof -ti tcp:8000 -sTCP:LISTEN)` |
| Slow / stalls | memory or disk pressure: close heavy apps; keep >5 GB free; never run without `--noreload` |
| Redis errors (1011) | redis-py must stay < 6 |

## Security

- Session auth with CSRF; single owner; throttling; owner-scoped querysets; audit log for auth, file and memory operations.
- Local agent: folder allow-list enforced **on the Mac**, symlinks resolved, path traversal blocked, hidden files,
  non-PDFs and oversize files rejected, no shell execution, no writes or deletes. The server can only narrow access.
- Retrieved text is wrapped as untrusted `<source>` data and never followed as instructions.
- Secrets live only in `backend/.env`; nothing secret reaches the browser or the logs.
