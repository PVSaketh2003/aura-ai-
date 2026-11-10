import { AnimatePresence, motion } from 'motion/react'
import { Check, PanelRightClose, PanelRightOpen, ScanEye, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAgent, type LiveRun } from '../context/AgentContext'
import { useNow } from '../hooks/useHealth'
import type { ExecutionStep } from '../types'
import { cx, ms } from '../utils/format'
import { Eyebrow, StatusDot } from './ui'
import { PipelineRail, StepVisual } from './Xray'
import { isIngestRun, ProcessingJourney } from './ProcessingJourney'

function Node({ status }: { status: ExecutionStep['status'] }) {
  if (status === 'completed') return <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-ink text-white"><Check size={10} strokeWidth={3} /></span>
  if (status === 'failed') return <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-rose text-white"><X size={10} strokeWidth={3} /></span>
  if (status === 'running') return (
    <span className="relative grid h-[18px] w-[18px] place-items-center">
      <span className="absolute inset-0 animate-spin-slow rounded-full bg-[conic-gradient(from_0deg,transparent_0%,#a77bff_70%,#ff8a5b)] [mask:radial-gradient(circle,transparent_5.5px,#000_6px)]" />
      <span className="h-1.5 w-1.5 rounded-full bg-violet" />
    </span>
  )
  return <span className="h-[18px] w-[18px] rounded-full border border-dashed border-faint" />
}

function Step({ s, last, now, run, xray }: { s: ExecutionStep; last: boolean; now: number; run: LiveRun; xray: boolean }) {
  const live = s.status === 'running' ? now - new Date(s.started_at).getTime() : s.duration_ms
  return (
    <motion.li layout="position" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className="relative flex gap-3.5 pb-5" data-step={s.key}>
      {!last && <span className={cx('absolute left-[8.5px] top-[22px] bottom-0 w-px', s.status === 'completed' ? 'bg-ink/15' : 'bg-line')} />}
      <div className="relative z-10 pt-[1px]"><Node status={s.status} /></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className={cx('text-[13px] font-medium', s.status === 'running' ? 'text-shimmer' : 'text-ink')}>{s.name}</span>
          <span className={cx('shrink-0 font-mono text-[11px] tabular-nums', s.status === 'failed' ? 'text-rose' : (live ?? 0) >= 5000 ? 'text-[#c4562a]' : 'text-mute')}>{ms(Math.max(0, live ?? 0))}</span>
        </div>
        {s.summary && <p className="mt-0.5 text-[12px] leading-relaxed text-mute">{s.summary}</p>}
        {s.error && <p className="mt-1.5 rounded-lg border border-rose/15 bg-rose/[.04] px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-rose">{s.error}</p>}
        {xray && <StepVisual step={s} run={run} steps={run.steps} />}
      </div>
    </motion.li>
  )
}

function RunView({ run, xray }: { run: LiveRun; xray: boolean }) {
  const running = run.status === 'running'
  const now = useNow(running)
  const total = running ? now - run.startedAt : run.durationMs
  const list = useRef<HTMLOListElement>(null)
  const follow = useRef(true)
  const tail = run.steps[run.steps.length - 1]

  // Follow the newest step while running, unless the user has scrolled up to inspect something.
  useEffect(() => {
    const el = list.current
    if (!el || !running || !follow.current) return
    const t = setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 80)
    return () => clearTimeout(t)
  }, [running, run.steps.length, tail?.status, run.streamed.length > 0])

  return (
    <motion.div key={run.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex min-h-0 flex-1 flex-col">
      {run.input && <p className="mb-5 line-clamp-3 font-serif text-[19px] leading-snug text-ink-2">“{run.input}”</p>}
      {isIngestRun(run) ? <div className="scroll-quiet mb-4 max-h-[52%] overflow-y-auto"><ProcessingJourney run={run} compact /></div>
        : xray && <PipelineRail steps={run.steps} running={running} />}
      <ol ref={list} onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120 }}
        className="scroll-quiet -mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
        <AnimatePresence initial={false}>
          {run.steps.map((s, i) => <Step key={s.id} s={s} last={i === run.steps.length - 1} now={now} run={run} xray={xray} />)}
        </AnimatePresence>
      </ol>
      <div className="mt-2 flex items-center justify-between border-t border-line pt-4 text-[12px]">
        <span className="flex items-center gap-2 text-ink-2">
          <StatusDot tone={running ? 'warn' : run.status === 'failed' ? 'down' : 'ok'} pulse={running} />
          {running ? 'Running' : run.status === 'failed' ? 'Failed' : 'Completed'}
          <span className="text-faint">·</span><span className="text-mute">{run.steps.length} steps</span>
        </span>
        <span className="font-mono tabular-nums text-ink-2">{ms(total)}</span>
      </div>
    </motion.div>
  )
}

