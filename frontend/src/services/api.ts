import type { ConversationDetail, ConversationSummary, DocumentDetail, DocumentRec, ExecutionRun, Health, LocalAgentStatus, MemoryRec, Message, Page, Preferences, User } from '../types'

export interface GalaxyPoint { id: string; x: number; y: number; z: number; page: number | null; doc: string; file: string; text: string }

export interface VoiceSampleRec { id: string; language: string; index: number; text: string; heard: string; accuracy: number | null; seconds: number; created_at: string }
export interface VoiceProfile { prompts: Record<string, string[]>; samples: VoiceSampleRec[]; stats: Record<string, { samples: number; seconds: number; accuracy: number | null }>; dataset_dir: string }

export interface FreeSegment { id: string; index: number; start: number; end: number; language: string; language_name: string; language_probability: number | null; language_uncertain: boolean; heard: string; confidence: number | null; engine: string; corrected: string; verified: boolean; accuracy: number | null }
export interface FreeSession { id: string; seconds: number; status: 'queued' | 'processing' | 'done' | 'failed'; total_segments: number; done_segments: number; verified: number; error: string; created_at: string; segments?: FreeSegment[] }
export interface FreeSummary { seconds: number; segments: number; verified: number; accuracy: number | null; per_language: Record<string, { verified: number; accuracy: number | null }>; language_mix: Record<string, number>; vocabulary: Record<string, string[]>; corrections: Record<string, { wrong: string; right: string; times: number }[]> }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

function csrf(): string {
  return document.cookie.split('; ').find((c) => c.startsWith('csrftoken='))?.split('=')[1] ?? ''
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  if (method !== 'GET') headers.set('X-CSRFToken', decodeURIComponent(csrf()))
  let res: Response
  try {
    res = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'Can’t reach the Aura server. Is the backend running?')
  }
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = body.detail ?? Object.values(body).flat().join(' ') ?? res.statusText
    throw new ApiError(res.status, String(msg || `Request failed (${res.status})`))
  }
  return body as T
}

const json = (b: unknown) => JSON.stringify(b)

