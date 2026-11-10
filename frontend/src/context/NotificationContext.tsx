import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isIngestRun } from '../components/ProcessingJourney'
import { useAgent } from './AgentContext'

/* Notification centre. Every entry comes from a real event — never invented:
 *   - documents that finished or failed processing   (agent socket: run.finished of an ingestion run)
 *   - new messenger messages while that chat isn't open (MessengerContext dispatches 'aura:notify')
 *   - missed / declined calls                          (MessengerContext dispatches 'aura:notify')
 * Kept in this browser only (localStorage, newest 60). */

export interface AuraNotification { id: string; kind: 'document' | 'message' | 'call' | 'error'; title: string; body: string; at: number; href?: string; read: boolean }
interface Value { items: AuraNotification[]; unread: number; markAllRead: () => void; clear: () => void; markRead: (id: string) => void }
const Ctx = createContext<Value>({ items: [], unread: 0, markAllRead: () => {}, clear: () => {}, markRead: () => {} })
export const useNotifications = () => useContext(Ctx)
const KEY = 'aura.notifications'

/** Fire from anywhere: notify({ kind, title, body, href }). */
export function notify(n: Omit<AuraNotification, 'id' | 'at' | 'read'>) {
  window.dispatchEvent(new CustomEvent('aura:notify', { detail: n }))
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<AuraNotification[]>(() => {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
  })
  const { on, runs } = useAgent()
  const runsRef = useRef(runs)
  useEffect(() => { runsRef.current = runs }, [runs])

  const push = useCallback((n: Omit<AuraNotification, 'id' | 'at' | 'read'>) => {
    setItems((s) => [{ ...n, id: crypto.randomUUID(), at: Date.now(), read: false }, ...s].slice(0, 60))
  }, [])

  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(items)) } catch { /* private mode */ } }, [items])

  useEffect(() => {
    const h = (e: Event) => push((e as CustomEvent).detail)
    window.addEventListener('aura:notify', h)
    return () => window.removeEventListener('aura:notify', h)
  }, [push])

  useEffect(() => on((e) => {
    if (e.kind !== 'run.finished') return
    const run = runsRef.current[e.execution_id]
    if (!run || !isIngestRun(run)) return
    const name = (run.input || 'Document').replace(/^(Re-index|Upload|Load)\s+/i, '')
    if (e.status === 'completed') push({ kind: 'document', title: 'Document ready', body: `${name} is processed and searchable.`, href: '/library' })
    else if (e.status === 'failed') push({ kind: 'error', title: 'Document processing failed', body: `${name}: ${e.error || 'see the processing journey for details'}`, href: '/library' })
  }), [on, push])

  const value = useMemo<Value>(() => ({
    items, unread: items.filter((i) => !i.read).length,
    markAllRead: () => setItems((s) => s.map((i) => ({ ...i, read: true }))),
    clear: () => setItems([]),
    markRead: (id) => setItems((s) => s.map((i) => (i.id === id ? { ...i, read: true } : i))),
  }), [items])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
