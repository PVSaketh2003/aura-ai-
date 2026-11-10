import { AnimatePresence, motion } from 'motion/react'
import { Loader2, Move3d, Search, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAgent } from '../context/AgentContext'
import { api, type GalaxyPoint } from '../services/api'
import { cx } from '../utils/format'

type Near = { id: string; similarity: number }
type Q = { x: number; y: number; z: number } | null

const pageColor = (t: number) => {
  // coral → violet → sky across the document
  const stops = [[255, 138, 91], [167, 123, 255], [91, 140, 255]]
  const f = Math.min(0.999, Math.max(0, t)) * (stops.length - 1)
  const i = Math.floor(f), k = f - i
  const a = stops[i], b = stops[i + 1]
  return [0, 1, 2].map((j) => Math.round(a[j] + (b[j] - a[j]) * k))
}

/** The user's documents as a 3-D star field: each passage is a star, placed by meaning (PCA of its embedding). */
export function GalaxyPage() {
  const [points, setPoints] = useState<GalaxyPoint[] | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState<Q>(null)
  const [near, setNear] = useState<Near[]>([])
  const [hover, setHover] = useState<{ p: GalaxyPoint; x: number; y: number; w: number } | null>(null)
  const { runs, activeRunId } = useAgent()
  const canvas = useRef<HTMLCanvasElement>(null)
  const state = useRef({ yaw: 0.6, pitch: 0.35, zoom: 1, auto: true, drag: null as null | { x: number; y: number; yaw: number; pitch: number } })
  const live = useRef<{ ids: Set<string>; chosen: Set<string>; at: number }>({ ids: new Set(), chosen: new Set(), at: 0 })
  const nearRef = useRef<Near[]>([]); nearRef.current = near
  const queryRef = useRef<Q>(null); queryRef.current = query
  const proj = useRef<{ x: number; y: number; s: number; p: GalaxyPoint }[]>([])

  useEffect(() => { api.galaxy().then((g) => setPoints(g.points)).catch((e) => setErr(e.message)) }, [])

  // live: highlight what Aura is retrieving right now in chat
  const run = activeRunId ? runs[activeRunId] : undefined
  const sim = run?.steps.find((s) => s.key === 'similarity_search')
  const mmr = run?.steps.find((s) => s.key === 'mmr')
  useEffect(() => {
    const c = (sim?.detail as any)?.candidates as { id: string }[] | undefined
    if (!c?.length) return
    live.current = { ids: new Set(c.map((x) => x.id)), chosen: new Set(((mmr?.detail as any)?.selected as string[]) ?? []), at: performance.now() }
  }, [sim?.id, sim?.status, sim?.detail, mmr?.status, mmr?.detail])

  const pages = useMemo(() => {
    const ps = (points ?? []).map((p) => p.page ?? 0)
    return { min: Math.min(...ps, 0), max: Math.max(...ps, 1) }
  }, [points])

  useEffect(() => {
    if (!points?.length) return
    const c = canvas.current!
    const ctx = c.getContext('2d')!
    const dpr = Math.min(2, devicePixelRatio || 1)
    let raf = 0, W = 0, H = 0
    const resize = () => { W = c.clientWidth; H = c.clientHeight; c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0) }
    resize()
    const ro = new ResizeObserver(resize); ro.observe(c)
    const byId = new Map(points.map((p) => [p.id, p]))
    const stars = Array.from({ length: 220 }, () => [Math.random(), Math.random(), Math.random() * 0.8 + 0.2])

    const project = (x: number, y: number, z: number) => {
      const st = state.current
      const cy = Math.cos(st.yaw), sy = Math.sin(st.yaw), cp = Math.cos(st.pitch), sp = Math.sin(st.pitch)
      const x1 = x * cy - z * sy, z1 = x * sy + z * cy
      const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp
      const f = 3.2 / (3.2 + z2)
      const R = Math.min(W, H) * 0.36 * st.zoom
      return { x: W / 2 + x1 * R * f, y: H / 2 + y1 * R * f, s: f, z: z2 }
    }

    const frame = (t: number) => {
      const st = state.current
      if (st.auto && !st.drag) st.yaw += 0.0016
      ctx.clearRect(0, 0, W, H)
      // backdrop stars
      for (const [sx, sy, a] of stars) { ctx.fillStyle = `rgba(12,12,16,${0.07 * a})`; ctx.fillRect(sx * W, sy * H, 1, 1) }
      const lv = live.current
      const liveAge = (t - lv.at) / 1000
      const liveOn = lv.ids.size > 0 && liveAge < 30
      const nearSet = new Map(nearRef.current.map((n, i) => [n.id, i]))
      const pr = points.map((p) => ({ ...project(p.x, p.y, p.z), p }))
      pr.sort((a, b) => b.z - a.z)
      proj.current = pr
      for (const { x, y, s, p } of pr) {
        const [r, g, b] = pageColor(((p.page ?? 0) - pages.min) / (pages.max - pages.min || 1))
        const isNear = nearSet.has(p.id), isLive = liveOn && lv.ids.has(p.id), chosen = liveOn && lv.chosen.has(p.id)
        const base = 1.1 + s * 1.3
        const rad = isNear || chosen ? base * 2.6 : isLive ? base * 1.9 : base
        const alpha = isNear || isLive ? 1 : (nearSet.size || liveOn ? 0.25 : 0.55) * (0.5 + s * 0.5)
        if (isNear || isLive) {
          const glow = ctx.createRadialGradient(x, y, 0, x, y, rad * 5)
          glow.addColorStop(0, `rgba(${r},${g},${b},.55)`); glow.addColorStop(1, `rgba(${r},${g},${b},0)`)
          ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, rad * 5, 0, Math.PI * 2); ctx.fill()
        }
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill()
      }
      // query star + beams to its nearest passages
      const qp = queryRef.current
      if (qp) {
        const o = project(qp.x, qp.y, qp.z)
        nearRef.current.forEach((n, i) => {
          const p = byId.get(n.id); if (!p) return
          const d = project(p.x, p.y, p.z)
          const prog = Math.min(1, (t / 900) % 1)
          const grad = ctx.createLinearGradient(o.x, o.y, d.x, d.y)
          grad.addColorStop(0, 'rgba(255,138,91,.9)'); grad.addColorStop(1, `rgba(167,123,255,${0.35 + n.similarity * 0.5})`)
          ctx.strokeStyle = grad; ctx.lineWidth = 0.6 + n.similarity * 2.2
          ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(d.x, d.y); ctx.stroke()
          const px = o.x + (d.x - o.x) * prog, py = o.y + (d.y - o.y) * prog
          ctx.fillStyle = 'rgba(255,138,91,.95)'; ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill()
          ctx.fillStyle = 'rgba(12,12,16,.7)'; ctx.font = '10px "JetBrains Mono Variable", monospace'
          ctx.fillText(`${i + 1} · ${n.similarity.toFixed(2)}`, d.x + 7, d.y - 6)
        })
        const pulse = 1 + Math.sin(t / 220) * 0.25
        const g2 = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, 26 * pulse)
        g2.addColorStop(0, 'rgba(255,138,91,1)'); g2.addColorStop(0.3, 'rgba(255,138,91,.45)'); g2.addColorStop(1, 'rgba(167,123,255,0)')
        ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(o.x, o.y, 26 * pulse, 0, Math.PI * 2); ctx.fill()
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [points, pages])

  const onDown = (e: React.PointerEvent) => {
    const st = state.current
    st.drag = { x: e.clientX, y: e.clientY, yaw: st.yaw, pitch: st.pitch }; st.auto = false
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const st = state.current
    if (st.drag) {
      st.yaw = st.drag.yaw + (e.clientX - st.drag.x) * 0.006
      st.pitch = Math.max(-1.3, Math.min(1.3, st.drag.pitch + (e.clientY - st.drag.y) * 0.006))
      setHover(null); return
    }
    const r = (e.target as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - r.left, my = e.clientY - r.top
    let best: (typeof proj.current)[number] | null = null, bd = 100
    for (const p of proj.current) { const d = (p.x - mx) ** 2 + (p.y - my) ** 2; if (d < bd) { bd = d; best = p } }
    setHover(best ? { p: best.p, x: best.x, y: best.y, w: canvas.current?.clientWidth ?? 0 } : null)
  }
  const onUp = () => { state.current.drag = null }
  const onWheel = (e: React.WheelEvent) => { const st = state.current; st.zoom = Math.max(0.5, Math.min(3.5, st.zoom * (e.deltaY > 0 ? 0.92 : 1.08))) }

  const ask = async () => {
    if (!q.trim()) return
    setBusy(true)
    try { const r = await api.galaxyQuery(q.trim()); setQuery(r.query); setNear(r.nearest); state.current.auto = true } catch (e) { setErr((e as Error).message) }
    setBusy(false)
  }
  const byId = useMemo(() => new Map((points ?? []).map((p) => [p.id, p])), [points])
  const liveCount = sim ? ((sim.detail as any)?.candidates?.length ?? 0) : 0

  return (
    <div className="relative flex h-full min-w-0 flex-1 p-3 pl-0">
      <div className="relative flex min-w-0 flex-1 overflow-hidden rounded-[28px] border border-line bg-white/50 text-ink shadow-float backdrop-blur-xl">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/2 h-[80%] w-[80%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(167,123,255,.16),transparent_60%)] blur-2xl" />
          <div className="absolute -left-20 top-10 h-80 w-80 rounded-full bg-[#ff8a5b] opacity-[.3] blur-[110px] animate-drift-a" />
          <div className="absolute -right-10 bottom-0 h-96 w-96 rounded-full bg-[#5b8cff] opacity-[.3] blur-[120px] animate-drift-b" />
        </div>
        <canvas ref={canvas} className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => { onUp(); setHover(null) }} onWheel={onWheel} />

        {/* header */}
        <div className="pointer-events-none absolute left-0 right-0 top-0 flex items-start justify-between p-7">
          <div>
            <div className="text-[10.5px] font-medium uppercase tracking-[0.22em] text-ink/40">Knowledge galaxy</div>
            <h1 className="mt-2 font-serif text-[clamp(30px,3.6vw,46px)] leading-none tracking-[-0.01em]">Your documents, <span className="italic aura-text">as meaning</span></h1>
            <p className="mt-3 max-w-[420px] text-[13px] leading-relaxed text-ink/50">
              {points ? `${points.length} passages. ` : ''}Each star is one passage, placed by what it means (its 2,560-dim embedding projected to 3-D). Close stars talk about the same thing. Colour runs from the first page to the last.
            </p>
          </div>
          <div className="pointer-events-auto flex items-center gap-2 text-[11px] text-ink/45"><Move3d size={13} /> drag to rotate · scroll to zoom</div>
        </div>

        {/* live banner */}
        <AnimatePresence>
          {liveCount > 0 && run?.status === 'running' && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="absolute left-1/2 top-6 flex -translate-x-1/2 items-center gap-2 rounded-full border border-ink/15 bg-white/70 px-4 py-1.5 text-[12px] backdrop-blur">
              <span className="relative flex h-2 w-2"><span className="absolute h-full w-full animate-ping rounded-full bg-mint opacity-70" /><span className="relative h-2 w-2 rounded-full bg-mint" /></span>
              Live: Aura just pulled {liveCount} passages for “{run.input.slice(0, 40)}”
            </motion.div>
          )}
        </AnimatePresence>

        {!points && !err && <div className="absolute inset-0 grid place-items-center text-ink/50"><Loader2 className="animate-spin" /></div>}
        {err && <div className="absolute inset-0 grid place-items-center text-[13px] text-rose">{err}</div>}
        {points && points.length === 0 && <div className="absolute inset-0 grid place-items-center text-[14px] text-ink/50">No documents indexed yet. Load a PDF from the Library.</div>}

        {/* hover card */}
        {hover && (
          <div className="pointer-events-none absolute z-10 w-[280px] rounded-2xl border border-ink/10 bg-white/90 p-3 text-[12px] leading-relaxed text-ink/80 shadow-float backdrop-blur-xl"
            style={{ left: Math.min(hover.x + 16, hover.w - 300), top: hover.y + 16 }}>
            <div className="mb-1 font-mono text-[10.5px] text-violet">page {hover.p.page ?? '—'}</div>
            {hover.p.text}…
          </div>
        )}

        {/* nearest list */}
        <AnimatePresence>
          {near.length > 0 && (
            <motion.aside initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
              className="scroll-quiet absolute bottom-28 right-6 top-28 w-[300px] space-y-2 overflow-y-auto">
              <div className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink/40">Nearest passages</div>
              {near.map((n, i) => {
                const p = byId.get(n.id)
                return (
                  <motion.div key={n.id} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
                    className="rounded-2xl border border-ink/10 bg-white/70 p-3 backdrop-blur-xl">
                    <div className="flex items-center justify-between font-mono text-[10.5px] text-ink/50">
                      <span>#{i + 1} · page {p?.page ?? '—'}</span><span className="text-ink/80">{n.similarity.toFixed(3)}</span>
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/70"><div className="h-full rounded-full bg-gradient-to-r from-coral via-violet to-sky" style={{ width: `${Math.max(5, n.similarity * 100)}%` }} /></div>
                    <p className="mt-2 line-clamp-3 text-[11.5px] leading-relaxed text-ink/65">{p?.text}</p>
                  </motion.div>
                )
              })}
            </motion.aside>
          )}
        </AnimatePresence>

        {/* ask */}
        <form onSubmit={(e) => { e.preventDefault(); ask() }} className="absolute bottom-6 left-1/2 flex w-[min(620px,90%)] -translate-x-1/2 items-center gap-2 rounded-full border border-ink/15 bg-white/70 p-1.5 pl-5 backdrop-blur-2xl">
          <Search size={15} className="text-ink/50" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Drop a question into the galaxy — any language…"
            className="flex-1 bg-transparent py-2 text-[14px] text-ink outline-none placeholder:text-ink/35" />
          <button disabled={busy || !q.trim()} className={cx('flex h-10 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium transition',
            busy || !q.trim() ? 'bg-ink/10 text-ink/40' : 'bg-ink text-white hover:scale-[1.03]')}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Find
          </button>
        </form>
      </div>
    </div>
  )
}
