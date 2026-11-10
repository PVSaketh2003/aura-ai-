import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, FileText, LayoutGrid, Laptop, List, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Chip, Eyebrow, StatusDot, useToast } from '../components/ui'
import { useAgent } from '../context/AgentContext'
import { PageShell } from '../layouts/PageShell'
import { isIngestRun, ProcessingJourney, type UploadState } from '../components/ProcessingJourney'
import { api } from '../services/api'
import type { DocumentDetail, DocumentRec } from '../types'
import { bytes, relative } from '../utils/format'

function StatusPill({ d }: { d: DocumentRec }) {
  if (d.status === 'indexed') return <span className="flex items-center gap-1.5 text-[12px] text-ink-2"><StatusDot tone="ok" />Indexed</span>
  if (d.status === 'failed') return <span className="flex items-center gap-1.5 text-[12px] text-rose"><StatusDot tone="down" />Failed</span>
  return <span className="flex items-center gap-1.5 text-[12px]"><StatusDot tone="warn" pulse /><span className="text-shimmer">Processing</span></span>
}

function Row({ d, onOpen, i }: { d: DocumentRec; onOpen: () => void; i: number }) {
  return (
    <motion.button layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 10) * 0.025 }}
      onClick={onOpen} className="group flex w-full items-center gap-4 border-b border-line py-4 text-left transition hover:bg-white/50">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-white text-mute shadow-soft transition group-hover:text-violet"><FileText size={17} strokeWidth={1.6} /></span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-medium text-ink">{d.filename}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-mute">
          <span>{d.source === 'local_agent' ? (d.source_directory || 'Mac') : 'Uploaded'}</span><span className="text-faint">·</span>
          <span>{d.page_count || '—'} pages</span><span className="text-faint">·</span>
          <span>{d.chunk_count || '—'} chunks</span>
          {d.loader && <><span className="text-faint">·</span><span className="font-mono text-[11px]">{d.loader}</span></>}
          {(d.inspection?.scanned_pages?.length ?? 0) > 0 && <span className="rounded-full bg-coral/15 px-1.5 py-px text-[10.5px] font-medium text-[#c2410c]">OCR · {d.inspection.scanned_pages!.length} scanned</span>}
          {(d.inspection?.table_pages?.length ?? 0) > 0 && <span className="rounded-full bg-sky/15 px-1.5 py-px text-[10.5px] font-medium text-[#2f6bff]">{d.inspection.table_pages!.length} table pages</span>}
          <span className="text-faint">·</span><span>{relative(d.created_at)}</span>
        </div>
      </div>
      <div className="hidden items-center gap-3 sm:flex">
        <span title="Embeddings" className="flex items-center gap-1 text-[11px] text-mute"><StatusDot tone={d.embedding_status === 'completed' ? 'ok' : d.embedding_status === 'failed' ? 'down' : 'idle'} />emb</span>
        <span title="Vector index" className="flex items-center gap-1 text-[11px] text-mute"><StatusDot tone={d.index_status === 'completed' ? 'ok' : d.index_status === 'failed' ? 'down' : 'idle'} />index</span>
      </div>
      <div className="w-24 text-right"><StatusPill d={d} /></div>
    </motion.button>
  )
}

