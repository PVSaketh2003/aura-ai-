import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Binary, Check, Database, FileUp, Scissors, ScanLine, ScanText, Sparkles, type LucideIcon } from 'lucide-react'
import type { LiveRun } from '../context/AgentContext'
import { useNow } from '../hooks/useHealth'
import type { ExecutionStep } from '../types'
import { bytes, cx, ms } from '../utils/format'

/** Live document-processing journey. Every number shown comes from a backend event or a persisted step:
 *  - upload %        → browser upload progress (bytes actually sent)
 *  - pages           → ingest.progress{stage:"extract"} (pages actually read by the loader)
 *  - OCR             → only shown when the backend ran an "ocr" step
 *  - chunks          → the chunking step's real counts, strategy, size/overlap and per-chunk lengths
 *  - embeddings      → ingest.progress{stage:"embedding"} per batch; model + dims from the step
 *  - vector storage  → ingest.progress{stage:"vector_store"} per batch; stored count verified against ChromaDB
 *  If a stage has no progress information, only its real status is shown — never an invented percentage. */

export interface UploadState { name: string; size: number; loaded: number; total: number; done: boolean; error?: string }
type SState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
interface StageDef { id: string; title: string; icon: LucideIcon; keys: string[]; desc: string; tint: string }

const STAGES: StageDef[] = [
  { id: 'upload', title: 'Upload', icon: FileUp, keys: ['transfer', 'dedupe'], desc: 'The PDF enters Aura; duplicates are caught by content hash', tint: '#ff7a4d' },
  { id: 'extract', title: 'Loading & extraction', icon: ScanText, keys: ['inspect', 'loader', 'extract', 'directory_loader'], desc: 'Pages inspected, the best loader chosen, text read page by page', tint: '#f59e0b' },
  { id: 'ocr', title: 'OCR', icon: ScanLine, keys: ['ocr'], desc: 'Scanned pages recognised with Tesseract', tint: '#e2612f' },
  { id: 'chunking', title: 'Chunking', icon: Scissors, keys: ['chunking'], desc: 'The text is split into overlapping, page-aware chunks', tint: '#c45cff' },
  { id: 'embedding', title: 'Embeddings', icon: Binary, keys: ['embedding'], desc: 'Each chunk becomes a vector', tint: '#7c4dff' },
  { id: 'vector_store', title: 'Vector storage', icon: Database, keys: ['vector_store', 'metadata'], desc: 'Vectors written to ChromaDB and verified; metadata to PostgreSQL', tint: '#4f7dff' },
]

export const isIngestRun = (run?: LiveRun | null) => !!run?.steps.some((s) => ['dedupe', 'inspect', 'chunking', 'directory_loader', 'transfer'].includes(s.key))

function stageState(steps: ExecutionStep[], run: LiveRun): SState {
  if (!steps.length) return run.status === 'running' ? 'pending' : run.status === 'failed' ? 'pending' : 'skipped'
  if (steps.some((s) => s.status === 'failed')) return 'failed'
  if (steps.some((s) => s.status === 'running')) return 'running'
  return 'completed'
}

const detail = (steps: ExecutionStep[], key: string) => (steps.find((s) => s.key === key)?.detail ?? {}) as Record<string, any>

function Bar({ value, tint }: { value: number | null; tint: string }) {
  return (
    <div className="relative h-1.5 overflow-hidden rounded-full bg-ink/[.06]">
      {value == null
        ? <span className="xr-scan absolute inset-y-0 w-1/3 rounded-full" style={{ background: `linear-gradient(90deg,transparent,${tint},transparent)` }} />
        : <motion.span className="absolute inset-y-0 left-0 rounded-full" style={{ background: `linear-gradient(90deg,${tint},#a77bff)` }}
            animate={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} transition={{ type: 'spring', stiffness: 120, damping: 22 }} />}
    </div>
  )
}

/* ------------------------------------------------------------------------------------------ stage visuals */
function PagesScan({ done, total, running }: { done: number; total: number; running: boolean }) {
  const n = Math.min(8, Math.max(3, total || 3))
  return (
    <div className="flex items-end gap-1.5">
      {Array.from({ length: n }).map((_, i) => {
        const lit = total ? i < Math.round((done / total) * n) : !running
        return (
          <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
            className={cx('relative h-11 w-8 overflow-hidden rounded-[5px] border bg-white', lit ? 'border-amber-300' : 'border-line')}>
            {[0, 1, 2, 3, 4].map((l) => <span key={l} className={cx('absolute left-1.5 h-[2px] rounded-full transition-colors duration-500', lit ? 'bg-amber-400/70' : 'bg-ink/10')}
              style={{ top: 7 + l * 7, width: l === 4 ? 10 : 18 }} />)}
            {running && i === Math.min(n - 1, Math.round((done / Math.max(1, total)) * n)) && <span className="page-scan absolute inset-x-0 h-3 bg-gradient-to-b from-transparent via-amber-300/70 to-transparent" />}
          </motion.div>
        )
      })}
    </div>
  )
}

