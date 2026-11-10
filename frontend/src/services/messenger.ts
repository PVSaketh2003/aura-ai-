import type { User } from '../types'

/* Aura Messenger API client. Same cookie session + CSRF as the rest of Aura. */

export interface Person { id: number; name: string; display_name: string; phone: string; phone_pretty: string; about: string; avatar: string; last_seen: string | null }
export interface Me { id: number; display_name: string; phone: string; phone_pretty: string; verified: boolean; about: string; avatar: string; discoverable: boolean; who_can_message: 'everyone' | 'contacts'; show_last_seen: boolean; sms_backend: string; ice_servers: RTCIceServer[] }
export interface ContactRec { id: string; name: string; phone: string; phone_pretty: string; description: string; avatar: string; on_aura: boolean; user: Person | null; blocked: boolean }
export interface AttachmentRec { id: string; name: string; mime: string; size: number; kind: 'image' | 'video' | 'audio' | 'voice' | 'pdf' | 'document' | 'other'; duration: number | null }
export interface Msg {
  id: string; chat_id: string; seq: number; kind: 'text' | 'system' | 'call' | 'ai'; client_id: string; sender_id: number | null; sender_name: string
  mine: boolean; text: string; deleted: boolean; forwarded: boolean; pinned: boolean; edited: boolean; created_at: string
  attachment: AttachmentRec | null; reply_to: { id: string; sender_name: string; text: string } | null; reactions: Record<string, number[]>
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'; local?: boolean
}
export interface ChatRec {
  id: string; kind: 'direct' | 'group'; state: 'active' | 'request'; role: 'owner' | 'admin' | 'member'; muted: boolean; archived: boolean
  unread: number; last_seq: number; read_seq: number; last_message: Msg | null; last_message_at: string; name: string; avatar: string
  description?: string; member_count?: number; peer?: Person; blocked?: boolean
  members?: (Person & { role: 'owner' | 'admin' | 'member'; me: boolean })[]; pinned?: Msg[]
}
export interface CallRec { id: string; chat_id: string; chat_name: string; video: boolean; state: 'ringing' | 'active' | 'ended' | 'missed' | 'declined' | 'failed'; outgoing: boolean; caller_name: string; created_at: string; answered_at: string | null; duration: number | null }
export interface MediaItem { message_id: string; chat_id: string; chat_name: string; seq: number; sender_name: string; created_at: string; attachment: AttachmentRec }

function csrf() { return decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('csrftoken='))?.split('=')[1] ?? '') }

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  if (method !== 'GET') headers.set('X-CSRFToken', csrf())
  let res: Response
  try { res = await fetch(path, { ...init, headers, credentials: 'same-origin' }) } catch { throw new Error('Can’t reach Aura. Check your connection.') }
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(String(body.detail ?? `Request failed (${res.status})`)), { status: res.status })
  return body as T
}
const J = (b: unknown) => JSON.stringify(b)
const M = '/api/messenger'

/** Upload with real progress (XHR) and cancellation. */
export function upload(file: File, opts: { voice?: boolean; duration?: number; onProgress?: (f: number) => void; signal?: AbortSignal } = {}) {
  return new Promise<AttachmentRec>((resolve, reject) => {
    const x = new XMLHttpRequest()
    const fd = new FormData()
    fd.append('file', file)
    if (opts.voice) fd.append('voice', '1')
    if (opts.duration) fd.append('duration', String(opts.duration))
    x.open('POST', `${M}/uploads/`)
    x.setRequestHeader('X-CSRFToken', csrf())
    x.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(e.loaded / e.total)
    x.onload = () => {
      let b: any = {}
      try { b = JSON.parse(x.responseText) } catch { /* empty */ }
      x.status < 300 ? resolve(b) : reject(new Error(b.detail ?? `Upload failed (${x.status})`))
    }
    x.onerror = () => reject(new Error('Upload failed — check your connection.'))
    x.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { cancelled: true }))
    opts.signal?.addEventListener('abort', () => x.abort())
    x.send(fd)
  })
}

export const attachmentUrl = (id: string, download = false) => `${M}/attachments/${id}/${download ? '?download=1' : ''}`