/** Grid card: the same real facts as the row, laid out as a document tile. */
function Card({ d, onOpen, i }: { d: DocumentRec; onOpen: () => void; i: number }) {
  const ocr = d.inspection?.scanned_pages?.length ?? 0
  const tables = d.inspection?.table_pages?.length ?? 0
  return (
    <motion.button layout initial={{ opacity: 0, y: 10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: Math.min(i, 12) * 0.03 }}
      whileHover={{ y: -3 }} onClick={onOpen}
      className="group relative flex flex-col overflow-hidden rounded-[22px] border border-line bg-white/70 p-4 text-left shadow-soft transition hover:border-violet/30 hover:shadow-float">
      <div className="flex items-start gap-3">
        <span className="relative grid h-14 w-11 shrink-0 place-items-center rounded-lg border border-line bg-[linear-gradient(160deg,#fff,#f6f2ff)] text-[9px] font-bold tracking-wide text-[#e2612f] shadow-soft">
          PDF<span className="absolute right-0 top-0 h-3 w-3 rounded-bl-md border-b border-l border-line bg-paper" /></span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[14px] font-medium leading-snug text-ink">{d.filename}</div>
          <div className="mt-1 text-[11.5px] text-mute">{d.source === 'local_agent' ? (d.source_directory || 'Mac') : 'Uploaded'} · {relative(d.created_at)}</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        {[['pages', d.page_count], ['chunks', d.chunk_count], ['size', bytes(d.size_bytes)]].map(([k, v]) => (
          <div key={k as string} className="rounded-xl bg-ink/[.03] py-1.5"><div className="font-mono text-[13px] tabular-nums text-ink">{v || '—'}</div><div className="text-[10px] uppercase tracking-wider text-mute">{k}</div></div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10.5px]">
        {d.loader && <span className="rounded-full bg-ink/[.04] px-2 py-0.5 font-mono text-mute">{d.loader}</span>}
        {ocr > 0 && <span className="rounded-full bg-coral/15 px-2 py-0.5 font-medium text-[#c2410c]">OCR · {ocr}</span>}
        {tables > 0 && <span className="rounded-full bg-sky/15 px-2 py-0.5 font-medium text-[#2f6bff]">{tables} tables</span>}
        <span className="ml-auto flex items-center gap-2 text-mute">
          <span className="flex items-center gap-1"><StatusDot tone={d.embedding_status === 'completed' ? 'ok' : d.embedding_status === 'failed' ? 'down' : 'idle'} />emb</span>
          <span className="flex items-center gap-1"><StatusDot tone={d.index_status === 'completed' ? 'ok' : d.index_status === 'failed' ? 'down' : 'idle'} />index</span>
        </span>
      </div>
      <div className="mt-3 border-t border-line pt-2.5"><StatusPill d={d} /></div>
    </motion.button>
  )
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><div className="text-[11px] uppercase tracking-[0.14em] text-mute">{k}</div><div className="mt-1 text-[13.5px] text-ink">{v}</div></div>
}

function Drawer({ id, onClose, onAction }: { id: string; onClose: () => void; onAction: (execution: string, label: string) => void }) {
  const [d, setD] = useState<DocumentDetail | null>(null)
  const [q, setQ] = useState('')
  const [confirm, setConfirm] = useState(false)
  const toast = useToast()
  const { on } = useAgent()
  const load = useCallback(() => api.document(id, q).then(setD).catch((e) => toast(e.message, 'error')), [id, q, toast])
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t) }, [load])
  useEffect(() => on((e) => { if (e.kind === 'document.updated' && e.document.id === id) load() }), [on, id, load])

  const insp = d?.inspection ?? {}
  return (
    <>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-30 bg-paper/50 backdrop-blur-[2px]" />
      <motion.aside initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 36 }}
        className="glass fixed bottom-3 right-3 top-3 z-40 flex w-[min(560px,calc(100vw-24px))] flex-col rounded-[26px] border border-line shadow-float">
        <div className="flex items-start justify-between gap-4 border-b border-line p-6">
          <div className="min-w-0"><Eyebrow>Document</Eyebrow><h2 className="mt-2 truncate font-serif text-[28px] leading-tight text-ink">{d?.filename ?? '…'}</h2>
            {d && <div className="mt-2"><StatusPill d={d} /></div>}</div>
          <button onClick={onClose} className="rounded-full p-1.5 text-mute hover:bg-ink/5 hover:text-ink" aria-label="Close"><X size={16} /></button>
        </div>
        {d && (
          <div className="scroll-quiet flex-1 overflow-y-auto p-6">
            {d.error && <p className="mb-6 rounded-xl border border-rose/15 bg-rose/[.04] px-3 py-2 text-[12.5px] text-rose">{d.error}</p>}
            <div className="grid grid-cols-2 gap-x-6 gap-y-5">
              <Fact k="Pages" v={d.page_count} />
              <Fact k="Chunks" v={d.chunk_count} />
              <Fact k="Loader" v={<span className="font-mono text-[12.5px]">{d.loader || '—'}</span>} />
              <Fact k="Chunking" v={d.chunking_config.strategy ? `${d.chunking_config.strategy}${d.chunking_config.chunk_size ? ` · ${d.chunking_config.chunk_size}/${d.chunking_config.chunk_overlap}` : ''}` : '—'} />
              <Fact k="Scanned pages" v={insp.scanned_pages?.length ?? 0} />
              <Fact k="Table pages" v={insp.table_pages?.length ?? 0} />
              <Fact k="Embedding model" v={<span className="font-mono text-[12.5px]">{d.embedding_model || '—'}</span>} />
              <Fact k="Size" v={bytes(d.size_bytes)} />
              <div className="col-span-2"><Fact k="Why this loader" v={<span className="text-ink-2">{d.loader_reason || '—'}</span>} /></div>
              <div className="col-span-2"><Fact k="Source" v={<span className="break-all font-mono text-[12px] text-ink-2">{d.source_path || 'Uploaded in browser'}</span>} /></div>
              <div className="col-span-2"><Fact k="Content hash" v={<span className="font-mono text-[11.5px] text-mute">{d.content_hash}</span>} /></div>
            </div>
            <div className="mt-8 flex items-center justify-between"><Eyebrow>Chunks · {d.chunks_total}</Eyebrow></div>
            <label className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-white/70 px-3 py-2 text-[13px]">
              <Search size={14} className="text-mute" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search inside this document" className="flex-1 bg-transparent outline-none placeholder:text-faint" />
            </label>
            <ol className="mt-3 space-y-2">
              {d.chunks.map((c) => (
                <li key={c.id} className="rounded-xl border border-line bg-white/60 p-3">
                  <div className="mb-1.5 flex items-center gap-2 font-mono text-[10.5px] text-mute">#{c.index} · p.{c.page_number}{c.page_end !== c.page_number ? `–${c.page_end}` : ''}{c.kind !== 'text' && <Chip className="!py-0">{c.kind}</Chip>}</div>
                  <p className="line-clamp-5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">{c.text}</p>
                </li>
              ))}
            </ol>
          </div>
        )}
        {d && (
          <div className="flex items-center justify-between gap-3 border-t border-line p-4">
            {confirm ? (
              <div className="flex flex-1 items-center justify-between gap-3 text-[12.5px] text-ink-2">
                <span>Remove from the library? The original file on your Mac is never touched.</span>
                <span className="flex shrink-0 gap-2">
                  <button onClick={() => setConfirm(false)} className="rounded-full px-3 py-1.5 hover:bg-ink/5">Cancel</button>
                  <button onClick={async () => { await api.deleteDocument(d.id); toast('Removed from library', 'success'); onClose() }}
                    className="rounded-full bg-rose px-3 py-1.5 text-white">Remove</button>
                </span>
              </div>
            ) : (
              <>
                <button onClick={() => setConfirm(true)} className="flex items-center gap-1.5 rounded-full px-3 py-2 text-[13px] text-mute transition hover:bg-rose/5 hover:text-rose"><Trash2 size={14} />Remove</button>
                <button onClick={async () => { const r = await api.reindex(d.id); onAction(r.execution_id, `Re-index ${d.filename}`) }} disabled={d.status === 'processing'}
                  className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] text-white shadow-soft transition hover:scale-[1.02] disabled:opacity-40"><RefreshCw size={14} />Re-index</button>
              </>
            )}
          </div>
        )}
      </motion.aside>
    </>
  )
}

