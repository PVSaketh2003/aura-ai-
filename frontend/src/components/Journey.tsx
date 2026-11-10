import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, BookMarked, Brain, Check, FolderSearch, Globe, PenLine, ScanSearch, Sparkles, Volume2, X, type LucideIcon } from 'lucide-react'
import type { LiveRun } from '../context/AgentContext'
import { useNow } from '../hooks/useHealth'
import type { ExecutionStep } from '../types'
import { cx, ms } from '../utils/format'

/** The agent's work, grouped into the handful of stages a person cares about. */
export interface Stage { id: string; label: string; icon: LucideIcon; keys: string[]; tint: string }
export const STAGES: Stage[] = [
  { id: 'hear', label: 'Listening', icon: AudioLines, keys: ['asr'], tint: '#ff8a5b' },
  { id: 'understand', label: 'Understanding', icon: Sparkles, keys: ['input', 'language', 'intent', 'calculator', 'context', 'localize'], tint: '#f59e6b' },
  { id: 'memory', label: 'Memory', icon: Brain, keys: ['query_embedding', 'memory_retrieval', 'conversation_search', 'memory_extraction', 'memory_embedding', 'memory_postgres', 'memory_vector'], tint: '#c27bff' },
  { id: 'search', label: 'Searching', icon: ScanSearch, keys: ['translate_query', 'similarity_search', 'multi_query', 'mmr', 'retrieval_evaluation', 'retrieval_route', 'document_retrieval'], tint: '#a77bff' },
  { id: 'web', label: 'Wider search', icon: Globe, keys: ['wikipedia', 'web_search'], tint: '#5b8cff' },
  { id: 'files', label: 'Your Mac', icon: FolderSearch, keys: ['parse_request', 'local_agent', 'find_folder', 'list_files', 'file_search', 'content_search', 'transfer', 'inspect', 'loader', 'ocr', 'chunking', 'embedding', 'vector_store', 'metadata', 'dedupe', 'directory_loader', 'extract'], tint: '#5b8cff' },
  { id: 'write', label: 'Writing', icon: PenLine, keys: ['prompt', 'llm_generation', 'language_fix', 'validation'], tint: '#4f9bff' },
  { id: 'speak', label: 'Speaking', icon: Volume2, keys: ['response', 'tts'], tint: '#2fbf8f' },
]

export const stageOf = (key: string): Stage => STAGES.find((s) => s.keys.includes(key)) ?? STAGES[1]

type SState = 'done' | 'active' | 'pending' | 'failed'
interface Built { stage: Stage; steps: ExecutionStep[]; state: SState; ms: number }

export function buildStages(run: LiveRun, now: number): Built[] {
  const running = run.status === 'running'
  const out: Built[] = []
  for (const st of STAGES) {
    const steps = run.steps.filter((s) => st.keys.includes(s.key))
    if (!steps.length) continue
    const failed = steps.some((s) => s.status === 'failed')
    const active = steps.some((s) => s.status === 'running')
    const total = steps.reduce((a, s) => a + (s.status === 'running' ? Math.max(0, now - new Date(s.started_at).getTime()) : s.duration_ms ?? 0), 0)
    out.push({ stage: st, steps, state: failed ? 'failed' : active ? 'active' : 'done', ms: total })
  }
  if (running) {
    const isAction = run.steps.some((s) => ['memory_extraction', 'parse_request', 'local_agent', 'file_search'].includes(s.key))
    for (const id of isAction ? ['speak'] : ['write', 'speak']) {
      if (!out.some((b) => b.stage.id === id)) out.push({ stage: STAGES.find((s) => s.id === id)!, steps: [], state: 'pending', ms: 0 })
    }
    // between steps nothing is "running": show the latest unfinished stage as active
    if (!out.some((b) => b.state === 'active')) {
      const firstPending = out.find((b) => b.state === 'pending')
      if (firstPending) firstPending.state = 'active'
    }
  }
  return out
}

function Node({ b, size = 34 }: { b: Built; size?: number }) {
  const Icon = b.stage.icon
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      {b.state === 'active' && (
        <>
          <span className="absolute inset-0 animate-spin-slow rounded-full" style={{ background: `conic-gradient(from 0deg, transparent 0%, ${b.stage.tint} 65%, #fff 100%)`, mask: 'radial-gradient(circle, transparent 58%, #000 61%)', WebkitMask: 'radial-gradient(circle, transparent 58%, #000 61%)' }} />
          <span className="absolute inset-[-6px] animate-ping rounded-full opacity-20" style={{ background: b.stage.tint }} />
        </>
      )}
      <span className={cx('relative grid place-items-center rounded-full transition-all duration-500',
        b.state === 'done' ? 'bg-ink text-white shadow-[0_6px_16px_-6px_rgb(12_12_16/.55)]'
          : b.state === 'failed' ? 'bg-rose text-white'
            : b.state === 'active' ? 'bg-white text-ink shadow-soft' : 'border border-dashed border-faint bg-white/40 text-faint')}
        style={{ width: size - 8, height: size - 8 }}>
        {b.state === 'done' ? <Check size={size * 0.36} strokeWidth={2.6} /> : b.state === 'failed' ? <X size={size * 0.36} strokeWidth={2.6} /> : <Icon size={size * 0.4} strokeWidth={1.8} style={b.state === 'active' ? { color: b.stage.tint } : undefined} />}
      </span>
    </span>
  )
}

