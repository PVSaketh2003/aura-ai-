import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, BookOpen, Brain, Check, Copy, Download, Globe, HelpCircle, Mic, Pause, Pencil, Play, RefreshCw, Search, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAgent } from '../context/AgentContext'
import { api } from '../services/api'
import { player, type PlayerState } from '../services/player'
import type { AgentPayload, Citation, Message } from '../types'
import { cx, ms } from '../utils/format'
import { Journey, JourneyStrip } from './Journey'
import { Markdown } from './Markdown'

const LANG: Record<string, string> = { sa: 'संस्कृतम्', as: 'অসমীয়া', en: 'English', hi: 'हिन्दी', te: 'తెలుగు', ta: 'தமிழ்', kn: 'ಕನ್ನಡ', ml: 'മലയാളം', bn: 'বাংলা',
  mr: 'मराठी', gu: 'ગુજરાતી', pa: 'ਪੰਜਾਬੀ', or: 'ଓଡ଼ିଆ', ur: 'اردو', es: 'Español', fr: 'Français', de: 'Deutsch' }

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function usePlayer() {
  const [s, set] = useState<PlayerState>(player.state)
  useEffect(() => player.subscribe(set), [])
  return s
}

function CiteChip({ id, c }: { id: string; c?: Citation }) {
  if (!c) return null
  const head = c.kind === 'document' ? `${c.title}${c.page ? ` · p.${c.page}` : ''}` : c.kind === 'memory' ? `Saved ${fmtDate(c.created_at)}` : c.title
  const label = <><span className="block font-medium">{head}</span>{c.snippet && <span className="mt-1 block text-white/70">{c.snippet.slice(0, 180)}…</span>}</>
  const inner = (
    <span className="group/cite relative mx-[1px] inline-flex -translate-y-[1px] cursor-default items-center rounded-md border border-line bg-white px-1 font-mono text-[10px] leading-[16px] text-ink-2 align-middle transition hover:border-violet/40 hover:text-violet">
      {id}
      <span className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-20 w-max max-w-[320px] -translate-x-1/2 rounded-lg bg-ink px-2.5 py-1.5 font-sans text-[11.5px] leading-snug text-white opacity-0 shadow-float transition group-hover/cite:opacity-100">{label}</span>
    </span>
  )
  return c.url ? <a href={c.url} target="_blank" rel="noreferrer noopener">{inner}</a> : inner
}

/** Waveform voice player. Bars are a stable fingerprint of the message; the played part fills with the aura gradient,
 *  and while Aura is speaking live the bars move with her voice. */
