import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, Check, Mic, Pause, Play, Repeat, Square, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useAgent, type LiveRun } from '../context/AgentContext'
import { useNow } from '../hooks/useHealth'
import { player } from '../services/player'
import type { ExecutionStep } from '../types'
import { cx, ms } from '../utils/format'
import { stageOf } from './Journey'
import { LangPicker, SPOKEN, useSpokenLanguage } from './LangPicker'
import { Orb, type OrbMode } from './Orb'

const LNAME: Record<string, string> = Object.fromEntries(SPOKEN.map(([c, n]) => [c, n]))
type Cand = { id: string; file: string; page?: number | null; similarity: number; snippet?: string }

/* ------------------------------------------------------------------ per-step detail visuals (dark theme) */
function Bars({ rows, max = 1, accent = '#a77bff' }: { rows: { label: string; value: number; note?: string }[]; max?: number; accent?: string }) {
  return (
    <div className="mt-2 space-y-1.5">
      {rows.map((r, i) => (
        <div key={r.label + i} className="flex items-center gap-2 text-[11px]">
          <span className="w-[92px] shrink-0 truncate text-ink/60">{r.label}</span>
          <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/70">
            <motion.span initial={{ width: 0 }} animate={{ width: `${Math.max(3, Math.min(100, (r.value / max) * 100))}%` }}
              transition={{ duration: 0.8, delay: i * 0.06, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-y-0 left-0 rounded-full" style={{ background: i === 0 ? `linear-gradient(90deg,#ff8a5b,${accent})` : 'rgba(12,12,16,.18)' }} />
          </span>
          <span className="w-10 text-right font-mono tabular-nums text-ink/70">{r.note ?? r.value.toFixed(2)}</span>
        </div>
      ))}
    </div>
  )
}

function Vector({ v }: { v: number[] }) {
  return (
    <div className="mt-2 flex h-8 items-center gap-[1.5px]">
      {v.map((x, i) => (
        <motion.span key={i} initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ delay: i * 0.004 }}
          className="w-full origin-center rounded-full" style={{ height: `${Math.max(6, Math.abs(x) * 100)}%`, background: x >= 0 ? '#a77bff' : '#ff8a5b', opacity: 0.45 + Math.abs(x) * 0.55 }} />
      ))}
    </div>
  )
}

function Detail({ s, run }: { s: ExecutionStep; run: LiveRun }) {
  const d = (s.detail ?? {}) as Record<string, any>
  switch (s.key) {
    case 'asr': return <LanguagePanel d={d} />
    case 'query_embedding':
      return Array.isArray(d.preview) ? <Vector v={d.preview as number[]} /> : null
    case 'similarity_search':
    case 'wikipedia': {
      const c = ((d.candidates ?? []) as Cand[]).slice(0, 5)
      if (!c.length) return null
      return <Bars accent={s.key === 'wikipedia' ? '#5b8cff' : '#a77bff'} rows={c.map((x) => ({ label: `${x.file?.slice(0, 18) ?? x.id}${x.page ? ` p.${x.page}` : ''}`, value: x.similarity }))} />
    }
    case 'prompt': {
      const p = (d.plan ?? {}) as { template?: string; mode?: string; language?: string; voice?: boolean; sections?: string[] }
      return (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[p.template && `template · ${p.template}`, p.mode && `grounding · ${p.mode}`, p.language && `language · ${LNAME[p.language] ?? p.language}`, p.voice && 'spoken delivery']
            .filter(Boolean).map((t) => <span key={t as string} className="rounded-full border border-ink/10 bg-white/70 px-2 py-0.5 text-[10.5px] text-ink/75">{t}</span>)}
          {(p.sections ?? []).map((x) => <span key={x} className="rounded-full bg-violet/15 px-2 py-0.5 font-mono text-[10px] text-violet">{x}</span>)}
        </div>
      )
    }
    case 'llm_generation': {
      if (s.status !== 'running' || !run.llm) return null
      const l = run.llm
      return (
        <div className="mt-2">
          {l.phase === 'reading'
            ? <div className="relative h-1 overflow-hidden rounded-full bg-white/70"><span className="xr-scan absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-violet to-transparent" /></div>
            : <div className="font-mono text-[22px] tabular-nums text-ink">{l.tokens}<span className="ml-1.5 text-[11px] text-ink/45">tokens written</span></div>}
        </div>
      )
    }
    default:
      return null
  }
}

