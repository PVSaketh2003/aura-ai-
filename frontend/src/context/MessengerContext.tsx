import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AgentSocket, type SocketState } from '../services/socket'
import { mx, type CallRec, type ChatRec, type Me, type Msg } from '../services/messenger'
import { notify } from './NotificationContext'

/* Messenger state shared by the whole app (so calls ring and unread counts update on every page).
 * Delivery guarantees on the client:
 *  - every message is keyed by id and ordered by the chat's server seq → duplicates are impossible;
 *  - a gap in seq (missed event) or a reconnect triggers a catch-up fetch `?after=<last seq>`;
 *  - optimistic sends carry a client_id; the server returns the same message on retry, never a second copy. */

type AnyEvent = { kind: string; [k: string]: any }
export interface ActiveCall { call: CallRec; peerName: string; phase: 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended'; local?: MediaStream; remote?: MediaStream; error?: string; muted: boolean; cameraOff: boolean; startedAt?: number }

interface Value {
  me: Me | null; refreshMe: () => Promise<void>; socket: SocketState
  chats: ChatRec[]; refreshChats: () => Promise<void>; unreadTotal: number
  messages: Record<string, Msg[]>; loadMessages: (chatId: string, older?: boolean) => Promise<boolean>
  openChat: string | null; setOpenChat: (id: string | null) => void
  send: (chatId: string, b: { text?: string; attachment_id?: string; reply_to?: string }, preview?: Partial<Msg>) => Promise<void>
  retry: (chatId: string, m: Msg) => Promise<void>
  typing: Record<string, string>; sendTyping: (chatId: string) => void
  call: ActiveCall | null; startCall: (chat: ChatRec, video: boolean) => Promise<void>; answer: () => Promise<void>; hangup: (reason?: 'decline' | 'end') => Promise<void>
  toggleMute: () => void; toggleCamera: () => void
}
const Ctx = createContext<Value>(null!)
export const useMessenger = () => useContext(Ctx)

const merge = (list: Msg[], incoming: Msg[]) => {
  const byKey = new Map<string, Msg>()
  for (const m of list) byKey.set(m.id, m)
  for (const m of incoming) {
    // a confirmed message replaces its optimistic placeholder (same client_id)
    if (m.client_id) for (const [k, v] of byKey) if (v.local && v.client_id === m.client_id) byKey.delete(k)
    byKey.set(m.id, { ...byKey.get(m.id), ...m, local: false })
  }
  return [...byKey.values()].sort((a, b) => (a.local ? 1e15 : a.seq) - (b.local ? 1e15 : b.seq))
}
const lastSeq = (list?: Msg[]) => (list ?? []).reduce((a, m) => (m.local ? a : Math.max(a, m.seq)), 0)

export function MessengerProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [socket, setSocket] = useState<SocketState>('connecting')
  const [chats, setChats] = useState<ChatRec[]>([])
  const [messages, setMessages] = useState<Record<string, Msg[]>>({})
  const [openChat, setOpenChatState] = useState<string | null>(null)
  const [typing, setTyping] = useState<Record<string, string>>({})
  const [call, setCall] = useState<ActiveCall | null>(null)
  const ws = useRef<AgentSocket | null>(null)
  const msgsRef = useRef(messages); msgsRef.current = messages
  const openRef = useRef(openChat); openRef.current = openChat
  const chatsRef = useRef(chats); chatsRef.current = chats
  const callRef = useRef(call); callRef.current = call
  const pc = useRef<RTCPeerConnection | null>(null)
  const pendingIce = useRef<RTCIceCandidateInit[]>([])
  const seenEvents = useRef(new Set<string>())
  const ringTimer = useRef<number | undefined>(undefined)

  const refreshMe = useCallback(async () => { setMe(await mx.me()) }, [])
  const refreshChats = useCallback(async () => { const r = await mx.chats(); setChats(r.chats) }, [])

  const loadMessages = useCallback(async (chatId: string, older = false) => {
    const have = msgsRef.current[chatId]
    const confirmed = (have ?? []).filter((m) => !m.local)
    const q = older && confirmed.length ? { before: confirmed[0].seq } : have ? { after: lastSeq(have) } : {}
    const r = await mx.messages(chatId, q)
    setMessages((s) => ({ ...s, [chatId]: merge(s[chatId] ?? [], r.messages) }))
    return r.has_more
  }, [])

  const markRead = useCallback((chatId: string) => {
    const seq = lastSeq(msgsRef.current[chatId])
    const c = chatsRef.current.find((x) => x.id === chatId)
    if (!seq || !c || c.read_seq >= seq || document.visibilityState !== 'visible') return
    mx.read(chatId, seq).catch(() => {})
    setChats((cs) => cs.map((x) => (x.id === chatId ? { ...x, read_seq: seq, unread: 0 } : x)))
  }, [])