export const mx = {
  phoneStart: (phone: string, purpose: 'register' | 'login', country = '') => req<{ phone: string; sent: boolean; provider: string }>('/api/auth/phone/start/', { method: 'POST', body: J({ phone, purpose, country }) }),
  phoneRegister: (b: { phone: string; code: string; display_name: string; password: string }) => req<{ user: User }>('/api/auth/phone/register/', { method: 'POST', body: J(b) }),
  phoneLogin: (phone: string, code: string) => req<{ user: User }>('/api/auth/phone/login/', { method: 'POST', body: J({ phone, code }) }),

  me: () => req<Me>(`${M}/me/`),
  updateMe: (b: Partial<Me> & { display_name?: string }) => req<Me>(`${M}/me/`, { method: 'PATCH', body: J(b) }),
  linkPhone: (phone: string, code?: string, country = '') => req<{ phone: string; sent?: boolean; verified?: boolean; provider?: string }>(`${M}/me/phone/`, { method: 'POST', body: J({ phone, code, country }) }),

  contacts: (q = '') => req<{ contacts: ContactRec[]; invite_text: string }>(`${M}/contacts/${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  addContact: (b: { name: string; phone: string; country?: string; description?: string }) => req<ContactRec>(`${M}/contacts/`, { method: 'POST', body: J(b) }),
  updateContact: (id: string, b: Partial<{ name: string; description: string; avatar: string }>) => req<ContactRec>(`${M}/contacts/${id}/`, { method: 'PATCH', body: J(b) }),
  deleteContact: (id: string) => req<void>(`${M}/contacts/${id}/`, { method: 'DELETE' }),
  lookup: (phone: string, country = '') => req<{ phone: string; on_aura: boolean; user?: Person }>(`${M}/lookup/`, { method: 'POST', body: J({ phone, country }) }),

  chats: (archived = false) => req<{ chats: ChatRec[] }>(`${M}/chats/${archived ? '?archived=1' : ''}`),
  chat: (id: string) => req<ChatRec>(`${M}/chats/${id}/`),
  updateChat: (id: string, b: Partial<{ name: string; description: string; avatar: string; muted: boolean; archived: boolean }>) => req<ChatRec>(`${M}/chats/${id}/`, { method: 'PATCH', body: J(b) }),
  deleteGroup: (id: string) => req<void>(`${M}/chats/${id}/`, { method: 'DELETE' }),
  direct: (user_id: number) => req<ChatRec>(`${M}/chats/direct/`, { method: 'POST', body: J({ user_id }) }),
  group: (b: { name: string; description?: string; member_ids: number[]; avatar?: string }) => req<ChatRec>(`${M}/chats/group/`, { method: 'POST', body: J(b) }),
  request: (id: string, action: 'accept' | 'reject' | 'block') => req<{ state: string }>(`${M}/chats/${id}/request/${action}/`, { method: 'POST' }),
  addMembers: (id: string, user_ids: number[]) => req<{ members: ChatRec['members'] }>(`${M}/chats/${id}/members/`, { method: 'POST', body: J({ user_ids }) }),
  setRole: (id: string, uid: number, role: 'admin' | 'member') => req(`${M}/chats/${id}/members/${uid}/`, { method: 'PATCH', body: J({ role }) }),
  removeMember: (id: string, uid: number) => req<void>(`${M}/chats/${id}/members/${uid}/`, { method: 'DELETE' }),

  messages: (id: string, q: { after?: number; before?: number } = {}) =>
    req<{ messages: Msg[]; last_seq: number; has_more: boolean }>(`${M}/chats/${id}/messages/?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))}`),
  send: (id: string, b: { text?: string; attachment_id?: string; reply_to?: string; client_id: string }) => req<Msg>(`${M}/chats/${id}/messages/`, { method: 'POST', body: J(b) }),
  edit: (mid: string, text: string) => req<Msg>(`${M}/messages/${mid}/`, { method: 'PATCH', body: J({ text }) }),
  pin: (mid: string, pinned: boolean) => req<Msg>(`${M}/messages/${mid}/`, { method: 'PATCH', body: J({ pinned }) }),
  remove: (mid: string) => req<void>(`${M}/messages/${mid}/`, { method: 'DELETE' }),
  react: (mid: string, emoji: string) => req<void>(`${M}/messages/${mid}/react/`, { method: 'POST', body: J({ emoji }) }),
  forward: (mid: string, chat_ids: string[]) => req<{ forwarded: number }>(`${M}/messages/${mid}/forward/`, { method: 'POST', body: J({ chat_ids }) }),
  read: (id: string, read: number) => req<void>(`${M}/chats/${id}/read/`, { method: 'POST', body: J({ read }) }),
  ai: (id: string, action: 'summarize' | 'action_items' | 'translate' | 'explain', language = 'en') =>
    req<{ text: string; model: string; messages_used: number }>(`${M}/chats/${id}/ai/`, { method: 'POST', body: J({ action, language }) }),

  media: (kind = '', chat = '') => req<{ items: MediaItem[] }>(`${M}/media/?${new URLSearchParams({ ...(kind && { kind }), ...(chat && { chat }) })}`),
  search: (q: string) => req<{ contacts: ContactRec[]; chats: ChatRec[]; messages: (Msg & { chat_name: string })[]; files: MediaItem[] }>(`${M}/search/?q=${encodeURIComponent(q)}`),
  blocks: () => req<{ blocked: Person[] }>(`${M}/blocks/`),
  block: (user_id: number) => req<void>(`${M}/blocks/`, { method: 'POST', body: J({ user_id }) }),
  unblock: (user_id: number) => req<void>(`${M}/blocks/${user_id}/`, { method: 'DELETE' }),
  report: (user_id: number, reason: string, block: boolean) => req<void>(`${M}/reports/`, { method: 'POST', body: J({ user_id, reason, block }) }),

  calls: () => req<{ calls: CallRec[] }>(`${M}/calls/`),
  call: (chat_id: string, video: boolean) => req<CallRec>(`${M}/calls/`, { method: 'POST', body: J({ chat_id, video }) }),
  callAction: (id: string, action: 'answer' | 'decline' | 'end' | 'fail') => req<CallRec>(`${M}/calls/${id}/${action}/`, { method: 'POST' }),
}