/** What the speech step really decided: the chosen language, how, every candidate's fused score, engine and confidence. */
function LanguagePanel({ d }: { d: Record<string, any> }) {
  if (!d.engine && !d.debug) return null
  const fused = (d.debug?.fused ?? {}) as Record<string, number>
  const rows = Object.entries(fused).map(([k, v]) => ({ label: LNAME[k] ?? k, value: v, note: `${Math.round(v * 100)}%` }))
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap gap-1.5 text-[10.5px]">
        <span className="rounded-full bg-violet/15 px-2 py-0.5 font-medium text-violet">{d.selected_language && d.selected_language !== 'auto' ? `${LNAME[d.selected_language] ?? d.selected_language} · your choice` : `${d.language_name ?? ''} · detected`}</span>
        {d.engine && d.engine !== '—' && <span className="rounded-full border border-ink/10 bg-white/70 px-2 py-0.5 text-ink/70">{d.engine}</span>}
        {d.asr_confidence != null && <span className="rounded-full border border-ink/10 bg-white/70 px-2 py-0.5 text-ink/70">transcript {Math.round(d.asr_confidence * 100)}% sure</span>}
      </div>
      {rows.length > 1 && <><div className="text-[10.5px] uppercase tracking-[0.14em] text-ink/35">Language evidence · {d.debug?.method === 'two-stage' ? 'Whisper (English?) → IndicConformer (which Indian language)' : 'VoxLingua + Whisper + transcript fit'}</div><Bars rows={rows} /></>}
    </div>
  )
}

const PHASES = [
  { id: 'listening', l: 'Listening', c: '#ff7a4d' }, { id: 'transcribing', l: 'Transcribing', c: '#f59e0b' },
  { id: 'understanding', l: 'Understanding', c: '#c45cff' }, { id: 'retrieving', l: 'Retrieving', c: '#7c4dff' },
  { id: 'thinking', l: 'Thinking', c: '#4f7dff' }, { id: 'speaking', l: 'Speaking', c: '#2fbf8f' },
] as const
type PhaseId = typeof PHASES[number]['id']
const RETRIEVE = new Set(['query_embedding', 'memory_retrieval', 'conversation_search', 'translate_query', 'similarity_search', 'multi_query', 'mmr', 'retrieval_evaluation', 'document_retrieval', 'wikipedia', 'web_search', 'file_search', 'local_agent'])
const THINK = new Set(['calculator', 'prompt', 'llm_generation', 'validation', 'response', 'localize'])
/** The live phase, derived only from real pipeline steps (never simulated). */
function livePhase(run: LiveRun | undefined, recording: boolean, speaking: boolean): PhaseId | null {
  if (recording) return 'listening'
  if (speaking) return 'speaking'
  if (!run || run.status !== 'running') return null
  const cur = [...run.steps].reverse().find((s) => s.status === 'running') ?? run.steps[run.steps.length - 1]
  if (!cur) return 'transcribing'
  if (cur.key === 'asr' || cur.key === 'input') return 'transcribing'
  if (RETRIEVE.has(cur.key)) return 'retrieving'
  if (THINK.has(cur.key)) return 'thinking'
  if (cur.key === 'tts') return 'speaking'
  return 'understanding'
}

