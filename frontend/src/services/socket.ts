import type { AgentEvent } from '../types'
import { wsUrl } from './apiBase'

type Listener = (e: AgentEvent) => void
export type SocketState = 'connecting' | 'open' | 'closed'

/** Reconnecting WebSocket with exponential backoff + heartbeat. */
export class AgentSocket {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private stateListeners = new Set<(s: SocketState) => void>()
  private retry = 0
  private timer: number | undefined
  private heartbeat: number | undefined
  private stopped = false

  private path: string
  constructor(path = '/ws/agent/executions/') { this.path = path }

  connect() {
    this.stopped = false
    const url = wsUrl(this.path)
    this.setState('connecting')
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.setState('open')
      this.heartbeat = window.setInterval(() => ws.readyState === 1 && ws.send('{"kind":"ping"}'), 25_000)
    }
    ws.onmessage = (m) => {
      try { const e = JSON.parse(m.data) as AgentEvent; this.listeners.forEach((l) => l(e)) } catch { /* ignore malformed */ }
    }
    ws.onclose = () => {
      window.clearInterval(this.heartbeat)
      this.setState('closed')
      if (this.stopped) return
      const delay = Math.min(15_000, 500 * 2 ** this.retry++) + Math.random() * 300
      this.timer = window.setTimeout(() => this.connect(), delay)
    }
  }

  close() {
    this.stopped = true
    window.clearTimeout(this.timer)
    window.clearInterval(this.heartbeat)
    this.ws?.close()
  }

  /** Send a JSON message if connected; returns false when offline (caller decides how to retry). */
  send(obj: unknown): boolean {
    if (this.ws?.readyState !== 1) return false
    this.ws.send(JSON.stringify(obj)); return true
  }

  on(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  onState(l: (s: SocketState) => void) { this.stateListeners.add(l); return () => { this.stateListeners.delete(l) } }
  private setState(s: SocketState) { this.stateListeners.forEach((l) => l(s)) }
}