/** What's happening right now, in plain words, with the real numbers from the step. */
function liveLine(run: LiveRun): { title: string; text: string } | null {
  const cur = [...run.steps].reverse().find((s) => s.status === 'running') ?? run.steps[run.steps.length - 1]
  if (!cur) return null
  if (cur.key === 'llm_generation' && run.llm) {
    const l = run.llm
    if (l.phase === 'reading') return { title: 'Reading the passages', text: `Llama is reading a ~${(l.prompt_tokens ?? 0).toLocaleString()}-token prompt built from your sources` }
    return { title: 'Writing the answer', text: `${l.tokens} tokens written${l.first_token_ms ? ` · first word after ${ms(l.first_token_ms)}` : ''}` }
  }
  return { title: cur.name, text: cur.summary }
}

/** Live, in-thread view of the agent's journey: stage nodes with timers, a flowing connector and a narrated line. */
export function Journey({ run }: { run: LiveRun }) {
  const running = run.status === 'running'
  const now = useNow(running)
  const stages = buildStages(run, now)
  const line = liveLine(run)
  const total = running ? now - run.startedAt : run.durationMs ?? 0
  const reading = running && run.llm?.phase === 'reading'
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="spot-border relative overflow-hidden rounded-[26px] border border-line bg-white/70 p-5 shadow-float backdrop-blur-xl">
      <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-[#e3d6ff] opacity-60 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-28 -left-16 h-56 w-56 rounded-full bg-[#ffe1d2] opacity-60 blur-3xl" />
      <div className="relative mb-4 flex items-center justify-between">
        <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-mute">
          <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet opacity-60" /><span className="relative h-2 w-2 rounded-full bg-violet" /></span>
          Aura is working
        </span>
        <span className="font-mono text-[12px] tabular-nums text-ink-2">{ms(total)}</span>
      </div>
      <div className="relative flex items-start">
        {stages.map((b, i) => (
          <div key={b.stage.id} className="relative flex min-w-0 flex-1 flex-col items-center">
            {i > 0 && (
              <span className="absolute right-1/2 top-[17px] h-[2px] w-full -translate-y-1/2 overflow-hidden rounded-full bg-ink/[.07]" style={{ marginRight: 20, width: 'calc(100% - 40px)' }}>
                <motion.span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-coral via-violet to-sky" initial={{ width: 0 }}
                  animate={{ width: b.state === 'pending' ? '0%' : '100%' }} transition={{ duration: 0.6, ease: 'easeOut' }} />
                {b.state === 'active' && <span className="xr-flow absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white to-transparent" />}
              </span>
            )}
            <Node b={b} />
            <span className={cx('mt-2 truncate text-[11.5px] font-medium', b.state === 'pending' ? 'text-faint' : b.state === 'active' ? 'text-ink' : 'text-ink-2')}>{b.stage.label}</span>
            <span className={cx('font-mono text-[10px] tabular-nums', b.ms >= 5000 ? 'text-[#c4562a]' : 'text-mute')}>{b.state === 'pending' ? '·' : ms(b.ms)}</span>
          </div>
        ))}
      </div>
      <AnimatePresence mode="wait">
        {line && (
          <motion.div key={line.title} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.25 }}
            className="relative mt-5 rounded-2xl border border-line bg-white/80 px-4 py-3">
            <div className="text-shimmer text-[13px] font-medium">{line.title}</div>
            {line.text && <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-mute">{line.text}</div>}
            {reading && <div className="relative mt-2.5 h-1 overflow-hidden rounded-full bg-ink/[.06]"><span className="xr-scan absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-violet to-transparent" /></div>}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** Compact, finished journey shown under an answer: stage chips with their times. */
export function JourneyStrip({ run, onOpen }: { run: LiveRun; onOpen: () => void }) {
  const stages = buildStages(run, Date.now())
  if (!stages.length) return null
  return (
    <button onClick={onOpen} className="group mt-4 flex max-w-full flex-wrap items-center gap-1 rounded-full border border-line bg-white/60 py-1 pl-1 pr-3 text-[11px] text-mute transition hover:border-line-2 hover:bg-white">
      {stages.map((b) => {
        const Icon = b.stage.icon
        return (
          <span key={b.stage.id} className="flex items-center gap-1 rounded-full px-1.5 py-0.5" title={`${b.stage.label} · ${ms(b.ms)}`}>
            <Icon size={11} style={{ color: b.stage.tint }} />
            <span className={cx('font-mono tabular-nums', b.ms >= 5000 && 'text-[#c4562a]')}>{ms(b.ms)}</span>
          </span>
        )
      })}
      <span className="ml-1 flex items-center gap-1 font-medium text-ink-2 group-hover:text-ink"><BookMarked size={11} /> {ms(run.durationMs)} · trace</span>
    </button>
  )
}