function PhaseRibbon({ phase }: { phase: PhaseId | null }) {
  const at = phase ? PHASES.findIndex((p) => p.id === phase) : -1
  return (
    <div className="flex items-center gap-1 rounded-full border border-white/80 bg-white/70 p-1 shadow-soft backdrop-blur">
      {PHASES.map((p, i) => {
        const on = i === at, done = at > i
        return (
          <span key={p.id} className={cx('relative flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors', on ? 'text-white' : done ? 'text-ink-2' : 'text-ink/35')}>
            {on && <motion.span layoutId="phase-pill" className="absolute inset-0 rounded-full" style={{ background: p.c, boxShadow: `0 8px 20px -8px ${p.c}` }} transition={{ type: 'spring', stiffness: 400, damping: 32 }} />}
            <span className="phase-dot relative" style={{ background: on ? '#fff' : done ? p.c : 'rgb(12 12 16 / .15)' }} />
            <span className="relative hidden md:inline">{p.l}</span>
          </span>
        )
      })}
    </div>
  )
}

function LiveWave({ level }: { level: RefObject<number> }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const bars = Array.from(ref.current!.children) as HTMLElement[]
    const hist = new Array(bars.length).fill(0)
    const tick = () => { hist.push(level.current ?? 0); hist.shift(); bars.forEach((b, i) => { b.style.transform = `scaleY(${0.08 + hist[i] * 1.8})` }); raf = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [level])
  return <div ref={ref} className="mt-5 flex h-12 w-[min(520px,70vw)] items-center gap-[3px]">{Array.from({ length: 72 }).map((_, i) =>
    <span key={i} className="h-full flex-1 origin-center rounded-full" style={{ background: `hsl(${18 + (i / 72) * 220} 92% 64%)` }} />)}</div>
}

function StepCard({ s, run, now }: { s: ExecutionStep; run: LiveRun; now: number }) {
  const st = stageOf(s.key)
  const Icon = st.icon
  const t = s.status === 'running' ? now - new Date(s.started_at).getTime() : s.duration_ms ?? 0
  return (
    <motion.li layout initial={{ opacity: 0, x: 24, filter: 'blur(6px)' }} animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      transition={{ type: 'spring', stiffness: 260, damping: 26 }}
      className={cx('relative rounded-2xl border p-3.5 backdrop-blur-xl transition-colors',
        s.status === 'running' ? 'border-ink/15 bg-white shadow-float' : s.status === 'failed' ? 'border-rose/40 bg-rose/10' : 'border-ink/[.07] bg-white/60')}>
      {s.status === 'running' && <span className="pointer-events-none absolute inset-0 rounded-2xl" style={{ boxShadow: `inset 0 0 0 1px ${st.tint}55, 0 0 40px -10px ${st.tint}` }} />}
      <div className="flex items-start gap-3">
        <span className="relative mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full" style={{ background: `${st.tint}26`, color: st.tint }}>
          {s.status === 'running' && <span className="absolute inset-0 animate-ping rounded-full opacity-30" style={{ background: st.tint }} />}
          {s.status === 'completed' ? <Check size={13} strokeWidth={2.6} /> : <Icon size={13} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cx('text-[13px] font-medium', s.status === 'running' ? 'text-ink' : 'text-ink/85')}>{s.name}</span>
            <span className={cx('shrink-0 font-mono text-[10.5px] tabular-nums', t >= 5000 ? 'text-[#ffb08a]' : 'text-ink/45')}>{ms(Math.max(0, t))}</span>
          </div>
          {s.summary && <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink/50">{s.summary}</p>}
          {s.error && <p className="mt-1 text-[11.5px] text-rose">{s.error}</p>}
          <Detail s={s} run={run} />
        </div>
      </div>
    </motion.li>
  )
}

/* ------------------------------------------------------------------ captions */
function splitCode(text: string): { prose: string; code: string | null; lang: string } {
  const m = text.match(/```(\w*)\n?([\s\S]*?)(```|$)/)
  if (!m) return { prose: text, code: null, lang: '' }
  return { prose: text.replace(m[0], ' ').replace(/\[[DMWSC]\d+\]/g, ''), code: m[2], lang: m[1] || 'code' }
}