/** One long text bar that splits into the real chunks (widths = real chunk lengths). */
function ChunkSplit({ lengths, total, running }: { lengths: number[]; total: number; running: boolean }) {
  if (!lengths.length) return running ? <div className="h-6 rounded-md bg-gradient-to-r from-violet/20 via-violet/40 to-violet/20 animate-pulse" /> : null
  const sum = lengths.reduce((a, b) => a + b, 0)
  return (
    <div>
      <div className="flex h-6 items-stretch gap-[3px]">
        {lengths.map((l, i) => (
          <motion.span key={i} initial={{ scaleX: 0, opacity: 0 }} animate={{ scaleX: 1, opacity: 1 }} transition={{ delay: 0.15 + i * 0.025, type: 'spring', stiffness: 260, damping: 20 }}
            title={`chunk ${i + 1}: ${l.toLocaleString()} chars`} className="origin-left rounded-[3px]"
            style={{ flexGrow: l / sum, background: `hsl(${270 - (i / lengths.length) * 60} 80% ${70 - (i % 2) * 8}%)` }} />
        ))}
      </div>
      {total > lengths.length && <div className="mt-1 text-right text-[10.5px] text-mute">first {lengths.length} of {total.toLocaleString()} chunks shown</div>}
    </div>
  )
}

/** Chunks becoming vector nodes: a node lights up per embedded chunk (scaled to ≤ 60 nodes). */
function VectorNodes({ done, total, dim }: { done: number; total: number; dim?: number }) {
  const N = Math.min(60, Math.max(12, total))
  const lit = total ? Math.round((done / total) * N) : 0
  return (
    <div className="flex items-center gap-3">
      <div className="grid flex-1 grid-cols-[repeat(20,minmax(0,1fr))] gap-[3px]">
        {Array.from({ length: N }).map((_, i) => (
          <motion.span key={i} animate={{ scale: i < lit ? 1 : 0.55, opacity: i < lit ? 1 : 0.25 }} transition={{ type: 'spring', stiffness: 300, damping: 18 }}
            className="aspect-square rounded-full" style={{ background: i < lit ? `hsl(${255 + (i % 7) * 6} 85% 62%)` : 'rgb(12 12 16 / .2)' }} />
        ))}
      </div>
      {dim && <span className="shrink-0 rounded-lg bg-violet/10 px-2 py-1 font-mono text-[10.5px] text-violet">{dim}-d</span>}
    </div>
  )
}