export const api = {
  session: () => request<{ authenticated: boolean; user: User | null; setup_required: boolean; setup_code_required?: boolean }>('/api/auth/session/'),
  setup: (b: { username: string; password: string; display_name: string; setup_code?: string }) =>
    request<{ user: User }>('/api/auth/setup/', { method: 'POST', body: json(b) }),
  login: (b: { username: string; password: string }) => request<{ user: User }>('/api/auth/login/', { method: 'POST', body: json(b) }),
  logout: () => request<void>('/api/auth/logout/', { method: 'POST' }),

  chat: (message: string, conversation_id?: string | null) =>
    request<{ execution_id: string; conversation_id: string; message: Message }>('/api/agent/chat/', {
      method: 'POST', body: json({ message, conversation_id: conversation_id ?? null }),
    }),
  execution: (id: string) => request<ExecutionRun>(`/api/agent/execution/${id}/`),
  activeRuns: () => request<(ExecutionRun & { progress?: Record<string, { done: number; total: number; unit: string }> })[]>('/api/agent/runs/active/'),
  /** Upload with real byte progress (fetch can't report upload progress, XHR can). */
  uploadDocumentWithProgress: (file: File, onProgress: (loaded: number, total: number) => void) =>
    new Promise<{ execution_id: string }>((resolve, reject) => {
      const fd = new FormData(); fd.append('file', file)
      const x = new XMLHttpRequest()
      x.open('POST', '/api/documents/ingest/')
      x.withCredentials = true
      x.setRequestHeader('X-CSRFToken', decodeURIComponent(csrf()))
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total) }
      x.onload = () => {
        let body: any = {}
        try { body = JSON.parse(x.responseText) } catch { /* */ }
        if (x.status >= 200 && x.status < 300) resolve(body)
        else reject(new ApiError(x.status, body.detail ?? `Upload failed (${x.status})`))
      }
      x.onerror = () => reject(new ApiError(0, 'Can’t reach the Aura server. Is the backend running?'))
      x.send(fd)
    }),

  conversations: (q = '') => request<Page<ConversationSummary>>(`/api/conversations/?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  conversation: (id: string) => request<ConversationDetail>(`/api/conversations/${id}/`),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${id}/`, { method: 'DELETE' }),

  health: () => request<Health>('/api/health/'),

  warmSpeech: () => request<{ warming: boolean }>('/api/speech/warm/', { method: 'POST' }),
  voiceRetry: (message_id: string, language: string) =>
    request<{ execution_id: string; conversation_id: string; message: Message }>('/api/agent/voice/retry/', { method: 'POST', body: json({ message_id, language }) }),
  voice: (audio: Blob, conversation_id?: string | null, language?: string) => {
    const fd = new FormData()
    const ext = audio.type.includes('mp4') ? 'm4a' : 'webm'
    fd.append('audio', new File([audio], `voice.${ext}`, { type: audio.type.split(';')[0] }))
    if (conversation_id) fd.append('conversation_id', conversation_id)
    if (language) fd.append('language', language)
    return request<{ execution_id: string; conversation_id: string; message: Message }>('/api/agent/voice/', { method: 'POST', body: fd })
  },
  feedback: (messageId: string, b: { rating: 1 | -1; correction?: string; consent?: boolean }) =>
    request(`/api/messages/${messageId}/feedback/`, { method: 'PUT', body: json(b) }),

  galaxy: () => request<{ count: number; points: GalaxyPoint[] }>('/api/documents/galaxy/'),
  galaxyQuery: (q: string) => request<{ query: { x: number; y: number; z: number } | null; nearest: { id: string; similarity: number }[] }>('/api/documents/galaxy/', { method: 'POST', body: json({ q }) }),
  voiceProfile: () => request<VoiceProfile>('/api/voice-profile/'),
  voiceSample: (audio: Blob, language: string, index: number) => {
    const fd = new FormData()
    fd.append('audio', new File([audio], `sample.${audio.type.includes('mp4') ? 'm4a' : 'webm'}`, { type: audio.type.split(';')[0] }))
    fd.append('language', language); fd.append('index', String(index))
    return request<VoiceSampleRec>('/api/voice-profile/samples/', { method: 'POST', body: fd })
  },
  freeTalk: () => request<{ sessions: FreeSession[]; summary: FreeSummary }>('/api/voice-profile/free/'),
  freeTalkSession: (id: string) => request<FreeSession>(`/api/voice-profile/free/${id}/`),
  freeTalkUpload: (audio: Blob) => {
    const fd = new FormData()
    fd.append('audio', new File([audio], `talk.${audio.type.includes('mp4') ? 'm4a' : 'webm'}`, { type: audio.type.split(';')[0] }))
    return request<FreeSession>('/api/voice-profile/free/', { method: 'POST', body: fd })
  },
  freeTalkDelete: (id: string) => request<void>(`/api/voice-profile/free/${id}/`, { method: 'DELETE' }),
  freeTalkCorrect: (id: string, b: { text?: string; language?: string; verified?: false }) =>
    request<FreeSegment>(`/api/voice-profile/free/segments/${id}/`, { method: 'PATCH', body: json(b) }),
  freeTalkAudioUrl: (id: string) => `/api/voice-profile/free/segments/${id}/`,
  deleteVoiceSample: (id: string) => request<void>(`/api/voice-profile/samples/${id}/`, { method: 'DELETE' }),
  documents: (q = '') => request<Page<DocumentRec>>(`/api/documents/?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  document: (id: string, q = '') => request<DocumentDetail>(`/api/documents/${id}/${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  deleteDocument: (id: string) => request<void>(`/api/documents/${id}/`, { method: 'DELETE' }),
  reindex: (id: string) => request<{ execution_id: string }>(`/api/documents/${id}/reindex/`, { method: 'POST' }),
  uploadDocument: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return request<{ execution_id: string }>('/api/documents/ingest/', { method: 'POST', body: fd })
  },
  ingestFromMac: (b: { query?: string; path?: string; directory?: string }) =>
    request<{ execution_id: string }>('/api/documents/ingest/', { method: 'POST', body: json(b) }),

  memories: (q = '', category = '') => request<Page<MemoryRec>>(`/api/memory/?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}${category ? `&category=${category}` : ''}`),
  searchMemories: (query: string) => request<{ results: MemoryRec[] }>('/api/memory/search/', { method: 'POST', body: json({ query }) }),
  saveMemory: (b: { content: string; category: string; tags: string[] }) =>
    request<{ memory: MemoryRec; outcome: 'created' | 'duplicate'; indexed: boolean }>('/api/memory/save/', { method: 'POST', body: json(b) }),
  updateMemory: (id: string, b: Partial<Pick<MemoryRec, 'content' | 'category' | 'tags'>>) =>
    request<MemoryRec>(`/api/memory/${id}/`, { method: 'PUT', body: json(b) }),
  deleteMemory: (id: string) => request<void>(`/api/memory/${id}/`, { method: 'DELETE' }),

  preferences: () => request<Preferences>('/api/settings/'),
  savePreferences: (b: Partial<Preferences>) => request<Preferences>('/api/settings/', { method: 'PUT', body: json(b) }),
  localAgent: () => request<LocalAgentStatus>('/api/local-agent/'),
  setDisabledRoots: (disabled_roots: string[]) => request<LocalAgentStatus>('/api/local-agent/roots/', { method: 'PUT', body: json({ disabled_roots }) }),
}