  const setOpenChat = useCallback((id: string | null) => { setOpenChatState(id); if (id) setTimeout(() => markRead(id), 50) }, [markRead])

  // ---------------------------------------------------------------------------------------------- WebRTC
  const closePeer = useCallback(() => {
    pc.current?.close(); pc.current = null; pendingIce.current = []
    window.clearTimeout(ringTimer.current)
    const c = callRef.current
    c?.local?.getTracks().forEach((t) => t.stop())
  }, [])

  const signal = (data: unknown) => { const c = callRef.current; if (c) ws.current?.send({ kind: 'call.signal', call_id: c.call.id, data }) }

  const makePeer = useCallback(async (video: boolean) => {
    const local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { width: 1280, height: 720 } : false })
    const peer = new RTCPeerConnection({ iceServers: me?.ice_servers ?? [] })
    local.getTracks().forEach((t) => peer.addTrack(t, local))
    const remote = new MediaStream()
    peer.ontrack = (e) => { e.streams[0]?.getTracks().forEach((t) => remote.addTrack(t)); setCall((c) => (c ? { ...c, remote } : c)) }
    peer.onicecandidate = (e) => e.candidate && signal({ ice: e.candidate.toJSON() })
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') setCall((c) => (c ? { ...c, phase: 'active', startedAt: c.startedAt ?? Date.now() } : c))
      if (peer.connectionState === 'failed') {
        const c = callRef.current
        if (c) mx.callAction(c.call.id, 'fail').catch(() => {})
        setCall((x) => (x ? { ...x, phase: 'ended', error: 'The connection failed. On different networks calls need a TURN server (see README → Messenger).' } : x))
        closePeer()
      }
    }
    pc.current = peer
    setCall((c) => (c ? { ...c, local } : c))
    return peer
  }, [me, closePeer]) // eslint-disable-line react-hooks/exhaustive-deps

  const onSignal = useCallback(async (data: any) => {
    const peer = pc.current
    if (!peer) return
    if (data.sdp) {
      await peer.setRemoteDescription(data.sdp)
      for (const c of pendingIce.current.splice(0)) await peer.addIceCandidate(c).catch(() => {})
      if (data.sdp.type === 'offer') {
        await peer.setLocalDescription(await peer.createAnswer())
        signal({ sdp: peer.localDescription })
      }
    } else if (data.ice) {
      if (peer.remoteDescription) await peer.addIceCandidate(data.ice).catch(() => {})
      else pendingIce.current.push(data.ice)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const startCall = useCallback(async (chat: ChatRec, video: boolean) => {
    if (callRef.current) return
    const rec = await mx.call(chat.id, video)
    setCall({ call: rec, peerName: chat.name, phase: 'outgoing', muted: false, cameraOff: !video })
    try { await makePeer(video) } catch {
      await mx.callAction(rec.id, 'end').catch(() => {})
      setCall((c) => (c ? { ...c, phase: 'ended', error: 'Microphone/camera permission is needed for calls.' } : c)); return
    }
    ringTimer.current = window.setTimeout(() => { if (callRef.current?.phase === 'outgoing') hangupRef.current('end') }, 45_000)
  }, [makePeer])

  const answer = useCallback(async () => {
    const c = callRef.current
    if (!c) return
    setCall({ ...c, phase: 'connecting' })
    try { await makePeer(c.call.video) } catch {
      await mx.callAction(c.call.id, 'decline').catch(() => {}); setCall({ ...c, phase: 'ended', error: 'Microphone/camera permission is needed to answer.' }); return
    }
    await mx.callAction(c.call.id, 'answer')  // the caller sends the offer when it sees "active"
  }, [makePeer])

  const hangup = useCallback(async (reason: 'decline' | 'end' = 'end') => {
    const c = callRef.current
    if (!c) return
    closePeer()
    setCall(null)
    if (c.phase !== 'ended') await mx.callAction(c.call.id, reason).catch(() => {})
  }, [closePeer])
  const hangupRef = useRef(hangup); hangupRef.current = hangup

  const toggleMute = useCallback(() => setCall((c) => { if (!c) return c; c.local?.getAudioTracks().forEach((t) => (t.enabled = c.muted)); return { ...c, muted: !c.muted } }), [])
  const toggleCamera = useCallback(() => setCall((c) => { if (!c) return c; c.local?.getVideoTracks().forEach((t) => (t.enabled = c.cameraOff)); return { ...c, cameraOff: !c.cameraOff } }), [])

  // ---------------------------------------------------------------------------------------------- events
  const onEvent = useCallback((e: AnyEvent) => {
    if (e.event_id) { if (seenEvents.current.has(e.event_id)) return; seenEvents.current.add(e.event_id); if (seenEvents.current.size > 2000) seenEvents.current.clear() }
    switch (e.kind) {
      case 'msg.new': {
        const m: Msg = e.message
        const have = msgsRef.current[m.chat_id]
        if (have) {
          const known = lastSeq(have)
          if (m.seq > known + 1) loadMessages(m.chat_id).catch(() => {}) // gap → catch up instead of showing out of order
          else setMessages((s) => ({ ...s, [m.chat_id]: merge(s[m.chat_id] ?? [], [m]) }))
        }
        if (!m.mine) ws.current?.send({ kind: 'msg.delivered', chat_id: m.chat_id, seq: m.seq })
        const inView = openRef.current === m.chat_id && document.visibilityState === 'visible'
        setChats((cs) => {
          const c = cs.find((x) => x.id === m.chat_id)
          if (!c) { refreshChats().catch(() => {}); return cs }
          const next = { ...c, last_message: m, last_seq: Math.max(c.last_seq, m.seq), last_message_at: m.created_at, archived: false,
            unread: m.mine || inView ? 0 : c.unread + (m.seq > c.last_seq ? 1 : 0) }
          return [next, ...cs.filter((x) => x.id !== m.chat_id)]
        })
        if (inView) setTimeout(() => markRead(m.chat_id), 30)
        const c = chatsRef.current.find((x) => x.id === m.chat_id)
        if (!m.mine && !inView && !c?.muted && m.kind === 'text')
          notify({ kind: 'message', title: c?.kind === 'group' ? `${m.sender_name} · ${c.name}` : m.sender_name,
                   body: m.deleted ? 'Message' : m.text || (m.attachment ? `Sent ${m.attachment.kind === 'voice' ? 'a voice message' : m.attachment.name}` : ''),
                   href: `/messenger?s=chats&c=${m.chat_id}` })
        if (!m.mine && !inView && !c?.muted && m.kind !== 'system' && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible')
          new Notification(c?.kind === 'group' ? `${m.sender_name} · ${c.name}` : m.sender_name, { body: m.text || (m.attachment ? `📎 ${m.attachment.name}` : ''), tag: m.chat_id })
        break
      }
      case 'msg.update':
        setMessages((s) => (s[e.chat_id] ? { ...s, [e.chat_id]: merge(s[e.chat_id], [e.message]) } : s)); break
      case 'msg.receipt': {
        const chat = chatsRef.current.find((x) => x.id === e.chat_id)
        if (chat?.kind === 'direct') {
          setChats((cs) => cs.map((c) => (c.id !== e.chat_id || !c.last_message?.mine ? c : { ...c, last_message: { ...c.last_message,
            status: e.read != null && e.read >= c.last_message.seq ? 'read' : e.delivered != null && e.delivered >= c.last_message.seq && c.last_message.status !== 'read' ? 'delivered' : c.last_message.status } })))
          setMessages((s) => s[e.chat_id] ? { ...s, [e.chat_id]: s[e.chat_id].map((m) => (!m.mine || m.local || m.kind !== 'text' ? m
            : { ...m, status: e.read != null && e.read >= m.seq ? 'read' : e.delivered != null && e.delivered >= m.seq && m.status !== 'read' ? 'delivered' : m.status })) } : s)
        } else if (msgsRef.current[e.chat_id]) {
          mx.messages(e.chat_id).then((r) => setMessages((s) => ({ ...s, [e.chat_id]: merge(s[e.chat_id] ?? [], r.messages) }))).catch(() => {})
        }
        break
      }
      case 'chat.update': case 'chat.deleted':
        refreshChats().catch(() => {})
        if (e.kind === 'chat.deleted' && openRef.current === e.chat_id) setOpenChatState(null)
        break
      case 'typing':
        setTyping((t) => ({ ...t, [e.chat_id]: String(e.user_id) }))
        setTimeout(() => setTyping((t) => { const n = { ...t }; delete n[e.chat_id]; return n }), 3500)
        break
      case 'call.ring':
        if (callRef.current) { mx.callAction(e.call.id, 'decline').catch(() => {}); break } // busy
        setCall({ call: e.call, peerName: e.call.caller_name || e.call.chat_name, phase: 'incoming', muted: false, cameraOff: !e.call.video })
        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible')
          new Notification(`Incoming ${e.call.video ? 'video' : 'voice'} call`, { body: e.call.caller_name, tag: e.call.id })
        break
      case 'call.state': {
        const c = callRef.current
        if (!c || c.call.id !== e.call_id) { if (e.state !== 'ringing') refreshChats().catch(() => {}); break }
        if (e.state === 'active' && c.call.outgoing && pc.current) {
          window.clearTimeout(ringTimer.current)
          setCall({ ...c, phase: 'connecting' })
          const peer = pc.current
          peer.createOffer().then((o) => peer.setLocalDescription(o)).then(() => signal({ sdp: peer.localDescription })).catch(() => {})
        } else if (['ended', 'missed', 'declined', 'failed'].includes(e.state)) {
          closePeer()
          const label = e.state === 'declined' ? 'Call declined' : e.state === 'missed' ? (c.phase === 'incoming' ? 'Missed call' : 'No answer') : e.state === 'failed' ? 'Call failed' : 'Call ended'
          if (e.state === 'missed' && c.phase === 'incoming') notify({ kind: 'call', title: 'Missed call', body: `${c.peerName} · ${c.call.video ? 'video' : 'voice'} call`, href: `/messenger?s=calls` })
          setCall({ ...c, phase: 'ended', error: label })
          setTimeout(() => setCall((x) => (x?.call.id === c.call.id ? null : x)), 1800)
        }
        break
      }
      case 'call.signal':
        if (callRef.current?.call.id === e.call_id) onSignal(e.data).catch(() => {}); break
    }
  }, [loadMessages, markRead, refreshChats, onSignal, closePeer]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshMe().catch(() => {}); refreshChats().catch(() => {})
    const s = new AgentSocket('/ws/messenger/')
    ws.current = s
    let opened = false
    const offState = s.onState((st) => {
      setSocket(st)
      if (st === 'open') {
        if (opened) { // reconnected: recover everything missed while offline
          refreshChats().catch(() => {})
          Object.keys(msgsRef.current).forEach((id) => loadMessages(id).catch(() => {}))
        }
        opened = true
      }
    })
    const off = s.on((e) => onEvent(e as unknown as AnyEvent))
    s.connect()
    const vis = () => { if (document.visibilityState === 'visible' && openRef.current) markRead(openRef.current) }
    document.addEventListener('visibilitychange', vis)
    return () => { off(); offState(); s.close(); document.removeEventListener('visibilitychange', vis) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async (chatId: string, b: { text?: string; attachment_id?: string; reply_to?: string }, preview: Partial<Msg> = {}) => {
    const client_id = crypto.randomUUID()
    const local: Msg = { id: `local-${client_id}`, chat_id: chatId, seq: 0, kind: 'text', client_id, sender_id: me?.id ?? null, sender_name: 'You', mine: true,
      text: b.text ?? '', deleted: false, forwarded: false, pinned: false, edited: false, created_at: new Date().toISOString(), attachment: null, reply_to: null,
      reactions: {}, status: 'sending', local: true, ...preview }
    setMessages((s) => ({ ...s, [chatId]: [...(s[chatId] ?? []), local] }))
    try {
      const m = await mx.send(chatId, { ...b, client_id })
      setMessages((s) => ({ ...s, [chatId]: merge(s[chatId] ?? [], [m]) }))
    } catch {
      setMessages((s) => ({ ...s, [chatId]: (s[chatId] ?? []).map((x) => (x.id === local.id ? { ...x, status: 'failed', _body: b } as Msg : x)) }))
    }
  }, [me])

  const retry = useCallback(async (chatId: string, m: Msg) => {
    const body = (m as Msg & { _body?: { text?: string; attachment_id?: string; reply_to?: string } })._body ?? { text: m.text }
    setMessages((s) => ({ ...s, [chatId]: (s[chatId] ?? []).map((x) => (x.id === m.id ? { ...x, status: 'sending' } : x)) }))
    try {
      const r = await mx.send(chatId, { ...body, client_id: m.client_id })  // same client_id → never duplicated
      setMessages((s) => ({ ...s, [chatId]: merge(s[chatId] ?? [], [r]) }))
    } catch {
      setMessages((s) => ({ ...s, [chatId]: (s[chatId] ?? []).map((x) => (x.id === m.id ? { ...x, status: 'failed' } : x)) }))
    }
  }, [])

  const lastTyping = useRef(0)
  const sendTyping = useCallback((chatId: string) => {
    if (Date.now() - lastTyping.current < 2500) return
    lastTyping.current = Date.now()
    ws.current?.send({ kind: 'typing', chat_id: chatId })
  }, [])

  const unreadTotal = useMemo(() => chats.reduce((a, c) => a + (c.muted ? 0 : c.unread), 0), [chats])
  return (
    <Ctx.Provider value={{ me, refreshMe, socket, chats, refreshChats, unreadTotal, messages, loadMessages, openChat, setOpenChat, send, retry, typing, sendTyping,
      call, startCall, answer, hangup, toggleMute, toggleCamera }}>
      {children}
    </Ctx.Provider>
  )
}