const KEY = 'aura.trace.xray'
const OPEN = 'aura.trace.open'

export function TracePanel() {
  const { runs, activeRunId, socket } = useAgent()
  const run = activeRunId ? runs[activeRunId] : null
  const [xray, setXray] = useState(() => { try { return localStorage.getItem(KEY) !== '0' } catch { return true } })
  const toggle = (v: boolean) => { setXray(v); try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* private mode */ } }
  const [open, setOpenState] = useState(() => { try { return localStorage.getItem(OPEN) === '1' } catch { return false } })
  const setOpen = (v: boolean) => { setOpenState(v); try { localStorage.setItem(OPEN, v ? '1' : '0') } catch { /* */ } }
  // a new run opens Mission control automatically
  const seen = useRef(activeRunId)
  useEffect(() => { if (activeRunId && activeRunId !== seen.current && runs[activeRunId]?.status === 'running') setOpenState(true); seen.current = activeRunId }, [activeRunId, runs])
  if (!open) return (
    <motion.button layout onClick={() => setOpen(true)} title="Open Mission control (live trace & X-ray)"
      className="glass spot-border relative z-10 m-3 ml-0 hidden w-[52px] shrink-0 flex-col items-center gap-3 rounded-[22px] border border-white/80 py-4 text-mute shadow-soft transition hover:text-ink xl:flex">
      <PanelRightOpen size={17} />
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.22em] [writing-mode:vertical-rl]">Mission control</span>
      {run?.status === 'running' && <StatusDot tone="warn" pulse />}
    </motion.button>
  )
  return (
    <motion.aside layout transition={{ type: 'spring', stiffness: 260, damping: 32 }}
      className={cx('glass spot spot-border relative z-10 m-3 ml-0 hidden shrink-0 flex-col rounded-[26px] border border-line p-6 shadow-soft xl:flex',
        xray ? 'w-[min(560px,42vw)] 2xl:w-[600px]' : 'w-[340px] 2xl:w-[380px]')}>
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button onClick={() => setOpen(false)} title="Collapse" className="rounded-lg p-1 text-mute transition hover:bg-ink/5 hover:text-ink"><PanelRightClose size={15} /></button>
          <Eyebrow>Mission control · {xray ? 'X-ray' : 'Steps'}</Eyebrow>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-mute"><StatusDot tone={socket === 'open' ? 'ok' : 'warn'} />{socket === 'open' ? 'Live' : 'Reconnecting'}</span>
          <div className="flex rounded-full border border-line bg-white/60 p-0.5 text-[11px]">
            {[{ v: false, l: 'Steps' }, { v: true, l: 'X-ray' }].map((o) => (
              <button key={o.l} onClick={() => toggle(o.v)}
                className={cx('relative flex items-center gap-1 rounded-full px-2.5 py-1 transition-colors', xray === o.v ? 'text-white' : 'text-mute hover:text-ink')}>
                {xray === o.v && <motion.span layoutId="trace-mode" className="absolute inset-0 rounded-full bg-ink" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
                <span className="relative flex items-center gap-1">{o.v && <ScanEye size={11} />}{o.l}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {run ? <RunView run={run} xray={xray} /> : (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mb-5 flex flex-col items-center gap-1.5">
            {[0, 1, 2, 3].map((i) => <span key={i} className="h-1.5 w-1.5 rounded-full bg-faint animate-breathe" style={{ animationDelay: `${i * 0.4}s` }} />)}
          </div>
          <p className="font-serif text-[22px] leading-tight text-ink">Nothing running</p>
          <p className="mt-2 max-w-[260px] text-[12.5px] leading-relaxed text-mute">
            {xray ? 'Ask about your documents and watch your question become a vector, find its nearest passages, and turn into a prompt for Gemma.'
              : 'Every step I take will appear here as it happens, with real timings.'}
          </p>
        </div>
      )}
    </motion.aside>
  )
}
