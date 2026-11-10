/* X-ray: live visualisations of what the agent is doing, rendered from real step details streamed by the backend.
   Nothing here is simulated — every number, vector and passage comes from the persisted ExecutionStep.detail. */
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, FileText } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { LiveRun } from '../context/AgentContext'
import type { ExecutionStep } from '../types'
import { cx, ms } from '../utils/format'

const ease = [0.16, 1, 0.3, 1] as const

export interface Cand { id: string; file: string; page: number | null; page_end?: number | null; similarity: number | null; snippet: string; angle?: number }

const pages = (c: { page: number | null; page_end?: number | null }) =>
  c.page == null ? '' : c.page_end && c.page_end !== c.page ? `p. ${c.page}–${c.page_end}` : `p. ${c.page}`

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-[11px] leading-relaxed text-faint">{children}</p>
}

function Frame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }}
      className={cx('mt-3 overflow-hidden rounded-2xl border border-line bg-white/70 p-3.5 shadow-[0_1px_0_rgb(255_255_255/.8)_inset]', className)}>
      {children}
    </motion.div>
  )
}

/* ---------------------------------------------------------------------------------------------- embedding */
export function VectorBarcode({ preview, dim, cached }: { preview: number[]; dim: number; cached?: boolean }) {
  return (
    <Frame>
      <div className="flex h-[54px] items-center gap-[2px]">
        {preview.map((v, i) => (
          <motion.span key={i} initial={{ scaleY: 0, opacity: 0 }} animate={{ scaleY: 1, opacity: 1 }}
            transition={{ delay: i * 0.006, duration: 0.5, ease }}
            className="w-full min-w-[1.5px] rounded-full"
            style={{
              height: `${Math.max(6, Math.abs(v) * 100)}%`,
              background: v >= 0 ? `rgb(167 123 255 / ${0.35 + Math.abs(v) * 0.65})` : `rgb(255 138 91 / ${0.35 + Math.abs(v) * 0.65})`,
            }} />
        ))}
      </div>
      <Caption>
        Your question as {dim.toLocaleString()} numbers{cached ? ' (reused from cache)' : ''} — shown here averaged into {preview.length} bands.
        <span className="ml-1 inline-flex items-center gap-1"><i className="inline-block h-1.5 w-1.5 rounded-full bg-violet" />positive</span>
        <span className="ml-2 inline-flex items-center gap-1"><i className="inline-block h-1.5 w-1.5 rounded-full bg-coral" />negative</span>
      </Caption>
    </Frame>
  )
}

