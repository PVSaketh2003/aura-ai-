import { AnimatePresence, motion } from 'motion/react'
import {
  AudioLines, Brain, CornerDownLeft, FileText, LibraryBig, MessageCircle, MessagesSquare, Mic, Orbit, Plus, Search,
  SlidersHorizontal, UserRound, UsersRound, type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAgent } from '../context/AgentContext'
import { api } from '../services/api'
import { mx } from '../services/messenger'
import { cx } from '../utils/format'

interface Item { id: string; group: string; label: string; hint?: string; icon: LucideIcon; tint: string; run: () => void; keywords?: string }

/** ⌘K / Ctrl+K: one place to go anywhere, do anything, and find anything (conversations, PDFs, memories, people). */
export function CommandBar() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [found, setFound] = useState<Item[]>([])
  const nav = useNavigate()
  const { newConversation, openConversation } = useAgent()
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o) }
      if (e.key === 'Escape') setOpen(false)
    }
    const o = () => setOpen(true)
    window.addEventListener('keydown', k)
    window.addEventListener('aura:command', o)
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('aura:command', o) }
  }, [])
  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => input.current?.focus(), 30) } }, [open])

  const go = useCallback((path: string) => () => { nav(path); setOpen(false) }, [nav])
  const actions: Item[] = useMemo(() => [
    { id: 'a-new', group: 'Actions', label: 'New conversation with Aura', icon: Plus, tint: '#ff8a5b', run: () => { newConversation(); nav('/'); setOpen(false) }, keywords: 'chat ask start' },
    { id: 'a-talk', group: 'Actions', label: 'Talk to Aura', hint: 'voice', icon: Mic, tint: '#ff7a4d', run: () => { nav('/'); setOpen(false); setTimeout(() => window.dispatchEvent(new Event('aura:talk')), 350) }, keywords: 'voice speak microphone' },
    { id: 'a-upload', group: 'Actions', label: 'Add a PDF to my knowledge', icon: FileText, tint: '#a77bff', run: go('/library'), keywords: 'upload document ingest pdf' },
    { id: 'a-group', group: 'Actions', label: 'Create a group', icon: UsersRound, tint: '#5b8cff', run: go('/messenger?s=groups'), keywords: 'messenger people friends' },
    { id: 'a-contact', group: 'Actions', label: 'Add a contact by phone number', icon: UserRound, tint: '#2fbf8f', run: go('/messenger?s=contacts'), keywords: 'phone person friend' },
    { id: 'p-chat', group: 'Go to', label: 'Aura AI', icon: MessageCircle, tint: '#8a8a96', run: go('/') },
    { id: 'p-mx', group: 'Go to', label: 'Messenger', icon: MessagesSquare, tint: '#8a8a96', run: go('/messenger'), keywords: 'chats calls whatsapp' },
    { id: 'p-lib', group: 'Go to', label: 'Library', icon: LibraryBig, tint: '#8a8a96', run: go('/library'), keywords: 'documents pdfs' },
    { id: 'p-gal', group: 'Go to', label: 'Knowledge galaxy', icon: Orbit, tint: '#8a8a96', run: go('/galaxy'), keywords: '3d embeddings vectors' },
    { id: 'p-mem', group: 'Go to', label: 'Memory', icon: Brain, tint: '#8a8a96', run: go('/memory'), keywords: 'remember facts' },
    { id: 'p-voice', group: 'Go to', label: 'Train my voice', icon: AudioLines, tint: '#8a8a96', run: go('/voice'), keywords: 'accent speech' },
    { id: 'p-set', group: 'Go to', label: 'Settings', icon: SlidersHorizontal, tint: '#8a8a96', run: go('/settings'), keywords: 'preferences languages' },
  ], [go, nav, newConversation])

  // live search across the user's own data (debounced; only when the user typed something)
  useEffect(() => {
    if (!open || q.trim().length < 2) { setFound([]); return }
    let alive = true
    const t = setTimeout(async () => {
      const term = q.trim()
      const [convs, docs, mems, people] = await Promise.all([
        api.conversations(term).then((r) => r.results).catch(() => []),
        api.documents(term).then((r) => r.results).catch(() => []),
        api.memories(term).then((r) => r.results).catch(() => []),
        mx.contacts(term).then((r) => r.contacts).catch(() => []),
      ])
      if (!alive) return
      setFound([
        ...convs.slice(0, 5).map((c) => ({ id: `c-${c.id}`, group: 'Conversations', label: c.title || 'Untitled conversation', icon: MessageCircle, tint: '#ff8a5b',
          run: () => { nav('/'); openConversation(c.id); setOpen(false) } })),
        ...docs.slice(0, 4).map((d) => ({ id: `d-${d.id}`, group: 'Documents', label: d.filename, hint: `${d.page_count ?? ''} pages`, icon: FileText, tint: '#a77bff', run: go('/library') })),
        ...mems.slice(0, 4).map((m) => ({ id: `m-${m.id}`, group: 'Memories', label: m.content, icon: Brain, tint: '#c27bff', run: go('/memory') })),
        ...people.slice(0, 4).map((p) => ({ id: `p-${p.id}`, group: 'People', label: p.name, hint: p.phone_pretty, icon: UserRound, tint: '#2fbf8f', run: go('/messenger?s=contacts') })),
      ])
    }, 180)
    return () => { alive = false; clearTimeout(t) }
  }, [q, open, nav, go, openConversation])

  const items = useMemo(() => {
    const t = q.trim().toLowerCase()
    const local = t ? actions.filter((a) => `${a.label} ${a.keywords ?? ''}`.toLowerCase().includes(t)) : actions
    return [...local, ...found]
  }, [q, actions, found])
  useEffect(() => { setSel(0) }, [q])
  useEffect(() => { listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' }) }, [sel])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
    if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run() }
  }

  let lastGroup = ''
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[70] flex items-start justify-center bg-ink/15 px-4 pt-[12vh] backdrop-blur-[6px]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setOpen(false)}>
          <motion.div onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command bar"
            initial={{ opacity: 0, y: -14, scale: 0.97, filter: 'blur(8px)' }} animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }} transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            className="cmd-shell w-full max-w-[640px] rounded-[28px] p-[1.5px]">
            <div className="overflow-hidden rounded-[26.5px] bg-paper/95 shadow-float backdrop-blur-2xl">
              <div className="flex items-center gap-3 border-b border-line px-5">
                <Search size={18} className="text-violet" />
                <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Go anywhere, do anything, find anything…"
                  className="h-16 flex-1 bg-transparent text-[17px] text-ink outline-none placeholder:text-faint" />
                <kbd className="rounded-md border border-line bg-white px-1.5 py-0.5 font-mono text-[10.5px] text-mute">esc</kbd>
              </div>
              <div ref={listRef} className="scroll-quiet max-h-[52vh] overflow-y-auto p-2">
                {items.length === 0 && <div className="px-4 py-10 text-center text-[13.5px] text-mute">Nothing matches “{q}”.</div>}
                {items.map((it, i) => {
                  const header = it.group !== lastGroup ? (lastGroup = it.group) : null
                  const Icon = it.icon
                  return (
                    <div key={it.id}>
                      {header && <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-mute">{header}</div>}
                      <button data-i={i} onMouseEnter={() => setSel(i)} onClick={it.run}
                        className={cx('relative flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors', i === sel ? 'text-ink' : 'text-ink-2')}>
                        {i === sel && <motion.span layoutId="cmd-sel" className="absolute inset-0 rounded-2xl bg-[linear-gradient(90deg,rgb(255_138_91/.10),rgb(167_123_255/.12),rgb(91_140_255/.10))]" transition={{ type: 'spring', stiffness: 600, damping: 40 }} />}
                        <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-xl" style={{ background: `${it.tint}1a`, color: it.tint }}><Icon size={15} /></span>
                        <span className="relative min-w-0 flex-1 truncate text-[14px]">{it.label}</span>
                        {it.hint && <span className="relative text-[11.5px] text-mute">{it.hint}</span>}
                        {i === sel && <CornerDownLeft size={13} className="relative text-mute" />}
                      </button>
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center gap-4 border-t border-line px-5 py-2.5 text-[11px] text-mute">
                <span><kbd className="font-mono">↑↓</kbd> move</span><span><kbd className="font-mono">↵</kbd> open</span><span className="ml-auto"><kbd className="font-mono">⌘K</kbd> anywhere</span>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