/* ------------------------------------------------------------------ stage */
export function VoiceStage({ recording, level, elapsed, onSend, onCancel, onListen, onClose }: {
  recording: boolean; level: RefObject<number>; elapsed: number
  onSend: () => void; onCancel: () => void; onListen: () => void; onClose: () => void
}) {
  const { runs, activeRunId, messages, retryVoice } = useAgent()
  const run = activeRunId ? runs[activeRunId] : undefined
  const [speaking, setSpeaking] = useState(false)
  const [handsFree, setHandsFree] = useState(() => { try { return localStorage.getItem('aura.handsfree') === '1' } catch { return false } })
  const [lang] = useSpokenLanguage()
  useEffect(() => player.subscribe((s) => setSpeaking(s.playing)), [])
  const running = run?.status === 'running'
  const now = useNow(!!running)
  const answer = run && messages.find((m) => m.role === 'assistant' && m.execution === run.id)
  const text = answer?.content ?? run?.streamed ?? ''
  const { prose, code, lang: codeLang } = useMemo(() => splitCode(text), [text])
  const phase: 'listening' | 'thinking' | 'answering' | 'speaking' | 'done' | 'idle' =
    recording ? 'listening' : speaking ? 'speaking' : running ? (run?.streamed ? 'answering' : 'thinking') : run ? 'done' : 'idle'
  const orbMode: OrbMode = phase === 'listening' ? 'listening' : phase === 'speaking' ? 'speaking' : phase === 'thinking' || phase === 'answering' ? 'thinking' : run?.status === 'failed' ? 'error' : 'idle'
  const steps = (run?.steps ?? []).filter((s) => !['input', 'response', 'validation'].includes(s.key))
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }) }, [steps.length, steps[steps.length - 1]?.status])

  // hands-free: when Aura finishes speaking, listen again
  const was = useRef(phase)
  useEffect(() => {
    if (handsFree && was.current === 'speaking' && phase === 'done') { const t = setTimeout(onListen, 700); return () => clearTimeout(t) }
    was.current = phase
  }, [phase, handsFree, onListen])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); recording ? onCancel() : onClose() }
      else if ((e.key === 'Enter' || e.key === ' ') && recording) { e.preventDefault(); onSend() }
      else if (e.key === ' ' && !recording && !running) { e.preventDefault(); onListen() }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [recording, running, onSend, onCancel, onClose, onListen])

  const live = livePhase(run, recording, speaking)
  const [paused, setPaused] = useState(false)
  useEffect(() => player.subscribe((st) => setPaused(!st.playing && !!st.messageId && st.time > 0)), [])
  const title = live ? PHASES.find((p) => p.id === live)!.l : { listening: 'Listening', thinking: 'Thinking', answering: 'Answering', speaking: 'Speaking', done: 'Done', idle: 'Ready' }[phase]
  const caption = prose.replace(/\[[DMWSC]\d+\]/g, '').replace(/[*#`]/g, '').trim()
  const total = run ? (running ? now - run.startedAt : run.durationMs ?? 0) : 0
  const orbSize = Math.min(phase === 'listening' || phase === 'idle' ? 280 : 200, window.innerWidth * 0.5)

  return createPortal(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }}
      className="fixed inset-0 z-40 flex overflow-hidden bg-paper text-ink">
      {/* living backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-[30%] top-1/2 h-[90vmin] w-[90vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(167,123,255,.22),transparent_62%)] blur-2xl" />
        <div className="absolute -left-[10%] top-[5%] h-[55vmin] w-[55vmin] rounded-full bg-[#ff8a5b] opacity-[.35] blur-[130px] animate-drift-a" />
        <div className="absolute bottom-[-10%] right-[25%] h-[60vmin] w-[60vmin] rounded-full bg-[#5b8cff] opacity-[.3] blur-[140px] animate-drift-b" />
        <div className="absolute inset-0 opacity-[.07] [background-image:radial-gradient(rgba(12,12,16,.5)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(ellipse_at_center,#000,transparent_75%)]" />
      </div>

      {/* top bar */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-6 py-5">
        <div className="flex items-center gap-3">
          <span className="h-6 w-6 rounded-full bg-[radial-gradient(circle_at_35%_30%,#fff,#ffb08a_35%,#b98cff_70%,#6f9bff)]" />
          <span className="font-serif text-[22px] leading-none">Aura <span className="italic text-ink/50">voice</span></span>
          {run && <span className="ml-2 rounded-full border border-ink/10 px-2.5 py-0.5 font-mono text-[11px] tabular-nums text-ink/60">{ms(total)}</span>}
        </div>
        <div className="absolute left-1/2 -translate-x-1/2"><PhaseRibbon phase={live} /></div>
        <div className="flex items-center gap-2">
          <button onClick={() => { const v = !handsFree; setHandsFree(v); try { localStorage.setItem('aura.handsfree', v ? '1' : '0') } catch { /* */ } }}
            className={cx('flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12px] transition', handsFree ? 'border-mint/50 bg-mint/15 text-mint' : 'border-ink/15 bg-white/70 text-ink/70 hover:bg-white/70')}
            title="Keep the conversation going: listen again after each answer">
            <Repeat size={13} /> Hands-free {handsFree ? 'on' : 'off'}
          </button>
          <LangPicker up={false} />
          <button onClick={recording ? onCancel : onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full border border-ink/15 bg-white/70 text-ink/70 transition hover:bg-white/70 hover:text-ink"><X size={16} /></button>
        </div>
      </div>

      {/* left: orb, transcript, captions */}
      <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center px-8 pb-28 pt-20">
        <motion.div layout transition={{ type: 'spring', stiffness: 120, damping: 20 }}>
          <Orb size={orbSize} mode={orbMode} level={recording ? level : speaking ? player.level : undefined} />
        </motion.div>
        <AnimatePresence mode="wait">
          <motion.div key={title} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="mt-10 text-center">
            <div className="font-serif text-[clamp(32px,4.2vw,52px)] leading-none tracking-[-0.01em]">
              {title}{phase === 'listening' && lang !== 'auto' ? <span className="italic text-ink/60"> in {LNAME[lang]}</span> : phase === 'listening' || phase === 'thinking' ? '…' : ''}
            </div>
            {phase === 'listening' && <div className="mt-4 font-mono text-[15px] tabular-nums text-ink/70">{new Date(elapsed).toISOString().slice(14, 19)}</div>}
            {phase === 'listening' && <LiveWave level={level} />}
            {phase === 'listening' && <div className="mt-2 text-[13px] text-ink/45">Any Indian language, any accent. Code-mixing is fine.</div>}
          </motion.div>
        </AnimatePresence>

        {run?.input && !recording && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-6 max-w-[640px] text-center text-[14px] leading-relaxed text-ink/50">
            <span className="mr-1.5 text-ink/30">You said</span>“{run.input}”
          </motion.p>
        )}

        {!recording && caption && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="scroll-quiet mt-6 max-h-[24vh] w-full max-w-[720px] overflow-y-auto text-center font-serif text-[clamp(19px,2vw,25px)] leading-[1.45] text-ink/90">
            {phase === 'done' ? caption : caption.slice(-340)}
            {running && <span className="ml-1 inline-block h-[0.9em] w-[2px] translate-y-[2px] animate-pulse bg-violet" />}
          </motion.div>
        )}

        {!recording && answer?.payload?.clarify && (
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {answer.payload.clarify.options.map((o) => (
              <button key={o.language} onClick={() => retryVoice(answer.payload!.clarify!.message_id, o.language)}
                className="bento glass max-w-[300px] rounded-2xl border border-white/80 px-4 py-3 text-left shadow-soft transition hover:-translate-y-0.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-violet">{o.language_name}</span>
                <span className="mt-1 block font-serif text-[18px] leading-snug text-ink">“{o.text}”</span>
              </button>
            ))}
          </div>
        )}

        {!recording && code && (
          <motion.div initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            className="keep-code mt-6 w-full max-w-[720px] overflow-hidden rounded-2xl border border-ink/10 bg-[#121019] shadow-[0_30px_80px_-30px_rgba(167,123,255,.5)]">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-[11px] text-white/50">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" /><span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" /><span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" /><span className="ml-2 font-mono">{codeLang}</span></span>
              <button onClick={() => navigator.clipboard?.writeText(code)} className="rounded-md px-2 py-0.5 transition hover:bg-white/10 hover:text-white">Copy</button>
            </div>
            <pre className="scroll-quiet max-h-[34vh] overflow-auto p-4 font-mono text-[12.5px] leading-relaxed text-[#e9e6ff]"><code>{code}</code></pre>
          </motion.div>
        )}

        {/* controls */}
        <div className="absolute bottom-8 flex items-center gap-5">
          {recording ? (
            <>
              <button onClick={onCancel} aria-label="Cancel" className="grid h-14 w-14 place-items-center rounded-full border border-ink/15 bg-white/70 text-ink/70 transition hover:bg-white/70 hover:text-ink"><X size={20} /></button>
              <button onClick={onSend} aria-label="Send" className="group relative grid h-20 w-20 place-items-center rounded-full">
                <span className="absolute inset-0 animate-[spin_3s_linear_infinite] rounded-full bg-[conic-gradient(from_180deg,#ff8a5b,#a77bff,#5b8cff,#ff8a5b)]" />
                <span className="absolute inset-[3px] rounded-full bg-white transition group-hover:inset-[5px]" />
                <ArrowUp size={26} strokeWidth={2.2} className="relative text-ink" />
              </button>
              <span className="w-14" />
            </>
          ) : speaking || paused ? (
            <>
              <button onClick={() => (paused ? player.resume() : player.pause())} aria-label={paused ? 'Resume' : 'Pause'}
                className="grid h-14 w-14 place-items-center rounded-full border border-ink/15 bg-white/80 text-ink transition hover:scale-105">{paused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}</button>
              <button onClick={() => { player.stop(); setPaused(false) }} aria-label="Stop speaking"
                className="grid h-14 w-14 place-items-center rounded-full border border-ink/15 bg-white/80 text-ink transition hover:scale-105"><Square size={16} fill="currentColor" /></button>
              <button onClick={() => { player.stop(); setPaused(false); onListen() }} aria-label="Interrupt and speak" className="group relative grid h-16 w-16 place-items-center rounded-full">
                <span className="absolute inset-0 rounded-full bg-[conic-gradient(from_180deg,#ff8a5b,#a77bff,#5b8cff,#ff8a5b)] opacity-80 blur-md" />
                <span className="absolute inset-[3px] rounded-full bg-white" /><Mic size={22} className="relative text-ink" />
              </button>
            </>
          ) : (
            <button onClick={onListen} disabled={!!running} aria-label="Ask again"
              className="group relative grid h-20 w-20 place-items-center rounded-full disabled:opacity-40">
              <span className="absolute inset-0 rounded-full bg-[conic-gradient(from_180deg,#ff8a5b,#a77bff,#5b8cff,#ff8a5b)] opacity-80 blur-md transition group-hover:opacity-100" />
              <span className="absolute inset-[3px] rounded-full bg-white" />
              <Mic size={26} className="relative text-ink" />
            </button>
          )}
        </div>
        <div className="absolute bottom-2 text-[11px] text-ink/30">{recording ? 'Enter or Space to send · Esc to cancel' : 'Space to speak again · Esc to close'}</div>
      </div>

      {/* right: every step, live */}
      <AnimatePresence>
        {steps.length > 0 && !recording && (
          <motion.aside initial={{ x: 60, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 60, opacity: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 28 }}
            className="relative z-10 hidden w-[420px] shrink-0 flex-col border-l border-ink/[.06] bg-white/40 px-5 pb-6 pt-20 backdrop-blur-2xl lg:flex">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10.5px] font-medium uppercase tracking-[0.2em] text-ink/40">Every step, live</span>
              <span className="text-[11px] text-ink/40">{steps.length} steps</span>
            </div>
            <ol ref={list} className="scroll-quiet -mr-2 flex-1 space-y-2 overflow-y-auto pr-2">
              {steps.map((s) => <StepCard key={s.id} s={s} run={run!} now={now} />)}
            </ol>
          </motion.aside>
        )}
      </AnimatePresence>
    </motion.div>, document.body)
}