/* -------------------------------------------------------------------------------------------- vector map */
export function VectorMap({ cands, selected, threshold, strong }: { cands: Cand[]; selected: string[]; threshold: number; strong: number }) {
  const [hover, setHover] = useState<Cand | null>(null)
  const S = 300, C = S / 2, R = C - 18
  const sims = cands.map((c) => c.similarity ?? 0)
  const floor = Math.min(threshold - 0.1, Math.min(...sims) - 0.04)
  const rOf = (sim: number) => R * Math.min(1, Math.max(0.06, (1 - sim) / (1 - floor)))
  const sel = new Set(selected)
  const pts = cands.map((c, i) => {
    const r = rOf(c.similarity ?? floor), a = c.angle ?? (i / cands.length) * Math.PI * 2
    return { c, i, x: C + r * Math.cos(a), y: C + r * Math.sin(a), on: sel.has(c.id) }
  })
  return (
    <Frame className="relative">
      <svg viewBox={`0 0 ${S} ${S}`} className="mx-auto block w-full max-w-[340px]">
        <defs>
          <radialGradient id="xr-q" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fff" /><stop offset="35%" stopColor="#a77bff" /><stop offset="100%" stopColor="#ff8a5b" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="xr-sel" x1="0" x2="1"><stop offset="0%" stopColor="#ff8a5b" /><stop offset="100%" stopColor="#a77bff" /></linearGradient>
          <radialGradient id="xr-zone" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#a77bff" stopOpacity=".10" /><stop offset="100%" stopColor="#a77bff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx={C} cy={C} r={rOf(threshold)} fill="url(#xr-zone)" />
        {[{ v: strong, label: `strong ${strong.toFixed(2)}` }, { v: threshold, label: `threshold ${threshold.toFixed(2)}` }].map((g) => (
          <g key={g.label}>
            <motion.circle cx={C} cy={C} r={rOf(g.v)} fill="none" stroke="#0c0c10" strokeOpacity=".14" strokeDasharray="2 4"
              initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2, ease }} />
            <text x={C} y={C - rOf(g.v) - 4} textAnchor="middle" className="fill-mute font-mono text-[8px]">{g.label}</text>
          </g>
        ))}
        {pts.filter((p) => p.on).map((p, k) => (
          <motion.line key={`l-${p.c.id}`} x1={C} y1={C} x2={p.x} y2={p.y} stroke="url(#xr-sel)" strokeWidth={1.2} strokeLinecap="round"
            initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 0.9 }} transition={{ delay: 0.9 + k * 0.12, duration: 0.6, ease }} />
        ))}
        {pts.map((p) => (
          <motion.circle key={p.c.id} cx={p.x} cy={p.y} r={p.on ? 5 : 3.2}
            fill={p.on ? 'url(#xr-sel)' : (p.c.similarity ?? 0) >= threshold ? '#8a8a96' : '#c9c9d1'}
            stroke="#fff" strokeWidth={p.on ? 1.5 : 1}
            initial={{ opacity: 0, cx: C + (p.x - C) * 1.6, cy: C + (p.y - C) * 1.6 }} animate={{ opacity: 1, cx: p.x, cy: p.y }}
            transition={{ delay: 0.15 + p.i * 0.03, duration: 0.7, ease }}
            onMouseEnter={() => setHover(p.c)} onMouseLeave={() => setHover(null)} className="cursor-pointer" />
        ))}
        <circle cx={C} cy={C} r={16} fill="url(#xr-q)"><animate attributeName="r" values="13;17;13" dur="2.6s" repeatCount="indefinite" /></circle>
        <circle cx={C} cy={C} r={3.5} fill="#0c0c10" />
      </svg>
      <AnimatePresence>
        {hover && (
          <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-x-3 bottom-3 rounded-xl border border-line bg-white/95 p-2.5 text-[11px] leading-relaxed shadow-float">
            <div className="mb-1 flex justify-between font-mono text-[10px] text-mute"><span>{pages(hover)}</span><span>cos {hover.similarity?.toFixed(3)}</span></div>
            <p className="line-clamp-3 text-ink-2">{hover.snippet}</p>
          </motion.div>
        )}
      </AnimatePresence>
      <Caption>
        Centre is your question. Distance from it is the real cosine similarity; direction groups similar chunks together.
        <span className="ml-1 inline-flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-gradient-to-r from-coral to-violet" />chosen for the prompt</span>
      </Caption>
    </Frame>
  )
}