function DbFill({ done, total }: { done: number; total: number }) {
  const f = total ? done / total : 0
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-12 w-10">
        <svg viewBox="0 0 40 48" className="absolute inset-0 h-full w-full">
          <defs><clipPath id="db"><path d="M2 8 v32 a18 6 0 0 0 36 0 v-32 a18 6 0 0 0 -36 0z" /></clipPath></defs>
          <g clipPath="url(#db)"><rect x="0" y="0" width="40" height="48" fill="#eef2ff" />
            <motion.rect x="0" width="40" fill="#4f7dff" opacity=".55" initial={{ y: 48, height: 0 }} animate={{ y: 48 - 48 * f, height: 48 * f }} transition={{ type: 'spring', stiffness: 90, damping: 20 }} /></g>
          <path d="M2 8 v32 a18 6 0 0 0 36 0 v-32" fill="none" stroke="#4f7dff" strokeWidth="1.5" />
          <ellipse cx="20" cy="8" rx="18" ry="6" fill="#fff" stroke="#4f7dff" strokeWidth="1.5" />
        </svg>
      </div>
      <div className="flex flex-1 gap-1 overflow-hidden">
        {Array.from({ length: 10 }).map((_, i) => <span key={i} className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky" style={{ animation: f < 1 ? `xr-flow 1.2s ${i * 0.12}s linear infinite` : undefined, opacity: f >= 1 ? 0.25 : 1 }} />)}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------------------------------ journey */
export function ProcessingJourney({ run, upload, compact = false }: { run?: LiveRun | null; upload?: UploadState | null; compact?: boolean }) {
  const running = run?.status === 'running'
  const now = useNow(!!running || !!(upload && !upload.done))
  const steps = run?.steps ?? []
  const prog = run?.progress ?? {}
  const filename = upload?.name ?? (detail(steps, 'dedupe').filename as string) ?? run?.input
  const failed = run?.status === 'failed'
  const doneAll = run?.status === 'completed'

  const rows = STAGES.map((st) => {
    const mine = steps.filter((s) => st.keys.includes(s.key))
    let state: SState = run ? stageState(mine, run) : 'pending'
    if (st.id === 'upload' && upload && !run) state = upload.error ? 'failed' : upload.done ? 'completed' : 'running'
    if (st.id === 'ocr' && !mine.length) return null // OCR appears only when the backend actually ran it
    if (doneAll && state === 'pending') state = 'skipped'
    const start = mine[0]?.started_at ? new Date(mine[0].started_at).getTime() : null
    const end = mine.length && mine.every((s) => s.finished_at) ? Math.max(...mine.map((s) => new Date(s.finished_at!).getTime())) : null
    const dur = mine.reduce((a, s) => a + (s.status === 'running' ? Math.max(0, now - new Date(s.started_at).getTime()) : s.duration_ms ?? 0), 0)
    return { st, mine, state, start, end, dur }
  }).filter(Boolean) as { st: StageDef; mine: ExecutionStep[]; state: SState; start: number | null; end: number | null; dur: number }[]

  const ex = detail(steps, 'extract'), ins = detail(steps, 'inspect'), ch = detail(steps, 'chunking'), em = detail(steps, 'embedding'), vs = detail(steps, 'vector_store')
  const total = running ? now - (run?.startedAt ?? now) : run?.durationMs ?? 0

  return (
    <div className={cx('rounded-[22px] border border-white/80 bg-white/70 shadow-soft backdrop-blur', compact ? 'p-3.5' : 'p-5')}>
      {/* header: the document card */}
      <div className="flex items-center gap-3">
        <motion.div initial={{ x: -24, rotate: -8, opacity: 0 }} animate={{ x: 0, rotate: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 160, damping: 16 }}
          className="relative grid h-12 w-10 shrink-0 place-items-center rounded-lg border border-line bg-white shadow-soft">
          <span className="font-mono text-[9px] font-bold text-coral">PDF</span>
          <span className="absolute right-0 top-0 h-3 w-3 rounded-bl-md border-b border-l border-line bg-paper" />
        </motion.div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-ink" title={filename}>{filename || 'Document'}</div>
          <div className="text-[11.5px] text-mute">
            {upload ? bytes(upload.size) : ''}{ins.pages ? `${upload ? ' · ' : ''}${ins.pages} pages` : ''}
            {run && <> · {failed ? <span className="text-rose">failed</span> : doneAll ? <span className="text-mint">ready for semantic search</span> : 'processing'} · {ms(total)}</>}
          </div>
        </div>
        {doneAll && <motion.span initial={{ scale: 0 }} animate={{ scale: [0, 1.25, 1] }} className="grid h-9 w-9 place-items-center rounded-full bg-mint text-white shadow-[0_10px_24px_-8px_#2fbf8f]"><Check size={18} strokeWidth={3} /></motion.span>}
        {failed && <span className="grid h-9 w-9 place-items-center rounded-full bg-rose/15 text-rose"><AlertTriangle size={17} /></span>}
      </div>

      {/* stages */}
      <ol className="mt-4 space-y-2.5">
        {rows.map(({ st, mine, state, dur }) => {
          const Icon = st.icon
          const p = prog[st.id === 'extract' ? 'extract' : st.id === 'vector_store' ? 'vector_store' : st.id]
          let frac: number | null = null
          let stat = ''
          let visual: React.ReactNode = null
          if (st.id === 'upload') {
            const dd = detail(steps, 'dedupe')
            if (upload) { frac = upload.total ? upload.loaded / upload.total : null; stat = `${bytes(upload.loaded)} / ${bytes(upload.total)}${upload.done ? ' · upload complete' : ''}` }
            if (dd.document_id && mine.find((s) => s.key === 'dedupe')?.summary?.startsWith('Already')) stat = 'Duplicate — already in your library (skipped)'
          } else if (st.id === 'extract') {
            const done = p?.done ?? (state === 'completed' ? ex.pages ?? ins.pages : 0)
            const tot = p?.total ?? ins.pages ?? 0
            frac = tot ? done / tot : null
            stat = [tot ? `${done}/${tot} pages` : '', ex.chars ? `${ex.chars.toLocaleString()} chars` : p?.chars ? `${p.chars.toLocaleString()} chars` : '', ex.loader || ''].filter(Boolean).join(' · ')
            visual = <PagesScan done={done} total={tot} running={state === 'running'} />
          } else if (st.id === 'ocr') {
            const o = detail(steps, 'ocr'); frac = p?.total ? p.done / p.total : state === 'completed' ? 1 : null
            stat = p ? `${p.done}/${p.total} scanned pages` : o.pages ? `${o.recovered}/${o.pages} pages recovered · ${o.engine}` : ''
          } else if (st.id === 'chunking') {
            stat = ch.chunks ? `${ch.chunks.toLocaleString()} chunks · ${ch.strategy}${ch.chunk_size ? ` · size ${ch.chunk_size}, overlap ${ch.chunk_overlap}` : ''} · avg ${ch.avg_chars} chars` : ''
            frac = state === 'completed' ? 1 : null
            visual = (state !== 'pending') && <ChunkSplit lengths={ch.lengths ?? []} total={ch.chunks ?? 0} running={state === 'running'} />
          } else if (st.id === 'embedding') {
            const tot = p?.total ?? em.embedded ?? ch.chunks ?? 0
            const done = p?.done ?? (state === 'completed' ? em.embedded : 0)
            frac = tot ? done / tot : null
            stat = [tot ? `${done ?? 0}/${tot} embedded` : '', em.failed ? `${em.failed} failed` : '', em.model || '', em.dim ? `${em.dim} dims` : ''].filter(Boolean).join(' · ')
            visual = state !== 'pending' && <VectorNodes done={done ?? 0} total={tot} dim={em.dim} />
          } else if (st.id === 'vector_store') {
            const tot = p?.total ?? vs.expected ?? 0
            const done = p?.done ?? (state === 'completed' ? vs.stored : 0)
            frac = tot ? done / tot : null
            stat = [tot ? `${done ?? 0}/${tot} vectors` : '', vs.collection ? `collection “${vs.collection}”` : '', vs.stored != null ? 'verified' : ''].filter(Boolean).join(' · ')
            visual = state !== 'pending' && <DbFill done={done ?? 0} total={tot} />
          }
          const err = mine.find((s) => s.error)?.error
          return (
            <motion.li key={st.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className={cx('rounded-2xl border p-3 transition-colors', state === 'running' ? 'border-white bg-white shadow-float' : state === 'failed' ? 'border-rose/30 bg-rose/[.04]' : 'border-transparent bg-ink/[.025]')}>
              <div className="flex items-center gap-2.5">
                <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full" style={{ background: state === 'completed' ? st.tint : `${st.tint}1f`, color: state === 'completed' ? '#fff' : st.tint }}>
                  {state === 'running' && <span className="absolute inset-0 animate-ping rounded-full opacity-25" style={{ background: st.tint }} />}
                  {state === 'completed' ? <Check size={13} strokeWidth={3} /> : state === 'failed' ? <AlertTriangle size={13} /> : <Icon size={13} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={cx('text-[13px] font-medium', state === 'pending' || state === 'skipped' ? 'text-mute' : 'text-ink')}>{st.title}</span>
                    <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-mute">
                      {state === 'skipped' ? 'skipped' : state === 'pending' ? 'pending' : state === 'failed' ? 'failed' : dur ? ms(dur) : state}
                    </span>
                  </div>
                  {!compact && state !== 'pending' && <div className="text-[11.5px] text-mute">{stat || st.desc}</div>}
                </div>
              </div>
              <AnimatePresence>
                {(state === 'running' || (state === 'completed' && !compact)) && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden pl-[38px]">
                    {visual && <div className="mt-2.5">{visual}</div>}
                    {state === 'running' && <div className="mt-2.5"><Bar value={frac} tint={st.tint} /></div>}
                  </motion.div>
                )}
              </AnimatePresence>
              {err && <p className="mt-2 rounded-lg bg-rose/10 px-2.5 py-1.5 pl-[38px] font-mono text-[11px] text-rose">{err}</p>}
            </motion.li>
          )
        })}
      </ol>

      {/* summary */}
      {doneAll && ch.chunks && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[['Pages', ins.pages ?? ex.pages], ['Characters', ex.chars?.toLocaleString()], ['Chunks', ch.chunks?.toLocaleString()],
            ['Embedding', em.model ? `${em.model} · ${em.dim}-d` : '—'], ['Collection', vs.collection ?? '—'], ['Strategy', ch.strategy],
            ['Duration', ms(run?.durationMs)], ['Status', 'Indexed']].map(([k, v]) => (
            <div key={k as string} className="rounded-xl bg-ink/[.03] px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mute">{k}</div>
              <div className="mt-0.5 truncate text-[12.5px] font-medium text-ink" title={String(v ?? '')}>{v ?? '—'}</div>
            </div>
          ))}
        </motion.div>
      )}
      {running && <p className="mt-3 flex items-center gap-1.5 text-[11px] text-mute"><Sparkles size={11} className="text-violet" />Live from the backend — percentages appear only where real progress is reported.</p>}
    </div>
  )
}
