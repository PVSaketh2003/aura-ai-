import { AnimatePresence, motion } from 'motion/react'
import { Check, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Eyebrow, StatusDot, useToast } from '../components/ui'
import { useAgent } from '../context/AgentContext'
import { PageShell } from '../layouts/PageShell'
import { api } from '../services/api'
import type { MemoryRec } from '../types'
import { cx } from '../utils/format'

const CATS: [string, string][] = [
  ['', 'All'], ['personal_preference', 'Preferences'], ['project', 'Projects'], ['technical', 'Technical'],
  ['instruction', 'Instructions'], ['goal', 'Goals'], ['fact', 'Facts'], ['other', 'Other'],
]
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function Card({ m, onChange, onDelete, i }: { m: MemoryRec; onChange: (m: MemoryRec) => void; onDelete: () => void; i: number }) {
  const [edit, setEdit] = useState(false)
  const [text, setText] = useState(m.content)
  const [cat, setCat] = useState(m.category)
  const [confirm, setConfirm] = useState(false)
  const toast = useToast()
  const save = async () => {
    try { onChange(await api.updateMemory(m.id, { content: text.trim(), category: cat })); setEdit(false); toast('Memory updated', 'success') }
    catch (e) { toast((e as Error).message, 'error') }
  }
  return (
    <motion.li layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ delay: Math.min(i, 10) * 0.03 }}
      className="group relative rounded-[20px] border border-line bg-white/65 p-5 shadow-soft transition hover:bg-white">
      <div className="mb-3 flex items-center gap-2 text-[11px] text-mute">
        <span className="rounded-full bg-ink/[.05] px-2 py-0.5 font-medium uppercase tracking-[0.12em] text-ink-2">{m.category_label}</span>
        <span>{date(m.created_at)}</span>
        {m.updated_at.slice(0, 16) !== m.created_at.slice(0, 16) && <span>· edited {date(m.updated_at)}</span>}
        {m.similarity != null && <span>· match {Math.round(m.similarity * 100)}%</span>}
        <span className="rounded-full border border-line px-2 py-0.5" title={m.original_text ? `You said: “${m.original_text}”` : undefined}>
          {m.source_conversation ? 'from a conversation' : 'added here'}{m.language && m.language !== 'en' ? ` · ${m.language}` : ''}</span>
        <span className="ml-auto flex items-center gap-1.5" title={`Semantic index: ${m.vector_status}`}>
          <StatusDot tone={m.vector_status === 'synced' ? 'ok' : m.vector_status === 'failed' ? 'down' : 'warn'} />
        </span>
      </div>
      {edit ? (
        <div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus
            className="w-full resize-none rounded-xl border border-line-2 bg-white p-3 text-[14.5px] leading-relaxed text-ink outline-none focus:border-ink" />
          <div className="mt-2 flex items-center gap-2">
            <select value={cat} onChange={(e) => setCat(e.target.value)} className="rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] outline-none">
              {CATS.slice(1).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <span className="ml-auto flex gap-1">
              <button onClick={() => { setEdit(false); setText(m.content); setCat(m.category) }} className="rounded-full p-2 text-mute hover:bg-ink/5"><X size={14} /></button>
              <button onClick={save} disabled={!text.trim()} className="rounded-full bg-ink p-2 text-white disabled:opacity-40"><Check size={14} /></button>
            </span>
          </div>
        </div>
      ) : (
        <p className="font-serif text-[21px] leading-snug text-ink" lang={m.language}>{m.content}</p>
      )}
      {m.tags.length > 0 && !edit && <div className="mt-3 flex flex-wrap gap-1.5">{m.tags.map((t) => <span key={t} className="text-[11.5px] text-mute">#{t}</span>)}</div>}
      {!edit && (
        <div className="absolute right-4 top-12 flex gap-1 opacity-0 transition group-hover:opacity-100">
          {confirm ? (
            <span className="flex items-center gap-1 rounded-full border border-line bg-white px-1 py-0.5 text-[12px] shadow-soft">
              <span className="px-2 text-ink-2">Delete forever?</span>
              <button onClick={() => setConfirm(false)} className="rounded-full px-2 py-1 hover:bg-ink/5">No</button>
              <button onClick={onDelete} className="rounded-full bg-rose px-2.5 py-1 text-white">Delete</button>
            </span>
          ) : (
            <>
              <button onClick={() => setEdit(true)} aria-label="Edit" className="rounded-full border border-line bg-white p-2 text-mute shadow-soft hover:text-ink"><Pencil size={13} /></button>
              <button onClick={() => setConfirm(true)} aria-label="Delete" className="rounded-full border border-line bg-white p-2 text-mute shadow-soft hover:text-rose"><Trash2 size={13} /></button>
            </>
          )}
        </div>
      )}
    </motion.li>
  )
}

export function MemoryPage() {
  const [items, setItems] = useState<MemoryRec[] | null>(null)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftCat, setDraftCat] = useState('fact')
  const [draftTags, setDraftTags] = useState('')
  const toast = useToast()
  const { historyVersion } = useAgent()

  const load = useCallback(async () => {
    try {
      if (q.trim().length > 2) {
        const r = await api.searchMemories(q.trim())
        setItems(cat ? r.results.filter((m) => m.category === cat) : r.results)
      } else setItems((await api.memories('', cat)).results)
    } catch (e) { toast((e as Error).message, 'error') }
  }, [q, cat, toast])
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load, historyVersion])

  const add = async () => {
    try {
      const r = await api.saveMemory({ content: draft.trim(), category: draftCat, tags: draftTags.split(/[,#\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 8) })
      toast(r.outcome === 'duplicate' ? 'Already saved, so it wasn’t duplicated' : r.indexed ? 'Saved permanently' : 'Saved. Indexing will retry in the background',
        r.outcome === 'duplicate' ? 'info' : 'success')
      setDraft(''); setDraftTags(''); setAdding(false); load()
    } catch (e) { toast((e as Error).message, 'error') }
  }

  return (
    <PageShell eyebrow="Memory" title={<>What you asked me to <span className="italic">keep</span>.</>}
      lede="I only remember what you explicitly ask me to save. Say “remember that…” in any language. These stay until you delete them.">
      <div className="flex flex-wrap items-center gap-3">
        <label className="glass flex min-w-[260px] flex-1 items-center gap-2 rounded-full border border-line px-4 py-2.5 text-[14px] shadow-soft">
          <Search size={15} className="text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by meaning, e.g. “backend language”" className="flex-1 bg-transparent outline-none placeholder:text-faint" />
        </label>
        <button onClick={() => setAdding((v) => !v)} className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[13.5px] text-white shadow-soft transition hover:scale-[1.02]">
          <Plus size={15} /> Add memory
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {CATS.map(([v, l]) => (
          <button key={v} onClick={() => setCat(v)} className={cx('rounded-full px-3 py-1.5 text-[12.5px] transition', cat === v ? 'bg-ink text-white' : 'text-ink-2 hover:bg-ink/5')}>{l}</button>
        ))}
      </div>
      <AnimatePresence>
        {adding && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mt-6 rounded-[20px] border border-line-2 bg-white p-4 shadow-float">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} autoFocus placeholder="The user prefers Golang for backend development."
                className="w-full resize-none bg-transparent font-serif text-[20px] leading-snug text-ink outline-none placeholder:text-faint" />
              <div className="mt-2 flex items-center gap-2">
                <input value={draftTags} onChange={(e) => setDraftTags(e.target.value)} placeholder="tags, e.g. work, golang"
                  className="min-w-0 flex-1 rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] outline-none placeholder:text-faint" />
                <select value={draftCat} onChange={(e) => setDraftCat(e.target.value)} className="rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] outline-none">
                  {CATS.slice(1).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <button onClick={add} disabled={!draft.trim()} className="ml-auto rounded-full bg-ink px-4 py-1.5 text-[13px] text-white disabled:opacity-40">Save</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-8"><Eyebrow>{items ? `${items.length} memor${items.length === 1 ? 'y' : 'ies'}` : 'Loading…'}</Eyebrow></div>
      <ul className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <AnimatePresence>
          {items?.map((m, i) => (
            <Card key={m.id} m={m} i={i} onChange={(n) => setItems((xs) => xs?.map((x) => (x.id === n.id ? n : x)) ?? null)}
              onDelete={async () => { await api.deleteMemory(m.id); setItems((xs) => xs?.filter((x) => x.id !== m.id) ?? null); toast('Memory deleted', 'success') }} />
          ))}
        </AnimatePresence>
      </ul>
      {items && !items.length && (
        <div className="py-16 text-center">
          <p className="font-serif text-[26px] text-ink">{q ? 'Nothing matches that' : 'No memories yet'}</p>
          <p className="mx-auto mt-2 max-w-sm text-[13.5px] text-mute">Try saying: “Remember that my favourite backend language is Golang. Save this in our database.”</p>
        </div>
      )}
    </PageShell>
  )
}