/* --------------------------------------------------------------------------------------------- ranked list */
export function RankList({ cands, selected, threshold, limit = 8 }: { cands: Cand[]; selected: string[]; threshold: number; limit?: number }) {
  const [all, setAll] = useState(false)
  const idx = new Map(selected.map((id, i) => [id, i]))
  const shown = all ? cands : cands.slice(0, limit)
  const max = Math.max(...cands.map((c) => c.similarity ?? 0), threshold + 0.1)
  return (
    <Frame className="p-0">
      <ul className="divide-y divide-line">
        {shown.map((c, i) => {
          const pick = idx.get(c.id)
          const sim = c.similarity ?? 0
          return (
            <motion.li key={c.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04, duration: 0.4, ease }}
              className={cx('group px-3.5 py-2.5', pick != null && 'bg-gradient-to-r from-violet/[.05] to-transparent')}>
              <div className="flex items-center gap-2.5">
                <span className="w-4 shrink-0 text-right font-mono text-[10px] text-faint">{i + 1}</span>
                <span className={cx('grid h-[18px] min-w-[26px] place-items-center rounded-md px-1 font-mono text-[9.5px] font-semibold',
                  pick != null ? 'bg-ink text-white' : 'text-faint')}>{pick != null ? `D${pick + 1}` : '—'}</span>
                <span className="w-[54px] shrink-0 font-mono text-[10.5px] text-ink-2">{pages(c)}</span>
                <div className="relative h-[5px] flex-1 overflow-hidden rounded-full bg-ink/[.05]">
                  <motion.div initial={{ width: 0 }} animate={{ width: `${(sim / max) * 100}%` }} transition={{ delay: 0.1 + i * 0.04, duration: 0.7, ease }}
                    className={cx('h-full rounded-full', sim >= threshold ? 'bg-gradient-to-r from-coral to-violet' : 'bg-faint')} />
                  <span className="absolute top-[-2px] h-[9px] w-px bg-ink/40" style={{ left: `${(threshold / max) * 100}%` }} />
                </div>
                <span className={cx('w-[38px] shrink-0 text-right font-mono text-[10.5px] tabular-nums', sim >= threshold ? 'text-ink' : 'text-faint')}>{sim.toFixed(3)}</span>
              </div>
              <p className="ml-[62px] mt-1 line-clamp-1 text-[11px] text-mute group-hover:line-clamp-3">{c.snippet}</p>
            </motion.li>
          )
        })}
      </ul>
      {cands.length > limit && (
        <button onClick={() => setAll(!all)} className="flex w-full items-center justify-center gap-1 border-t border-line py-2 text-[11px] text-mute transition hover:text-ink">
          {all ? 'Show fewer' : `Show all ${cands.length}`}<ChevronDown size={12} className={cx('transition', all && 'rotate-180')} />
        </button>
      )}
    </Frame>
  )
}

/* ------------------------------------------------------------------------------------------- relevance gate */
export function Gate({ top, threshold, strong, decision, verdict, ok }: { top: number | null; threshold: number; strong: number; decision?: string; verdict?: string; ok: boolean }) {
  const pos = (v: number) => `${Math.min(100, Math.max(0, ((v - 0.2) / 0.6) * 100))}%`
  const pass = ok
  return (
    <Frame>
      <div className="relative h-8">
        <div className="absolute inset-x-0 top-3 h-2 overflow-hidden rounded-full bg-ink/[.05]">
          <div className="absolute inset-y-0 bg-ink/[.06]" style={{ left: pos(threshold), right: `calc(100% - ${pos(strong)})` }} />
          <div className="absolute inset-y-0 right-0 bg-mint/15" style={{ left: pos(strong) }} />
        </div>
        {[{ v: threshold, l: 'threshold' }, { v: strong, l: 'strong' }].map((m) => (
          <span key={m.l} className="absolute top-1.5 h-5 w-px bg-ink/30" style={{ left: pos(m.v) }}>
            <span className="absolute left-1/2 top-[22px] -translate-x-1/2 whitespace-nowrap font-mono text-[9px] text-mute">{m.l} {m.v.toFixed(2)}</span>
          </span>
        ))}
        {top != null && (
          <motion.span initial={{ left: '0%' }} animate={{ left: pos(top) }} transition={{ duration: 0.9, ease }}
            className="absolute top-[7px] -ml-[7px] h-[14px] w-[14px] rounded-full border-2 border-white bg-gradient-to-br from-coral to-violet shadow-soft" />
        )}
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2 text-[11.5px]">
        <span className={cx('rounded-full px-2 py-0.5 font-medium', decision === 'below' ? 'bg-rose/10 text-rose' : pass ? 'bg-mint/15 text-[#178a64]' : 'bg-coral/15 text-[#c4562a]')}>
          {decision === 'below' ? 'Not relevant enough' : pass ? 'Passed' : 'Rejected'}
        </span>
        <span className="text-mute">
          {decision === 'strong' && 'Strong match — accepted without an extra LLM check (saves ~10 s).'}
          {decision === 'judge' && `Borderline match — the LLM judged: ${verdict?.replace(/_/g, ' ')}.`}
          {decision === 'below' && 'Falls back to Wikipedia / the web, or says it couldn’t find it.'}
        </span>
      </div>
    </Frame>
  )
}