function VoiceWave({ m }: { m: Message }) {
  const st = usePlayer()
  const audio = m.payload?.audio
  const mine = st.messageId === m.id
  const playing = mine && st.playing
  const bars = useRef<HTMLDivElement>(null)
  const N = 56
  const shape = useRef<number[]>([])
  if (!shape.current.length) {
    let h = 0
    for (const ch of m.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    shape.current = Array.from({ length: N }, (_, i) => {
      h = (h * 1103515245 + 12345) >>> 0
      const env = Math.sin((i / N) * Math.PI) * 0.5 + 0.5
      return 0.18 + ((h % 1000) / 1000) * 0.62 * env + 0.12
    })
  }
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const el = bars.current
      if (el) {
        const lv = player.level.current
        Array.from(el.children).forEach((b, i) => {
          const base = shape.current[i]
          ;(b as HTMLElement).style.transform = `scaleY(${Math.min(1, base * (0.75 + lv * 1.1 * (0.6 + 0.4 * Math.sin(i * 1.7 + performance.now() / 140))))})`
        })
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => { cancelAnimationFrame(raf); Array.from(bars.current?.children ?? []).forEach((b, i) => { (b as HTMLElement).style.transform = `scaleY(${shape.current[i]})` }) }
  }, [playing])
  if (!audio && !mine) return null
  const dur = audio?.seconds || st.duration || 0
  const pct = mine && dur ? Math.min(1, st.time / (st.duration || dur)) : 0
  const fmt = (x: number) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`
  return (
    <div className="mt-5 flex max-w-[460px] items-center gap-3 rounded-[20px] border border-line bg-white/75 py-2 pl-2 pr-4 shadow-soft">
      <button onClick={() => (playing ? player.pause() : audio && player.play(m.id, audio.url))} disabled={!audio && !playing}
        aria-label={playing ? 'Pause' : 'Play answer'}
        className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink text-white transition hover:scale-105 disabled:opacity-40">
        {playing && <span className="absolute -inset-1 animate-ping rounded-full bg-violet/25" />}
        {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="translate-x-[1px]" />}
      </button>
      <div ref={bars} className="flex h-9 flex-1 cursor-pointer items-center gap-[2px]"
        onClick={(e) => { if (!audio) return; const r = e.currentTarget.getBoundingClientRect(); const f = (e.clientX - r.left) / r.width
          if (!mine) player.play(m.id, audio.url); setTimeout(() => player.seek(f * (st.duration || dur)), mine ? 0 : 150) }}>
        {shape.current.map((h, i) => (
          <span key={i} className={cx('h-full flex-1 origin-center rounded-full transition-colors duration-200', i / N < pct ? '' : 'bg-ink/[.12]')}
            style={{ transform: `scaleY(${h})`, ...(i / N < pct ? { background: `hsl(${18 + (i / N) * 210} 95% 66%)` } : {}) }} />
        ))}
      </div>
      <span className="font-mono text-[10.5px] tabular-nums text-mute">{audio ? (mine && st.time ? fmt(st.time) : fmt(dur)) : playing ? 'live' : '…'}</span>
      {audio && <a href={`${audio.url}?download=1`} aria-label="Download audio" className="text-faint transition hover:text-ink"><Download size={13} /></a>}
    </div>
  )
}

/** 3-D tilt toward the cursor, with a moving glare. */
const tilt = {
  onMouseMove: (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget, r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5
    el.style.transform = `perspective(700px) rotateY(${px * 9}deg) rotateX(${-py * 9}deg) translateY(-2px)`
    el.style.backgroundImage = `radial-gradient(240px circle at ${(px + 0.5) * 100}% ${(py + 0.5) * 100}%, rgba(167,123,255,.14), transparent 60%)`
  },
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.transform = ''; e.currentTarget.style.backgroundImage = '' },
}

/** The exact passages the answer is grounded in: one card per cited source, with page, match strength and the text. */
function SourceCards({ p }: { p: Partial<AgentPayload> }) {
  const cites = Object.entries(p.citations ?? {})
  const [open, setOpen] = useState<string | null>(null)
  if (!cites.length) {
    const docs = p.source_documents ?? []
    if (!docs.length) return null
    return (
      <div className="mt-4 flex flex-wrap gap-2">
        {docs.map((d) => (
          <span key={d.document_id} className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-white/70 px-2.5 py-1.5 text-[12px] text-ink-2">
            <BookOpen size={12} className="text-violet" /> <span className="max-w-[220px] truncate font-medium">{d.filename}</span>
            {d.page_numbers.length > 0 && <span className="text-mute">p. {d.page_numbers.slice(0, 6).join(', ')}</span>}
          </span>
        ))}
      </div>
    )
  }
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">
        Grounded in {cites.length} source{cites.length > 1 ? 's' : ''}<span className="h-px flex-1 bg-line" />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {cites.map(([id, c]) => {
          const Icon = c.kind === 'memory' ? Brain : c.kind === 'document' ? BookOpen : Globe
          const tint = c.kind === 'memory' ? 'text-coral' : c.kind === 'document' ? 'text-violet' : 'text-sky'
          const isOpen = open === id
          const body = (
            <>
              <div className="flex items-center gap-2">
                <span className="grid h-6 min-w-6 place-items-center rounded-md bg-ink px-1 font-mono text-[10px] text-white">{id}</span>
                <Icon size={13} className={tint} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{c.kind === 'memory' ? 'Saved memory' : c.title}</span>
                {c.page != null && <span className="shrink-0 font-mono text-[10.5px] text-mute">p.{c.page}{c.page_end && c.page_end !== c.page ? `–${c.page_end}` : ''}</span>}
              </div>
              {c.similarity != null && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-ink/[.06]">
                    <span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-coral via-violet to-sky" style={{ width: `${Math.max(4, Math.min(100, c.similarity * 100))}%` }} />
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-mute">{c.similarity.toFixed(2)} match</span>
                </div>
              )}
              {c.snippet && <p className={cx('mt-2 text-[12px] leading-relaxed text-ink-2/80', !isOpen && 'line-clamp-2')}>{c.snippet}{isOpen && c.snippet.length >= 320 ? '…' : ''}</p>}
              {c.kind === 'memory' && c.created_at && <p className="mt-1 text-[11px] text-mute">saved {fmtDate(c.created_at)}</p>}
            </>
          )
          const cls = 'block rounded-2xl border border-line bg-white/70 p-3 text-left transition-[transform,box-shadow,border-color] duration-200 will-change-transform hover:-translate-y-0.5 hover:border-line-2 hover:bg-white hover:shadow-soft'
          return c.url
            ? <a key={id} href={c.url} target="_blank" rel="noreferrer noopener" className={cls} {...tilt}>{body}</a>
            : <button key={id} onClick={() => setOpen(isOpen ? null : id)} className={cls} {...tilt}>{body}</button>
        })}
      </div>
    </div>
  )
}

/** Where the answer came from — one pill per kind of source actually cited, or "General knowledge · unverified". */
const KIND: Record<string, { label: string; icon: typeof BookOpen; c: string; bg: string }> = {
  document: { label: 'Your PDFs', icon: BookOpen, c: '#7c4dff', bg: 'rgb(167 123 255 / .12)' },
  wikipedia: { label: 'Wikipedia', icon: Globe, c: '#2f6bff', bg: 'rgb(91 140 255 / .12)' },
  web: { label: 'Web', icon: Search, c: '#0e9f6e', bg: 'rgb(47 191 143 / .13)' },
  memory: { label: 'Your memory', icon: Brain, c: '#e2612f', bg: 'rgb(255 138 91 / .14)' },
}
function SourcePills({ p }: { p: Partial<AgentPayload> }) {
  if (p.source_type === 'system') return null
  const kinds = [...new Set(Object.values(p.citations ?? {}).map((c) => c.kind))]
  if (!kinds.length) return <span className="src-pill" style={{ color: '#8a6d00', background: 'rgb(255 196 0 / .14)' }}><HelpCircle size={11} />General knowledge · unverified</span>
  return <>{kinds.map((k) => { const v = KIND[k] ?? KIND.web; const I = v.icon
    return <span key={k} className="src-pill" style={{ color: v.c, background: v.bg }}><I size={11} />{v.label}</span> })}</>
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false)
  const plain = text.replace(/\s?\[[DMWSC]\d+\]/g, '')
  return (
    <button onClick={() => navigator.clipboard?.writeText(plain).then(() => { setOk(true); setTimeout(() => setOk(false), 1400) })}
      className="act" title="Copy answer">{ok ? <Check size={13} /> : <Copy size={13} />}<span>{ok ? 'Copied' : 'Copy'}</span></button>
  )
}

/** "Which language did you say?" — shown when speech recognition was not confident; re-runs the same recording. */
function Clarify({ m }: { m: Message }) {
  const { retryVoice, busy } = useAgent()
  const c = m.payload?.clarify
  if (!c) return null
  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      {c.options.map((o) => (
        <button key={o.language} disabled={busy} onClick={() => retryVoice(c.message_id, o.language)}
          className="bento glass rounded-2xl border border-white/80 p-3.5 text-left shadow-soft transition hover:-translate-y-0.5 disabled:opacity-50">
          <span className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.14em] text-violet">
            {o.language_name}{o.probability != null && <span className="font-mono normal-case tracking-normal text-mute">{Math.round(o.probability * 100)}%</span>}
          </span>
          <span className="mt-1 block text-[14px] leading-snug text-ink">“{o.text}”</span>
          <span className="mt-2 block text-[11.5px] text-mute">Answer in {o.language_name} →</span>
        </button>
      ))}
    </div>
  )
}

function Feedback({ m }: { m: Message }) {
  const [rating, setRating] = useState<1 | -1 | null>(null)
  const rate = (r: 1 | -1) => { setRating(r); api.feedback(m.id, { rating: r }).catch(() => setRating(null)) }
  return (
    <span className="flex items-center gap-0.5">
      {([1, -1] as const).map((r) => {
        const Icon = r === 1 ? ThumbsUp : ThumbsDown
        return <button key={r} onClick={() => rate(r)} aria-label={r === 1 ? 'Good answer' : 'Bad answer'}
          className={cx('rounded-md p-1 transition hover:bg-ink/5', rating === r ? 'text-ink' : 'text-faint hover:text-ink-2')}><Icon size={12} /></button>
      })}
    </span>
  )
}

function Meta({ m }: { m: Message }) {
  const { runs, selectRun, activeRunId, regenerate, busy } = useAgent()
  const p = m.payload ?? {}
  const run = m.execution ? runs[m.execution] : undefined
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1 border-t border-line pt-3 text-[11.5px] text-mute">
      <CopyBtn text={m.content} />
      {p.source_type !== 'system' && <button className="act" disabled={busy} onClick={() => regenerate(m.id)} title="Ask again for a fresh answer"><RefreshCw size={13} /><span>Regenerate</span></button>}
      {p.source_type !== 'system' && <Feedback m={m} />}
      <span className="ml-auto flex items-center gap-2">
        {p.model && <span className="font-mono text-[10.5px]">{p.model}</span>}
        {p.source_type !== 'system' && p.confidence != null && <span>· {Math.round(p.confidence * 100)}% confident</span>}
        {m.execution && (
          <button onClick={() => selectRun(m.execution!)} className={cx('rounded-full px-2 py-0.5 transition hover:bg-ink/[.04] hover:text-ink', activeRunId === m.execution && 'text-ink')}>
            trace{run?.durationMs ? ` · ${ms(run.durationMs)}` : ''} →
          </button>
        )}
      </span>
    </div>
  )
}

const enter = (i: number) => ({ initial: { opacity: 0, y: 10, filter: 'blur(4px)' }, animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const, delay: Math.min(i, 6) * 0.02 } })

function SpeechMeta({ m }: { m: Message }) {
  const sp = m.payload?.speech
  const lang = LANG[sp?.detected_language ?? m.language ?? ''] ?? (m.language || '')
  if (!sp) return <>Voice{lang ? ` · ${lang}` : ''}</>
  if (sp.status === 'uncertain') return <>Voice · language unclear</>
  const how = sp.selected_language !== 'auto' ? 'your choice' : sp.lid_confidence != null ? `detected ${Math.round(sp.lid_confidence * 100)}%` : 'detected'
  return <>Voice · <b className="font-semibold text-white/85">{lang}</b> · {how} · {sp.asr_model.replace(' · MLX GPU', '')}{sp.asr_confidence != null ? ` · ${Math.round(sp.asr_confidence * 100)}% sure` : ''}</>
}

function UserBubble({ m, i, onEdit }: { m: Message; i: number; onEdit: (t: string) => void }) {
  const pending = m.modality === 'voice' && m.content.startsWith('🎙')
  return (
    <motion.div {...enter(i)} className="group flex items-center justify-end gap-2">
      {!pending && <button onClick={() => onEdit(m.content)} aria-label="Edit and resend" title="Correct & resend"
        className="rounded-full p-1.5 text-faint opacity-0 transition hover:bg-ink/5 hover:text-ink group-hover:opacity-100"><Pencil size={12} /></button>}
      <div className="user-bubble relative max-w-[78%] rounded-[24px] rounded-br-lg bg-ink px-5 py-3 text-[15px] leading-relaxed text-white shadow-[0_10px_30px_-12px_rgb(12_12_16/.55)]">
        <span className="pointer-events-none absolute inset-0 rounded-[24px] rounded-br-lg bg-[radial-gradient(120%_80%_at_100%_0%,rgba(167,123,255,.35),transparent_60%)]" />
        {m.modality === 'voice' && (
          <div className="relative mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-white/60"><Mic size={11} />{pending ? 'Transcribing…' : <SpeechMeta m={m} />}</div>
        )}
        {pending ? <span className="flex h-5 items-center gap-1">{[0, 1, 2, 3, 4].map((k) => <span key={k} className="h-3 w-1 animate-pulse rounded-full bg-white/70" style={{ animationDelay: `${k * 0.12}s` }} />)}</span>
          : <span className="relative whitespace-pre-wrap">{m.content}</span>}
      </div>
    </motion.div>
  )
}

function AuraMark({ live = false }: { live?: boolean }) {
  return (
    <span className="relative grid h-7 w-7 place-items-center">
      {live && <span className="absolute inset-0 animate-ping rounded-full bg-violet/30" />}
      <span className="relative h-7 w-7 rounded-full bg-[radial-gradient(circle_at_35%_30%,#fff,#ffb08a_35%,#b98cff_70%,#6f9bff)] shadow-[0_4px_14px_-2px_rgb(167_123_255/.55)]" />
    </span>
  )
}

function AssistantHeader({ lang, live, label }: { lang?: string; live?: boolean; label?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <AuraMark live={live} />
      <span className="font-serif text-[19px] leading-none text-ink">Aura</span>
      {lang && lang !== 'en' && <span className="rounded-full border border-line bg-white/70 px-2 py-0.5 text-[11px] text-ink-2">{LANG[lang] ?? lang}</span>}
      {label && <span className="text-[11.5px] text-mute">{label}</span>}
    </div>
  )
}

function AssistantBubble({ m, i }: { m: Message; i: number }) {
  const cites = m.payload?.citations ?? {}
  const { runs, selectRun } = useAgent()
  const run = m.execution ? runs[m.execution] : undefined
  return (
    <motion.div {...enter(i)} className="answer-card px-6 pb-4 pt-5 text-[15.5px] leading-[1.75] text-ink-2" lang={m.payload?.language}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <AuraMark />
        <span className="font-serif text-[20px] leading-none text-ink">Aura</span>
        {m.payload?.language && <span className="rounded-full border border-line bg-white/80 px-2 py-0.5 text-[11px] text-ink-2">{LANG[m.payload.language] ?? m.payload.language}</span>}
        <span className="ml-auto flex flex-wrap gap-1.5"><SourcePills p={m.payload ?? {}} /></span>
      </div>
      <Markdown text={m.content} cite={(id, k) => <CiteChip key={k} id={id} c={cites[id]} />} />
      <Clarify m={m} />
      <SourceCards p={m.payload ?? {}} />
      <VoiceWave m={m} />
      {run && run.steps.length > 0 && run.status !== 'running' && <JourneyStrip run={run} onOpen={() => selectRun(run.id)} />}
      <Meta m={m} />
    </motion.div>
  )
}

function Pending({ runId }: { runId: string }) {
  const { runs } = useAgent()
  const r = runs[runId]
  if (!r) return null
  if (r.status === 'failed') return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3 rounded-2xl border border-rose/15 bg-rose/[.035] px-4 py-3.5 text-[13.5px] leading-relaxed text-ink-2">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-rose" />
      <div><div className="font-medium text-ink">I couldn’t complete that.</div><div className="mt-0.5 text-mute">{r.error || r.steps.find((s) => s.error)?.error}</div></div>
    </motion.div>
  )
  if (r.status !== 'running') return null
  const lang = r.steps.find((s) => s.key === 'asr')?.detail?.language as string | undefined
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[16px] leading-[1.75] text-ink-2">
      <AssistantHeader live lang={lang} label={r.streamed ? 'writing…' : 'thinking…'} />
      <div className="pl-[38px]">
        <Journey run={r} />
        {r.streamed && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="relative mt-5">
            <Markdown text={r.streamed} cite={(id, k) => <span key={k} className="mx-[1px] inline-flex -translate-y-[1px] items-center rounded-md border border-line bg-white px-1 align-middle font-mono text-[10px] leading-[16px] text-ink-2">{id}</span>} /><span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] animate-pulse bg-violet" />
          </motion.div>
        )}
      </div>
    </motion.div>
  )
}

export function Messages({ onEdit }: { onEdit: (t: string) => void }) {
  const { messages, activeRunId, runs } = useAgent()
  const end = useRef<HTMLDivElement>(null)
  const streamed = activeRunId ? runs[activeRunId]?.streamed.length : 0
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [messages.length, streamed, activeRunId])
  const answered = new Set(messages.filter((m) => m.role === 'assistant').map((m) => m.execution))
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-6 pb-10 pt-6">
      <AnimatePresence initial={false}>
        {messages.map((m, i) => m.role === 'user'
          ? <UserBubble key={m.id} m={m} i={i} onEdit={onEdit} />
          : <AssistantBubble key={m.id} m={m} i={i} />)}
      </AnimatePresence>
      {activeRunId && !answered.has(activeRunId) && <Pending runId={activeRunId} />}
      <div ref={end} />
    </div>
  )
}
