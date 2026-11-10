/** Single audio output for Aura's voice. Plays streamed sentence segments in order, replays full answers,
 *  and exposes a live 0..1 output level (for the orb) via an AnalyserNode. */
export interface PlayerState { messageId: string | null; playing: boolean; time: number; duration: number }

class VoicePlayer {
  private el = new Audio()
  private queue: string[] = []
  private queueFor: string | null = null
  private streamDone = false
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private buf = new Uint8Array(256)
  private listeners = new Set<(s: PlayerState) => void>()
  state: PlayerState = { messageId: null, playing: false, time: 0, duration: 0 }
  level = { current: 0 }

  constructor() {
    this.el.preload = 'auto'
    this.el.addEventListener('ended', () => this.next())
    this.el.addEventListener('play', () => this.set({ playing: true }))
    this.el.addEventListener('pause', () => this.set({ playing: false }))
    this.el.addEventListener('timeupdate', () => this.set({ time: this.el.currentTime, duration: isFinite(this.el.duration) ? this.el.duration : 0 }))
    const tick = () => {
      if (this.analyser && this.state.playing) {
        this.analyser.getByteTimeDomainData(this.buf)
        let sum = 0
        for (const v of this.buf) { const x = (v - 128) / 128; sum += x * x }
        this.level.current = this.level.current * 0.6 + Math.min(1, Math.sqrt(sum / this.buf.length) * 5) * 0.4
      } else this.level.current *= 0.9
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  private wire() {
    if (this.ctx) return
    try {
      this.ctx = new AudioContext()
      const src = this.ctx.createMediaElementSource(this.el)
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 256
      src.connect(this.analyser); this.analyser.connect(this.ctx.destination)
    } catch { /* level metering is optional */ }
  }

  private set(p: Partial<PlayerState>) { this.state = { ...this.state, ...p }; this.listeners.forEach((l) => l(this.state)) }
  subscribe(l: (s: PlayerState) => void) { this.listeners.add(l); l(this.state); return () => { this.listeners.delete(l) } }

  private cursor = -1
  private waiting = false

  /** Streamed segment for a message that is being answered now: segments play in order as they arrive. */
  enqueue(messageId: string, url: string, index: number) {
    if (this.queueFor !== messageId) {
      this.el.pause()
      this.queueFor = messageId; this.queue = []; this.cursor = -1; this.streamDone = false; this.waiting = true
      this.set({ messageId, time: 0 })
    }
    this.queue[index] = url
    if (this.waiting) this.next()
  }

  private next() {
    if (!this.queueFor) { this.set({ playing: false }); return }
    const url = this.queue[this.cursor + 1]
    if (url) { this.cursor++; this.waiting = false; this.load(url); return }
    if (this.streamDone) { this.queueFor = null; this.waiting = false; this.set({ playing: false, time: 0 }) }
    else this.waiting = true
  }

  markStreamDone(messageId: string) {
    if (this.queueFor !== messageId) return
    this.streamDone = true
    if (this.waiting) this.next()
  }

  private load(url: string) {
    this.wire()
    this.ctx?.resume().catch(() => {})
    this.el.src = url
    this.el.play().catch(() => this.set({ playing: false }))
  }

  /** Play a complete answer (replay). */
  play(messageId: string, url: string) {
    this.queueFor = null; this.cursor = -1
    if (this.state.messageId === messageId && this.el.src.endsWith(url) && this.el.paused && this.el.currentTime > 0 && !this.el.ended) {
      this.el.play().catch(() => {}); return
    }
    this.set({ messageId, time: 0 })
    this.load(url)
  }
  pause() { this.el.pause() }
  resume() { if (this.el.src && this.el.paused && !this.el.ended) { this.ctx?.resume().catch(() => {}); this.el.play().catch(() => {}) } }
  stop() { this.el.pause(); this.queueFor = null; this.cursor = -1; this.set({ playing: false, messageId: null, time: 0 }) }
  seek(t: number) { if (isFinite(t)) this.el.currentTime = t }
}

export const player = new VoicePlayer()