/* ------------------------------------------------------------------------------------------------- prompt */
interface PromptDetail {
  messages: { role: string; content: string; chars: number }[]
  sources: { id: string; kind: string; title: string; page: number | null; page_end?: number | null; similarity: number | null; chars: number }[]
  chars: number; est_tokens: number
}

export function PromptView({ d }: { d: PromptDetail }) {
  const [open, setOpen] = useState(false)
  const sys = d.messages.find((m) => m.role === 'system')
  const hist = d.messages.filter((m) => m.role !== 'system').length - 1
  const q = d.messages[d.messages.length - 1]?.content.split('Question: ').pop() ?? ''
  const total = Math.max(1, d.chars)
  const srcChars = d.sources.reduce((a, s) => a + s.chars, 0)
  const parts = [
    { label: 'Instructions', n: sys?.chars ?? 0, c: 'bg-ink/70' },
    { label: 'History', n: Math.max(0, total - (sys?.chars ?? 0) - srcChars - q.length - 40), c: 'bg-sky/70' },
    { label: 'Sources', n: srcChars, c: 'bg-gradient-to-r from-coral to-violet' },
    { label: 'Question', n: q.length, c: 'bg-mint' },
  ].filter((p) => p.n > 0)
  return (
    <Frame>
      <div className="flex h-2 overflow-hidden rounded-full bg-ink/[.05]">
        {parts.map((p, i) => (
          <motion.span key={p.label} initial={{ width: 0 }} animate={{ width: `${(p.n / total) * 100}%` }} transition={{ delay: i * 0.12, duration: 0.6, ease }} className={cx('h-full', p.c)} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-mute">
        {parts.map((p) => <span key={p.label} className="flex items-center gap-1"><i className={cx('inline-block h-1.5 w-1.5 rounded-full', p.c)} />{p.label} {Math.round((p.n / total) * 100)}%</span>)}
      </div>
      {d.sources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {d.sources.map((s, i) => (
            <motion.span key={s.id} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.3 + i * 0.06 }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-2 py-1 text-[10.5px] text-ink-2">
              <b className="font-mono text-[9.5px] text-ink">{s.id}</b>
              {s.kind === 'document' ? <FileText size={10} className="text-mute" /> : <span className="text-mute">{s.kind}</span>}
              {pages(s) || s.title.slice(0, 22)}
              {s.similarity != null && <span className="font-mono text-[9.5px] text-faint">{s.similarity.toFixed(2)}</span>}
            </motion.span>
          ))}
        </div>
      )}
      {hist > 0 && <p className="mt-2 text-[11px] text-mute">+ {hist} earlier message{hist > 1 ? 's' : ''} for context</p>}
      <p className="mt-3 rounded-xl bg-mint/[.07] px-3 py-2 text-[12px] leading-relaxed text-ink-2"><span className="mr-1.5 font-mono text-[9.5px] uppercase tracking-wider text-[#178a64]">question</span>{q}</p>
      <button onClick={() => setOpen(!open)} className="mt-2.5 flex items-center gap-1 text-[11px] text-mute transition hover:text-ink">
        <ChevronDown size={12} className={cx('transition', open && 'rotate-180')} />{open ? 'Hide' : 'Read'} the exact prompt sent to the model
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="scroll-quiet mt-2 max-h-[340px] space-y-2 overflow-y-auto rounded-xl bg-[#101016] p-3 font-mono text-[10.5px] leading-relaxed text-white/80">
              {d.messages.map((m, i) => (
                <div key={i}>
                  <div className={cx('mb-1 text-[9px] uppercase tracking-[.18em]', m.role === 'system' ? 'text-violet' : m.role === 'user' ? 'text-coral' : 'text-sky')}>{m.role} · {m.chars.toLocaleString()} chars</div>
                  <pre className="whitespace-pre-wrap break-words">{m.content}</pre>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Frame>
  )
}

/* --------------------------------------------------------------------------------------------- generation */
export function Generation({ run, step }: { run: LiveRun; step: ExecutionStep }) {
  const live = step.status === 'running'
  const p = run.llm
  const d = step.detail as { completion_tokens?: number; tokens_per_sec?: number; prompt_tokens?: number; prompt_eval_ms?: number; first_token_ms?: number; load_ms?: number }
  const reading = live && (!p || p.phase === 'reading')
  const tokens = live ? p?.tokens ?? 0 : d.completion_tokens ?? 0
  const elapsed = p?.elapsed_ms && p.first_token_ms != null ? p.elapsed_ms - p.first_token_ms : 0
  const tps = live ? (elapsed > 500 ? (tokens / (elapsed / 1000)).toFixed(1) : '—') : d.tokens_per_sec?.toFixed(1) ?? '—'
  const ttft = live ? p?.first_token_ms : d.first_token_ms
  return (
    <Frame>
      <div className="grid grid-cols-3 gap-2">
        {[
          { k: 'Read prompt', v: reading ? `~${(p?.prompt_tokens ?? 0).toLocaleString()} tok` : d.prompt_tokens ? `${d.prompt_tokens.toLocaleString()} tok` : '—',
            s: reading ? 'reading…' : d.prompt_eval_ms ? ms(d.prompt_eval_ms) : ttft != null ? `first token ${ms(ttft)}` : '' },
          { k: 'Written', v: `${tokens} tok`, s: live && !reading ? 'writing…' : '' },
          { k: 'Speed', v: `${tps} tok/s`, s: d.load_ms ? `model load ${ms(d.load_ms)}` : '' },
        ].map((x) => (
          <div key={x.k} className="rounded-xl bg-paper px-2.5 py-2">
            <div className="text-[9.5px] uppercase tracking-[.14em] text-faint">{x.k}</div>
            <div className="mt-0.5 font-mono text-[12.5px] tabular-nums text-ink">{x.v}</div>
            <div className={cx('h-3.5 text-[10px] text-mute', x.s.endsWith('…') && 'text-shimmer')}>{x.s}</div>
          </div>
        ))}
      </div>
      {reading && (
        <div className="mt-3 flex items-center gap-2 text-[11.5px] text-mute">
          <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-ink/[.05]"><span className="xr-scan absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-violet to-transparent" /></span>
          Llama is reading the sources
        </div>
      )}
      {live && run.streamed && (
        <p className="scroll-quiet mt-3 max-h-[160px] overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">
          {run.streamed}<span className="ml-0.5 inline-block h-[13px] w-[6px] translate-y-[2px] animate-pulse rounded-sm bg-violet" />
        </p>
      )}
    </Frame>
  )
}

/* ------------------------------------------------------------------------------------------------ memories */
export function MemoryHits({ items }: { items: { similarity: number | null; match: string; category: string; snippet: string }[] }) {
  if (!items.length) return null
  return (
    <Frame className="space-y-2">
      {items.map((m, i) => (
        <div key={i} className="flex items-start gap-2.5 text-[11.5px]">
          <span className="mt-0.5 shrink-0 rounded-md bg-violet/10 px-1.5 py-0.5 font-mono text-[9.5px] text-violet">{m.similarity != null ? m.similarity.toFixed(2) : m.match}</span>
          <span className="text-ink-2">{m.snippet}<span className="ml-1.5 text-faint">· {m.category}</span></span>
        </div>
      ))}
    </Frame>
  )
}

export function Queries({ queries, added }: { queries: string[]; added: Cand[] }) {
  return (
    <Frame className="space-y-1.5">
      {queries.map((q, i) => (
        <motion.p key={i} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.1 }} className="flex gap-2 text-[11.5px] text-ink-2">
          <span className="font-mono text-[10px] text-faint">q{i + 1}</span>{q}
        </motion.p>
      ))}
      {added.length > 0 && <Caption>Found {added.length} more chunk{added.length > 1 ? 's' : ''}: {added.slice(0, 6).map(pages).join(', ')}</Caption>}
    </Frame>
  )
}

/* ----------------------------------------------------------------------------------- PDF-first decision map */
/** The branch the question actually took: PDF → (answered | partial → Wikipedia supplement | none → Wikipedia). */
function RouteMap({ d }: { d: Record<string, any> }) {
  const v = d.pdf_verdict as string
  const wiki = !!d.wikipedia_invoked
  const nodes = [
    { id: 'pdf', label: 'Your PDFs', sub: d.pdf_top_similarity != null ? `top ${Number(d.pdf_top_similarity).toFixed(2)} · ${Math.round((d.pdf_coverage ?? 0) * 100)}% terms` : v === 'no_documents' ? 'none indexed' : '', on: true, c: '#7c4dff' },
    { id: 'gate', label: v === 'answered' ? 'Sufficient' : v === 'partial' ? 'Partial' : 'Insufficient', sub: d.pdf_judge ? `judge: ${String(d.pdf_judge).replace('_', ' ')}` : 'similarity + coverage', on: true, c: v === 'answered' ? '#0e9f6e' : v === 'partial' ? '#d97706' : '#e5484d' },
    { id: 'wiki', label: 'Wikipedia', sub: wiki ? (d.wikipedia_purpose === 'supplement' ? 'fills the gap only' : `${(d.wikipedia_articles ?? []).length} article(s)`) : 'not called', on: wiki, c: '#2f6bff' },
    { id: 'ans', label: 'Answer', sub: d.final_source, on: true, c: '#c45cff' },
  ]
  return (
    <Frame>
      <div className="flex items-stretch gap-1.5">
        {nodes.map((n, i) => (
          <div key={n.id} className="flex flex-1 items-center gap-1.5">
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: n.on ? 1 : 0.35, y: 0 }} transition={{ delay: i * 0.12 }}
              className={cx('min-w-0 flex-1 rounded-xl border px-2 py-1.5', n.on ? 'bg-white' : 'border-dashed bg-transparent')} style={{ borderColor: n.on ? `${n.c}55` : undefined }}>
              <div className="truncate text-[11.5px] font-semibold" style={{ color: n.on ? n.c : undefined }}>{n.label}</div>
              <div className="truncate text-[10px] text-mute" title={n.sub}>{n.sub}</div>
            </motion.div>
            {i < nodes.length - 1 && <span className={cx('h-px w-3 shrink-0', nodes[i + 1].on ? 'bg-gradient-to-r from-violet to-sky' : 'border-t border-dashed border-faint')} />}
          </div>
        ))}
      </div>
      <div className="mt-2 font-mono text-[10.5px] tracking-wide text-ink-2">{d.route}</div>
      {d.pdf_missing && <Caption>Missing from the PDFs: {d.pdf_missing}</Caption>}
      {(d.wikipedia_sections ?? []).length > 0 && <Caption>Wikipedia sections: {(d.wikipedia_sections as string[]).join(' · ')}</Caption>}
      {d.retrieval_ms != null && <Caption>Retrieval took {ms(d.retrieval_ms)}{d.english_query ? ` · also searched as “${d.english_query}”` : ''}</Caption>}
    </Frame>
  )
}

