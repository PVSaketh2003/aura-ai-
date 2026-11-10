import { useEffect, useRef, type RefObject } from 'react'

export type OrbMode = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

const PALETTES: Record<OrbMode, [string, string, string]> = {
  idle: ['#ff9b6e', '#b48bff', '#6e9bff'],
  listening: ['#ff7f5c', '#c06bff', '#4f86ff'],
  thinking: ['#ffb36e', '#9b7bff', '#4fc3ff'],
  speaking: ['#ff8a7a', '#b77bff', '#5b8cff'],
  error: ['#f0a0a0', '#d9a7b5', '#c9b3c9'],
}

const ENERGY: Record<OrbMode, number> = { idle: 0.05, listening: 0.08, thinking: 0.12, speaking: 0.1, error: 0.03 }
const SPEED: Record<OrbMode, number> = { idle: 0.35, listening: 0.8, thinking: 1.6, speaking: 1.0, error: 0.2 }

/**
 * A living gradient orb drawn on canvas. Three blurred, noise-deformed blobs orbit inside a glass sphere.
 * `level` (0..1, e.g. microphone RMS) drives deformation in real time without React re-renders.
 */
export function Orb({ size = 240, mode = 'idle', level }: { size?: number; mode?: OrbMode; level?: RefObject<number> }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    const c = ref.current!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const pad = size * 0.35
    const W = size + pad * 2
    c.width = W * dpr; c.height = W * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0, t = Math.random() * 100, energy = 0.05, speed = 0.3, last = performance.now()
    const cx = W / 2, cy = W / 2, R = size / 2

    const blob = (ox: number, oy: number, r: number, seed: number, amp: number) => {
      ctx.beginPath()
      const N = 90
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2
        const n = Math.sin(a * 3 + t * 1.1 + seed) * 0.5 + Math.sin(a * 5 - t * 1.7 + seed * 2.1) * 0.3 + Math.sin(a * 2 + t * 0.7 + seed * 3.3) * 0.2
        const rr = r * (1 + amp * n)
        const x = ox + Math.cos(a) * rr, y = oy + Math.sin(a) * rr
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
      }
      ctx.closePath()
    }

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now
      const m = modeRef.current
      const lv = level?.current ?? 0
      energy += (ENERGY[m] + lv * 0.35 - energy) * 0.08
      speed += (SPEED[m] + lv * 2 - speed) * 0.05
      t += dt * speed
      const [c1, c2, c3] = PALETTES[m]
      const breath = 1 + Math.sin(t * 0.9) * 0.015 + lv * 0.06

      ctx.clearRect(0, 0, W, W)
      // ambient glow
      const glow = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.6)
      glow.addColorStop(0, c2 + '33'); glow.addColorStop(1, c2 + '00')
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, W)

      ctx.save()
      ctx.beginPath(); ctx.arc(cx, cy, R * breath, 0, Math.PI * 2); ctx.clip()
      ctx.fillStyle = '#fbf7ff'; ctx.fillRect(0, 0, W, W)
      ctx.filter = `blur(${R * 0.16}px)`
      const orbit = R * 0.28
      const blobs: [string, number, number][] = [[c1, 0, 0.62], [c2, 2.1, 0.58], [c3, 4.2, 0.6]]
      for (const [col, seed, rs] of blobs) {
        const ang = t * 0.5 + seed
        ctx.globalAlpha = 0.92
        ctx.fillStyle = col
        blob(cx + Math.cos(ang) * orbit, cy + Math.sin(ang * 1.3) * orbit, R * rs, seed, energy * 2.2)
        ctx.fill()
      }
      ctx.filter = 'none'; ctx.globalAlpha = 1
      // glass: specular highlight + rim shading
      const hi = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.45, 0, cx - R * 0.35, cy - R * 0.45, R * 0.9)
      hi.addColorStop(0, 'rgba(255,255,255,.85)'); hi.addColorStop(0.35, 'rgba(255,255,255,.18)'); hi.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = hi; ctx.fillRect(0, 0, W, W)
      const rim = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * breath)
      rim.addColorStop(0, 'rgba(255,255,255,0)'); rim.addColorStop(1, 'rgba(255,255,255,.55)')
      ctx.fillStyle = rim; ctx.fillRect(0, 0, W, W)
      ctx.restore()

      if (!reduce) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size, level])

  const W = size * 1.7
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <canvas ref={ref} style={{ width: W, height: W }} className="pointer-events-none absolute" aria-hidden />
      <div className="pointer-events-none absolute -bottom-[14%] h-[10%] w-[60%] rounded-[50%] bg-ink/10 blur-xl" />
    </div>
  )
}