export function LibraryPage() {
  const { on, watchRun, localAgentOnline, runs } = useAgent()
  // processing journeys shown on this page: browser uploads (with byte progress) + any ingestion run in flight
  const [jobs, setJobs] = useState<{ key: string; upload: UploadState | null; runId?: string }[]>([])
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const patchJob = (key: string, f: (j: { key: string; upload: UploadState | null; runId?: string }) => { key: string; upload: UploadState | null; runId?: string }) =>
    setJobs((js) => js.map((j) => (j.key === key ? f(j) : j)))
  const toast = useToast()
  const [docs, setDocs] = useState<DocumentRec[] | null>(null)
  const [q, setQ] = useState('')
  const [ask, setAsk] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [view, setViewState] = useState<'list' | 'grid'>(() => { try { return localStorage.getItem('aura.library.view') === 'grid' ? 'grid' : 'list' } catch { return 'list' } })
  const setView = (v: 'list' | 'grid') => { setViewState(v); try { localStorage.setItem('aura.library.view', v) } catch { /* private mode */ } }
  const file = useRef<HTMLInputElement>(null)
  const myRuns = useRef(new Set<string>())

  const load = useCallback(() => api.documents(q).then((p) => setDocs(p.results)).catch((e) => toast(e.message, 'error')), [q, toast])
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t) }, [load])
  useEffect(() => on((e) => {
    if (e.kind === 'document.updated') setDocs((ds) => {
      if (!ds) return ds
      const i = ds.findIndex((x) => x.id === e.document.id)
      return i === -1 ? [e.document, ...ds] : ds.map((x) => (x.id === e.document.id ? e.document : x))
    })
    if (e.kind === 'run.finished' && myRuns.current.has(e.execution_id)) {
      myRuns.current.delete(e.execution_id)
      if (e.status === 'completed') toast(e.result?.answer.split('\n')[0].replace(/\*\*/g, '') || 'Done', 'success')
      else toast(e.error || 'That didn’t work.', 'error')
      load()
    }
  }), [on, toast, load])

  const started = (id: string, label: string) => { myRuns.current.add(id); watchRun(id, label) }
  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.name.toLowerCase().endsWith('.pdf')) { toast(`${f.name} is not a PDF`, 'error'); continue }
      const key = `${f.name}-${Date.now()}`
      setJobs((js) => [{ key, upload: { name: f.name, size: f.size, loaded: 0, total: f.size, done: false } }, ...js])
      try {
        const r = await api.uploadDocumentWithProgress(f, (loaded, total) => patchJob(key, (j) => ({ ...j, upload: { ...j.upload!, loaded, total } })))
        patchJob(key, (j) => ({ ...j, runId: r.execution_id, upload: { ...j.upload!, loaded: j.upload!.total, done: true } }))
        started(r.execution_id, f.name)
      } catch (e) {
        patchJob(key, (j) => ({ ...j, upload: { ...j.upload!, error: (e as Error).message } }))
        toast((e as Error).message, 'error')
      }
    }
  }
  const fromMac = async () => {
    const t = ask.trim(); if (!t) return
    try { const r = await api.ingestFromMac({ query: t }); setAsk(''); started(r.execution_id, `Load ${t}`) } catch (e) { toast((e as Error).message, 'error') }
  }

  const indexed = docs?.filter((d) => d.status === 'indexed') ?? []
  return (
    <div className="relative flex min-w-0 flex-1" onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false) }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files) }}>
      <PageShell eyebrow="Library" title={<>Your <span className="italic">documents</span>, understood.</>}
        lede={docs ? `${indexed.length} indexed · ${indexed.reduce((a, d) => a + d.page_count, 0).toLocaleString()} pages · ${indexed.reduce((a, d) => a + d.chunk_count, 0).toLocaleString()} searchable chunks`
          : 'Loading…'}>
        <div className="glass flex items-center gap-2 rounded-[22px] border border-line p-2 pl-4 shadow-float">
          <Laptop size={16} className="shrink-0 text-mute" />
          <input value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && fromMac()}
            placeholder="Load from your Mac, e.g. “Machine Learning Notes.pdf from Documents”"
            className="min-w-0 flex-1 bg-transparent py-2 text-[14px] outline-none placeholder:text-faint" />
          <span className="hidden items-center gap-1.5 text-[11px] text-mute md:flex" title="Local Mac Agent">
            <StatusDot tone={localAgentOnline ? 'ok' : 'down'} />{localAgentOnline ? 'Mac connected' : 'Mac agent offline'}
          </span>
          <button onClick={fromMac} disabled={!ask.trim()} aria-label="Load"
            className="grid h-9 w-9 place-items-center rounded-full bg-ink text-white transition hover:scale-105 disabled:bg-ink/10 disabled:text-mute"><ArrowRight size={16} /></button>
          <button onClick={() => file.current?.click()} className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3.5 py-2 text-[13px] text-ink-2 transition hover:border-line-2 hover:text-ink">
            <Upload size={14} /> Upload
          </button>
          <input ref={file} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
        </div>

        {(() => {
          const tracked = new Set(jobs.map((j) => j.runId).filter(Boolean))
          const others = Object.values(runs).filter((r) => isIngestRun(r) && !tracked.has(r.id) && (r.status === 'running' || Date.now() - r.startedAt < 10 * 60_000))
            .map((r) => ({ key: r.id, upload: null, runId: r.id }))
          const all = [...jobs, ...others].filter((j) => !hidden.has(j.key))
          if (!all.length) return null
          return (
            <div className="mt-8">
              <div className="mb-3 flex items-center justify-between"><Eyebrow>Processing · live</Eyebrow>
                {all.some((j) => j.runId && runs[j.runId]?.status !== 'running') && <button onClick={() => setHidden(new Set(all.filter((j) => j.runId && runs[j.runId]?.status !== 'running').map((j) => j.key)))}
                  className="text-[12px] text-mute hover:text-ink">Clear finished</button>}</div>
              <div className="grid gap-3">
                <AnimatePresence initial={false}>
                  {all.map((j) => (
                    <motion.div key={j.key} layout initial={{ opacity: 0, y: -10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, height: 0 }}>
                      <ProcessingJourney run={j.runId ? runs[j.runId] : null} upload={j.upload} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          )
        })()}

        <div className="mt-10 flex items-center justify-between">
          <Eyebrow>{docs?.length ?? 0} documents</Eyebrow>
          <div className="flex items-center gap-2">
            <div role="group" aria-label="View" className="flex rounded-full border border-line bg-white/60 p-0.5">
              {([['list', List], ['grid', LayoutGrid]] as const).map(([v, Icon]) => (
                <button key={v} onClick={() => setView(v)} aria-pressed={view === v} aria-label={`${v} view`}
                  className={view === v ? 'grid h-7 w-7 place-items-center rounded-full bg-ink text-white' : 'grid h-7 w-7 place-items-center rounded-full text-mute hover:text-ink'}><Icon size={14} /></button>
              ))}
            </div>
            <label className="flex items-center gap-2 rounded-full border border-line bg-white/60 px-3 py-1.5 text-[13px]">
              <Search size={13} className="text-mute" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter documents" className="w-28 bg-transparent outline-none placeholder:text-faint sm:w-36" />
            </label>
          </div>
        </div>
        <div className={view === 'grid' ? 'mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3' : 'mt-2 border-t border-line'}>
          {docs?.map((d, i) => view === 'grid' ? <Card key={d.id} d={d} i={i} onOpen={() => setOpen(d.id)} /> : <Row key={d.id} d={d} i={i} onOpen={() => setOpen(d.id)} />)}
          {docs && !docs.length && (
            <div className="py-20 text-center">
              <p className="font-serif text-[26px] text-ink">{q ? 'No matches' : 'Nothing here yet'}</p>
              <p className="mx-auto mt-2 max-w-sm text-[13.5px] text-mute">{q ? 'Try another name.' : 'Ask me to load a PDF from your Mac, upload one, or just drop a file anywhere on this page.'}</p>
            </div>
          )}
        </div>
      </PageShell>
      <AnimatePresence>
        {drag && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-4 z-20 grid place-items-center rounded-[28px] border-2 border-dashed border-violet/40 bg-white/60 backdrop-blur-sm">
            <div className="text-center"><Upload className="mx-auto text-violet" size={28} /><p className="mt-3 font-serif text-[28px] text-ink">Drop PDFs to index</p></div>
          </motion.div>
        )}
        {open && <Drawer id={open} onClose={() => setOpen(null)} onAction={(id, label) => started(id, label)} />}
      </AnimatePresence>
    </div>
  )
}
