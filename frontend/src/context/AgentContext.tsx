import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../services/api'
import { player } from '../services/player'
import { AgentSocket, type SocketState } from '../services/socket'
import { spokenLanguage } from '../components/LangPicker'
import type { AgentEvent, ExecutionStep, Message, StepStatus } from '../types'

export interface LiveRun {
  id: string; status: StepStatus; steps: ExecutionStep[]; input: string
  startedAt: number; durationMs: number | null; error: string; streamed: string
  llm?: { phase: 'reading' | 'writing'; tokens: number; prompt_tokens?: number; first_token_ms?: number; elapsed_ms?: number }
  result?: { answer: string; documents: { document_id: string; filename: string }[] }
  /** latest real in-stage progress per ingestion stage (pages / chunks / vectors) */
  progress?: Record<string, { done: number; total: number; unit: string; seq?: number; [k: string]: unknown }>
  progressSeq?: number
}

type Listener = (e: AgentEvent) => void

interface AgentValue {
  socket: SocketState
  conversationId: string | null
  messages: Message[]
  runs: Record<string, LiveRun>
  activeRunId: string | null
  busy: boolean
  historyVersion: number
  localAgentOnline: boolean | null
  send: (text: string) => Promise<void>
  sendVoice: (audio: Blob) => Promise<void>
  regenerate: (assistantId: string) => Promise<void>
  retryVoice: (userMessageId: string, language: string) => Promise<void>
  openConversation: (id: string) => Promise<void>
  newConversation: () => void
  selectRun: (id: string) => Promise<void>
  watchRun: (id: string, label: string) => void
  on: (l: Listener) => () => void
}
const Ctx = createContext<AgentValue>(null!)