/* ------------------------------------------------------------------------------------------ step dispatcher */
export function StepVisual({ step, run, steps }: { step: ExecutionStep; run: LiveRun; steps: ExecutionStep[] }) {
  const d = step.detail as Record<string, any>
  const mmrStep = useMemo(() => steps.find((s) => s.key === 'mmr'), [steps])
  const selected: string[] = (mmrStep?.detail as any)?.selected ?? []
  switch (step.key) {
    case 'asr': {
      const fused = Object.entries((d.debug?.fused ?? {}) as Record<string, number>)
      const cands = (d.debug?.candidates ?? {}) as Record<string, { text: string; logprob?: number; script?: number; confidence?: number | null; engine?: string }>
      if (!d.engine) return null
      return (
        <Frame>
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <span className="rounded-full bg-violet/12 px-2 py-0.5 font-medium text-violet">{d.selected_language && d.selected_language !== 'auto' ? `${d.language_name} · your choice (authoritative)` : `${d.language_name} · detected`}</span>
            <span className="rounded-full border border-line bg-white px-2 py-0.5 text-ink-2">{d.engine}</span>
            {d.asr_confidence != null && <span className="rounded-full border border-line bg-white px-2 py-0.5 text-ink-2">transcript {Math.round(d.asr_confidence * 100)}% sure</span>}
          </div>
          {fused.length > 1 && (
            <div className="mt-3 space-y-2">
              {fused.map(([k, v]) => (
                <div key={k} className="text-[11.5px]">
                  <div className="flex items-center gap-2">
                    <span className="w-8 font-mono text-ink-2">{k}</span>
                    <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-ink/[.06]">
                      <motion.span initial={{ width: 0 }} animate={{ width: `${Math.max(3, v * 100)}%` }} className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-coral to-violet" />
                    </span>
                    <span className="w-10 text-right font-mono tabular-nums text-mute">{Math.round(v * 100)}%</span>
                  </div>
                  {cands[k]?.text && <div className="ml-10 mt-0.5 truncate text-mute" title={cands[k].text}>“{cands[k].text}”{cands[k].engine === 'indic'
                    ? (cands[k].confidence != null ? ` · IndicConformer ${Math.round(cands[k].confidence! * 100)}% fit` : '')
                    : `${cands[k].logprob != null ? ` · log-prob ${cands[k].logprob}` : ''}${cands[k].script != null ? ` · script ${Math.round(cands[k].script! * 100)}%` : ''}`}</div>}
                </div>
              ))}
            </div>
          )}
          <Caption>{d.lid_model}{d.debug?.p_english != null ? ` · English ${Math.round(d.debug.p_english * 100)}%` : ''}{d.debug?.note ? ` · ${d.debug.note}` : ''}{d.debug?.vox ? ` · VoxLingua ${Object.entries(d.debug.vox as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}</Caption>
        </Frame>
      )
    }
    case 'retrieval_route': return <RouteMap d={d} />
    case 'translate_query':
      return d.query ? <Frame><div className="text-[12px] text-ink-2"><span className="text-mute">Asked: </span>{d.original}</div>
        <div className="mt-1 text-[12px] text-ink"><span className="text-mute">Also searched: </span>{d.query}</div>
        <Caption>Both are searched and merged; the answer is written for the original question.</Caption></Frame> : null
    case 'query_embedding':
      return d.preview ? <VectorBarcode preview={d.preview} dim={d.dim} cached={d.cached} /> : null
    case 'memory_retrieval':
      return d.memories?.length ? <MemoryHits items={d.memories} /> : null
    case 'similarity_search':
      if (!d.candidates?.length) return null
      return (
        <>
          <VectorMap cands={d.candidates} selected={selected} threshold={d.threshold} strong={d.strong} />
          <RankList cands={d.candidates} selected={selected} threshold={d.threshold} />
        </>
      )
    case 'multi_query':
      return d.queries ? <Queries queries={d.queries} added={d.added ?? []} /> : null
    case 'mmr':
      return d.chosen ? (
        <Frame>
          <div className="flex items-center gap-1">
            {Array.from({ length: d.pool }).map((_, i) => (
              <motion.span key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.015 }}
                className={cx('h-5 flex-1 rounded-[3px]', i < d.chosen.length ? 'bg-gradient-to-b from-coral to-violet' : 'bg-ink/[.06]')} />
            ))}
          </div>
          <Caption>
            Picked {d.chosen.length} of {d.pool} candidates, trading relevance against variety (λ = {d.lam}) so the prompt isn’t six copies of the same paragraph:
            {' '}{d.chosen.map((c: Cand, i: number) => `D${i + 1} ${pages(c)}`).join(' · ')}
          </Caption>
        </Frame>
      ) : null
    case 'retrieval_evaluation':
      return d.threshold != null ? <Gate top={d.top_similarity} threshold={d.threshold} strong={0.6} decision={d.decision} verdict={d.verdict} ok={step.summary.startsWith('Sufficient')} /> : null
    case 'prompt':
      return d.messages ? <PromptView d={d as PromptDetail} /> : null
    case 'llm_generation':
      return <Generation run={run} step={step} />
    default:
      return null
  }
}

/* ------------------------------------------------------------------------------------------- pipeline rail */
const STAGES: { label: string; keys: string[] }[] = [
  { label: 'Question', keys: ['input', 'asr', 'language', 'intent', 'calculator', 'context'] },
  { label: 'Embed', keys: ['query_embedding'] },
  { label: 'Memory', keys: ['memory_retrieval', 'conversation_search'] },
  { label: 'Search', keys: ['translate_query', 'similarity_search', 'multi_query', 'document_retrieval'] },
  { label: 'Select', keys: ['mmr'] },
  { label: 'Check', keys: ['retrieval_evaluation', 'retrieval_route', 'wikipedia', 'web_search'] },
  { label: 'Prompt', keys: ['prompt'] },
  { label: 'LLM', keys: ['llm_generation', 'language_fix', 'validation', 'response'] },
  { label: 'Voice', keys: ['tts'] },
]

export function PipelineRail({ steps, running }: { steps: ExecutionStep[]; running: boolean }) {
  const state = STAGES.map((st) => {
    const mine = steps.filter((s) => st.keys.includes(s.key))
    if (!mine.length) return 'idle'
    if (mine.some((s) => s.status === 'failed')) return 'failed'
    if (mine.some((s) => s.status === 'running')) return 'active'
    return 'done'
  })
  const used = STAGES.map((_, i) => state[i] !== 'idle')
  const last = state.lastIndexOf('done')
  return (
    <div className="relative mb-5 flex items-start">
      {STAGES.map((st, i) => (
        <div key={st.label} className="relative flex flex-1 flex-col items-center">
          {i > 0 && (
            <span className="absolute right-1/2 top-[7px] h-px w-full overflow-hidden bg-line">
              <motion.span initial={false} animate={{ scaleX: used[i] ? 1 : 0 }} transition={{ duration: 0.5, ease }}
                className="absolute inset-0 origin-left bg-gradient-to-r from-coral to-violet" />
              {state[i] === 'active' && <span className="xr-flow absolute inset-y-0 w-6 bg-gradient-to-r from-transparent via-white to-transparent" />}
            </span>
          )}
          <span className={cx('relative z-10 grid h-[15px] w-[15px] place-items-center rounded-full border transition-all duration-500',
            state[i] === 'done' && 'border-transparent bg-gradient-to-br from-coral to-violet',
            state[i] === 'active' && 'border-violet bg-white',
            state[i] === 'failed' && 'border-transparent bg-rose',
            state[i] === 'idle' && 'border-line-2 bg-white')}>
            {state[i] === 'active' && <span className="absolute inset-[-5px] animate-ping rounded-full bg-violet/25" />}
            {state[i] === 'active' && <span className="h-[5px] w-[5px] rounded-full bg-violet" />}
          </span>
          <span className={cx('mt-1.5 text-[9.5px] tracking-wide transition-colors',
            state[i] === 'active' ? 'font-medium text-ink' : state[i] === 'done' ? 'text-ink-2' : 'text-faint',
            !running && state[i] === 'idle' && 'line-through decoration-faint/60')}>{st.label}</span>
          {i === last && running && state[i + 1] === 'idle' && null}
        </div>
      ))}
    </div>
  )
}
