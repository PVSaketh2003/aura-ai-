export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface User { id: number; username: string; display_name: string }

export interface ExecutionStep {
  id: string; seq: number; key: string; name: string; status: StepStatus
  summary: string; detail: Record<string, unknown>; error: string
  started_at: string; finished_at: string | null; duration_ms: number | null
}

export interface ExecutionRun {
  id: string; conversation: string | null; status: StepStatus; intent: string; input_text: string
  error: string; started_at: string; finished_at: string | null; duration_ms: number | null
  steps: ExecutionStep[]
}

export interface Citation { kind: string; title: string; page: number | null; page_end?: number | null; url: string; document_id: string; created_at: string; similarity?: number | null; snippet?: string }
export interface AudioInfo { url: string; seconds: number; engine: string; language: string }
export interface AgentPayload {
  answer: string; summary: string; source_type: string; confidence: number; retrieval_status: string
  source_documents: { document_id: string; filename: string; page_numbers: number[] }[]
  page_numbers: number[]; external_sources: { title: string; url: string; provider: string }[]
  memory_sources: { memory_id: string; content: string; category: string; created_at: string }[]
  citations: Record<string, Citation>
  language: string; should_generate_audio: boolean; model: string; audio?: AudioInfo
  clarify?: { message_id: string; options: { language: string; language_name: string; text: string; probability: number | null }[] }
}
export interface SpeechInfo {
  selected_language: string; detected_language: string; lid_model: string; lid_confidence: number | null
  asr_model: string; asr_confidence: number | null; original_transcript: string; normalized_transcript: string
  audio_seconds: number; asr_ms: number; status: 'ok' | 'uncertain'; candidates_considered?: string[] | null
}

export interface Message {
  id: string; role: 'user' | 'assistant'; content: string; created_at: string
  modality?: 'text' | 'voice'; language?: string; execution?: string | null; payload?: Partial<AgentPayload> & { speech?: SpeechInfo }
}

export interface ConversationSummary { id: string; title: string; created_at: string; updated_at: string; message_count: number }
export interface ConversationDetail { id: string; title: string; created_at: string; updated_at: string; messages: Message[] }
export interface Page<T> { count: number; next: string | null; previous: string | null; results: T[] }

export type ModelStatus = 'running' | 'loading' | 'available' | 'downloaded' | 'unavailable' | 'auth_required' | 'failed'
export interface ModelInfo {
  role: string; name: string; runtime: string; status: ModelStatus; component?: string
  loaded: boolean; size_bytes: number | null; phase: number | null; note?: string
}
export interface Health {
  status: 'ok' | 'degraded'
  components: Record<string, { status: string; latency_ms?: number; error?: string; version?: string; url?: string }>
  models: ModelInfo[]
  resources: { cpu_percent: number; memory_total: number; memory_used: number; memory_percent: number; disk_total: number; disk_free: number }
}

export interface DocumentRec {
  id: string; filename: string; file_type: string; source: 'local_agent' | 'upload'; source_path: string; source_directory: string
  size_bytes: number; page_count: number; chunk_count: number; loader: string; loader_reason: string
  inspection: { pages?: number; text_pages?: number; scanned_pages?: number[]; table_pages?: number[]; multicolumn_pages?: number[]; scanned_ratio?: number }
  chunking_config: { strategy?: string; reason?: string; chunk_size?: number; chunk_overlap?: number; tables?: number }
  embedding_model: string; status: 'pending' | 'processing' | 'indexed' | 'failed'; embedding_status: string; index_status: string
  error: string; content_hash: string; created_at: string; updated_at: string; indexed_at: string | null
}
export interface ChunkRec { id: string; index: number; page_number: number; page_end: number; kind: string; text: string }
export interface DocumentDetail extends DocumentRec { chunks: ChunkRec[]; chunks_total: number }

export interface MemoryRec {
  id: string; content: string; category: string; category_label: string; tags: string[]; language: string
  original_text: string; vector_status: 'pending' | 'synced' | 'failed'; source_conversation: string | null
  created_at: string; updated_at: string; similarity?: number | null
}

export interface Preferences {
  asr_language: string; spoken_languages: string[]; asr_engine: 'auto' | 'indic-conformer' | 'whisper'; asr_fallback: 'whisper' | 'none'
  speak_replies: 'always' | 'voice_only' | 'never'; tts_voices: Record<string, string>; tts_speed: number
  web_search: boolean; wikipedia: boolean; multi_query: boolean; languages: Record<string, string>
}

export interface LocalAgentRoot { name: string; path: string; accessible: boolean; error: string; enabled: boolean }
export interface LocalAgentStatus {
  paired: boolean; online: boolean; id?: string; name?: string; hostname?: string; version?: string; last_seen?: string | null
  roots?: LocalAgentRoot[]; disabled_roots?: string[]
}

export type AgentEvent =
  | { kind: 'socket.ready' } | { kind: 'pong' }
  | { kind: 'run.started'; execution_id: string; conversation_id: string; input_text: string }
  | { kind: 'step.updated'; execution_id: string; step: ExecutionStep }
  | { kind: 'answer.delta'; execution_id: string; delta: string }
  | { kind: 'llm.progress'; execution_id: string; phase: 'reading' | 'writing'; tokens: number; prompt_tokens?: number; first_token_ms?: number; elapsed_ms?: number }
  | { kind: 'run.finished'; execution_id: string; status: StepStatus; error: string; duration_ms: number; message?: Message
      result?: { answer: string; documents: { document_id: string; filename: string }[] } }
  | { kind: 'answer.final'; execution_id: string; message: Message }
  | { kind: 'transcript'; execution_id: string; message_id: string; text: string; language: string; language_name: string; engine: string; speech?: SpeechInfo }
  | { kind: 'audio.segment'; execution_id: string; message_id: string; index: number; url: string; seconds: number }
  | { kind: 'audio.ready'; execution_id: string; message_id: string; audio: AudioInfo }
  | { kind: 'document.updated'; document: DocumentRec }
  | { kind: 'ingest.progress'; execution_id: string; document_id: string; filename: string; stage: string; unit: string; done: number; total: number; seq: number; ts: number; [k: string]: unknown }
  | { kind: 'local_agent.status'; status: 'online' | 'offline'; device: string; hostname: string }