const upsertStep = (steps: ExecutionStep[], s: ExecutionStep) => {
  const i = steps.findIndex((x) => x.id === s.id)
  const next = i === -1 ? [...steps, s] : steps.map((x, j) => (j === i ? s : x))
  return next.sort((a, b) => a.seq - b.seq)
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<SocketState>('connecting')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [runs, setRuns] = useState<Record<string, LiveRun>>({})
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [localAgentOnline, setLocalAgentOnline] = useState<boolean | null>(null)
  const convRef = useRef<string | null>(null)
  const listeners = useRef(new Set<Listener>())
  const autoplayRuns = useRef(new Set<string>())
  convRef.current = conversationId

  const patchRun = useCallback((id: string, f: (r: LiveRun) => LiveRun) => {
    setRuns((rs) => {
      const base: LiveRun = rs[id] ?? { id, status: 'running', steps: [], input: '', startedAt: Date.now(), durationMs: null, error: '', streamed: '' }
      return { ...rs, [id]: f(base) }
    })
  }, [])

  const syncRun = useCallback(async (id: string) => {
    const r = await api.execution(id)
    patchRun(id, (x) => ({ ...x, status: r.status, steps: r.steps, input: r.input_text, error: r.error,
      durationMs: r.duration_ms, startedAt: new Date(r.started_at).getTime() }))
    return r
  }, [patchRun])

  const addMessage = useCallback((m: Message) => {
    setMessages((ms) => {
      const i = ms.findIndex((x) => x.id === m.id)
      return i === -1 ? [...ms, m] : ms.map((x, j) => (j === i ? { ...x, ...m } : x))
    })
  }, [])

  // Recover operations that are still running (page refresh / reconnect): steps + last progress from the server.
  const restoreActive = useCallback(async () => {
    try {
      const list = await api.activeRuns()
      for (const r of list) patchRun(r.id, (x) => ({ ...x, status: r.status, steps: r.steps, input: r.input_text || x.input, error: r.error,
        durationMs: r.duration_ms, startedAt: new Date(r.started_at).getTime(),
        progress: { ...(r.progress ?? {}), ...x.progress } }))
      const live = list.find((r) => r.status === 'running')
      if (live) setActiveRunId((cur) => cur ?? live.id)
    } catch { /* offline */ }
  }, [patchRun])

  useEffect(() => {
    restoreActive()
    api.localAgent().then((s) => setLocalAgentOnline(s.online)).catch(() => {})
    const s = new AgentSocket()
    let wasClosed = false
    const offState = s.onState((st) => {
      setSocket(st)
      if (st === 'closed') wasClosed = true
      if (st === 'open' && wasClosed) {
        restoreActive()
        setRuns((rs) => { Object.values(rs).filter((r) => r.status === 'running').forEach((r) => syncRun(r.id).catch(() => {})); return rs })
        if (convRef.current) api.conversation(convRef.current).then((c) => setMessages(c.messages)).catch(() => {})
        api.localAgent().then((x) => setLocalAgentOnline(x.online)).catch(() => {})
      }
    })
    const off = s.on((e: AgentEvent) => {
      listeners.current.forEach((l) => l(e))
      switch (e.kind) {
        case 'run.started':
          patchRun(e.execution_id, (r) => ({ ...r, status: 'running', input: e.input_text || r.input })); break
        case 'step.updated':
          patchRun(e.execution_id, (r) => ({ ...r, steps: upsertStep(r.steps, e.step) })); break
        case 'llm.progress':
          patchRun(e.execution_id, (r) => ({ ...r, llm: { ...r.llm, ...e, prompt_tokens: e.prompt_tokens ?? r.llm?.prompt_tokens } }))
          break
        case 'ingest.progress':
          patchRun(e.execution_id, (r) => {
            if ((r.progressSeq ?? 0) >= e.seq) return r // duplicate or out-of-order delivery
            const prev = r.progress?.[e.stage]
            if (prev && prev.total === e.total && prev.done > e.done) return r // never move backwards
            return { ...r, progressSeq: e.seq, progress: { ...r.progress, [e.stage]: { ...e } } }
          })
          break
        case 'answer.delta':
          patchRun(e.execution_id, (r) => ({ ...r, streamed: r.streamed + e.delta })); break
        case 'transcript':
          patchRun(e.execution_id, (r) => ({ ...r, input: e.text }))
          setMessages((ms) => ms.map((m) => (m.id === e.message_id ? { ...m, content: e.text, language: e.language, payload: { ...m.payload, ...(e.speech ? { speech: e.speech } : {}) } } : m)))
          break
        case 'answer.final':
          addMessage(e.message); break
        case 'audio.segment':
          if (autoplayRuns.current.has(e.execution_id)) player.enqueue(e.message_id, e.url, e.index)
          break
        case 'audio.ready':
          player.markStreamDone(e.message_id)
          setMessages((ms) => ms.map((m) => (m.id === e.message_id ? { ...m, payload: { ...m.payload, audio: e.audio } } : m)))
          break
        case 'run.finished':
          patchRun(e.execution_id, (r) => ({ ...r, status: e.status, error: e.error, durationMs: e.duration_ms, result: e.result }))
          if (e.message) addMessage(e.message)
          autoplayRuns.current.delete(e.execution_id)
          setHistoryVersion((v) => v + 1)
          break
        case 'local_agent.status':
          setLocalAgentOnline(e.status === 'online'); break
      }
    })
    s.connect()
    return () => { off(); offState(); s.close() }
  }, [patchRun, syncRun, addMessage, restoreActive])

  const begin = useCallback((res: { execution_id: string; conversation_id: string; message: Message }, input: string) => {
    patchRun(res.execution_id, (r) => ({ ...r, input, startedAt: Date.now() }))
    autoplayRuns.current.add(res.execution_id)
    setActiveRunId(res.execution_id)
    if (convRef.current !== res.conversation_id) { setConversationId(res.conversation_id); setHistoryVersion((v) => v + 1) }
    setMessages((ms) => [...ms, { ...res.message, execution: res.execution_id }])
  }, [patchRun])

  const send = useCallback(async (text: string) => {
    player.stop()
    begin(await api.chat(text, convRef.current), text)
  }, [begin])

  const sendVoice = useCallback(async (audio: Blob) => {
    player.stop()
    const lang = spokenLanguage()
    begin(await api.voice(audio, convRef.current, lang), '')
  }, [begin])

  // Regenerate: re-ask the question that produced this answer (same conversation, a fresh run).
  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages
  const regenerate = useCallback(async (assistantId: string) => {
    const ms = messagesRef.current
    const i = ms.findIndex((m) => m.id === assistantId)
    const q = [...ms.slice(0, i)].reverse().find((m) => m.role === 'user' && !m.content.startsWith('🎙'))
    if (!q) return
    player.stop()
    begin(await api.chat(q.content, convRef.current), q.content)
  }, [begin])

  const retryVoice = useCallback(async (userMessageId: string, language: string) => {
    player.stop()
    begin(await api.voiceRetry(userMessageId, language), '')
  }, [begin])

  const openConversation = useCallback(async (id: string) => {
    const c = await api.conversation(id)
    setConversationId(id)
    setMessages(c.messages)
    const last = [...c.messages].reverse().find((m) => m.execution)
    setActiveRunId(last?.execution ?? null)
    if (last?.execution) syncRun(last.execution).catch(() => {})
  }, [syncRun])

  const newConversation = useCallback(() => { player.stop(); setConversationId(null); setMessages([]); setActiveRunId(null) }, [])

  const selectRun = useCallback(async (id: string) => {
    setActiveRunId(id)
    if (!runs[id]) await syncRun(id).catch(() => {})
  }, [runs, syncRun])

  const watchRun = useCallback((id: string, label: string) => {
    patchRun(id, (r) => ({ ...r, input: label, startedAt: Date.now() }))
    setActiveRunId(id)
  }, [patchRun])

  const on = useCallback((l: Listener) => { listeners.current.add(l); return () => { listeners.current.delete(l) } }, [])

  const busy = !!activeRunId && runs[activeRunId]?.status === 'running'

  const value = useMemo(() => ({ socket, conversationId, messages, runs, activeRunId, busy, historyVersion, localAgentOnline,
    send, sendVoice, regenerate, retryVoice, openConversation, newConversation, selectRun, watchRun, on }),
  [socket, conversationId, messages, runs, activeRunId, busy, historyVersion, localAgentOnline, send, sendVoice, regenerate, retryVoice, openConversation,
    newConversation, selectRun, watchRun, on])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
export const useAgent = () => useContext(Ctx)
