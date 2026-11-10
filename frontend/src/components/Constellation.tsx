import { useEffect, useRef } from 'react'
import { useAgent } from '../context/AgentContext'
import { player } from '../services/player'

/**
 * A living "neural constellation" behind the app. Nodes drift; nearby nodes link.
 *   idle      → slow drift, faint links
 *   thinking  → links brighten and signals race along them toward the centre (retrieval → reasoning)
 *   speaking  → the whole field breathes with Aura's voice level
 * The cursor gently attracts nearby nodes. Pure canvas, ~60 nodes, paused when the tab is hidden.
 */
export function Constellation() {
  const ref = useRef<HTMLCanvasElement>(null)
  const { busy } = useAgent()
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    const c = ref.current!
    const ctx = c.getContext('2d')!
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let W = 0, H = 0, raf = 0
    const COLORS = ['255,138,91', '167,123,255', '91,140,255', '47,191,143']
    type N = { x: number; y: number; vx: number; vy: number; r: number; c: string; ph: number }
    type P = { a: number; b: number; t: number; sp: number }
    let nodes: N[] = []
    const pulses: P[] = []
    const mouse = { x: -9999, y: -9999 }
    let energy = 0

    const resize = () => {
      W = c.clientWidth; H = c.clientHeight
      c.width = W * dpr; c.height = H * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.round(Math.min(80, Math.max(36, (W * H) / 26000)))
      nodes = Array.from({ length: n }, (_, i) => ({
        x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
        r: 1 + Math.random() * 1.8, c: COLORS[i % COLORS.length], ph: Math.random() * Math.PI * 2,
      }))
    }
    resize()
    const onMove = (e: MouseEvent) => { mouse.x = e.clientX; mouse.y = e.clientY }
    const onLeave = () => { mouse.x = mouse.y = -9999 }
    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)

    const LINK = 150
    const frame = (t: number) => {
      const thinking = busyRef.current
      const dk = 1.6
      const lv = player.state.playing ? player.level.current : 0
      energy += ((thinking ? 1 : 0) + lv * 1.4 - energy) * 0.04
      ctx.clearRect(0, 0, W, H)
      const cx = W * 0.5, cy = H * 0.45
      for (const n of nodes) {
        // drift + gentle pull to the cursor + a little inward flow while thinking
        const dx = mouse.x - n.x, dy = mouse.y - n.y, d2 = dx * dx + dy * dy
        if (d2 < 220 * 220) { n.vx += dx * 0.000025; n.vy += dy * 0.000025 }
        if (energy > 0.05) { n.vx += (cx - n.x) * 0.0000045 * energy; n.vy += (cy - n.y) * 0.0000045 * energy }
        n.vx *= 0.995; n.vy *= 0.995
        const sp = Math.hypot(n.vx, n.vy), max = 0.35 + energy * 0.5
        if (sp > max) { n.vx *= max / sp; n.vy *= max / sp }
        if (sp < 0.04) { n.vx += (Math.random() - 0.5) * 0.02; n.vy += (Math.random() - 0.5) * 0.02 }
        n.x += n.vx; n.y += n.vy
        if (n.x < -20) n.x = W + 20; if (n.x > W + 20) n.x = -20
        if (n.y < -20) n.y = H + 20; if (n.y > H + 20) n.y = -20
      }
      // links
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          const d = Math.hypot(a.x - b.x, a.y - b.y)
          if (d > LINK) continue
          const k = 1 - d / LINK
          ctx.strokeStyle = `rgba(${a.c},${(0.1 + energy * 0.2) * k * dk})`
          ctx.lineWidth = 0.6 + energy * 0.6 * k
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
          if (energy > 0.3 && pulses.length < 40 && Math.random() < 0.0016 * energy) pulses.push({ a: i, b: j, t: 0, sp: 0.012 + Math.random() * 0.02 })
        }
      }
      // signals travelling along links
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i], a = nodes[p.a], b = nodes[p.b]
        p.t += p.sp
        if (p.t >= 1 || Math.hypot(a.x - b.x, a.y - b.y) > LINK) { pulses.splice(i, 1); continue }
        const x = a.x + (b.x - a.x) * p.t, y = a.y + (b.y - a.y) * p.t
        const g = ctx.createRadialGradient(x, y, 0, x, y, 7)
        g.addColorStop(0, `rgba(${a.c},.9)`); g.addColorStop(1, `rgba(${a.c},0)`)
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill()
      }
      // nodes
      for (const n of nodes) {
        const tw = 0.55 + 0.45 * Math.sin(t / 900 + n.ph)
        const r = n.r * (1 + energy * 0.6 + lv * 1.5)
        ctx.fillStyle = `rgba(${n.c},${Math.min(1, (0.28 + 0.4 * tw * (0.5 + energy)) * dk)})`
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill()
      }
      if (!reduce) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    const vis = () => { cancelAnimationFrame(raf); if (!document.hidden && !reduce) raf = requestAnimationFrame(frame) }
    document.addEventListener('visibilitychange', vis)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize); window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave); document.removeEventListener('visibilitychange', vis)
    }
  }, [])

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-0 h-full w-full" />
}
