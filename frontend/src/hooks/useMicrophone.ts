import { useCallback, useEffect, useRef, useState } from 'react'

export type MicState = 'idle' | 'requesting' | 'recording' | 'denied' | 'error'

/** Real microphone capture: MediaRecorder for audio + AnalyserNode for a live 0..1 level. */
export function useMicrophone() {
  const [state, setState] = useState<MicState>('idle')
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const level = useRef(0)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const cleanup = useRef<() => void>(() => {})
  const resolveStop = useRef<((b: Blob | null) => void) | null>(null)

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) { setState('error'); setError('This browser can’t record audio.'); return }
    setState('requesting'); setError('')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      setState(denied ? 'denied' : 'error')
      setError(denied ? 'Microphone access was blocked. Allow it in your browser’s site settings.' : 'No microphone was found.')
      return
    }
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.fftSize)
    let raf = 0
    const t0 = performance.now()
    const tick = () => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (const v of buf) { const x = (v - 128) / 128; sum += x * x }
      const rms = Math.sqrt(sum / buf.length)
      level.current = level.current * 0.7 + Math.min(1, rms * 4.5) * 0.3
      setElapsed(performance.now() - t0)
      raf = requestAnimationFrame(tick)
    }
    tick()
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m))
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    chunks.current = []
    mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
    mr.onstop = () => {
      resolveStop.current?.(chunks.current.length ? new Blob(chunks.current, { type: mr.mimeType }) : null)
      resolveStop.current = null
    }
    mr.start(250)
    rec.current = mr
    cleanup.current = () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); ctx.close(); level.current = 0 }
    setState('recording')
  }, [])

  const stop = useCallback(() => new Promise<Blob | null>((resolve) => {
    const mr = rec.current
    if (!mr || mr.state === 'inactive') { resolve(null); return }
    resolveStop.current = resolve
    mr.stop()
    cleanup.current()
    rec.current = null
    setState('idle')
  }), [])

  useEffect(() => () => cleanup.current(), [])
  return { state, error, elapsed, level, start, stop }
}
