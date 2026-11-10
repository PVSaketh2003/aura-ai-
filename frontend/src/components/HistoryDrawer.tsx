import { AnimatePresence, motion } from 'motion/react'
import { Search, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAgent } from '../context/AgentContext'
import { api } from '../services/api'
import type { ConversationSummary } from '../types'
import { cx, relative } from '../utils/format'
import { Eyebrow, useToast } from './ui'

export function HistoryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { historyVersion, conversationId, openConversation, newConversation } = useAgent()
  const [items, setItems] = useState<ConversationSummary[]>([])
  const [q, setQ] = useState('')
  const toast = useToast()

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => api.conversations(q).then((p) => setItems(p.results)).catch((e) => toast(e.message, 'error')), 150)
    return () => clearTimeout(t)
  }, [open, q, historyVersion, toast])

  const remove = async (id: string) => {
    await api.deleteConversation(id)
    setItems((x) => x.filter((c) => c.id !== id))
    if (id === conversationId) newConversation()
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-30 bg-paper/40 backdrop-blur-[2px]" />
          <motion.aside initial={{ x: -24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -24, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 38 }}
            className="glass fixed bottom-3 left-[84px] top-3 z-40 flex w-[320px] flex-col rounded-[26px] border border-line p-5 shadow-float">
            <div className="mb-4 flex items-center justify-between"><Eyebrow>History</Eyebrow>
              <button onClick={onClose} className="rounded-full p-1 text-mute hover:bg-ink/5 hover:text-ink" aria-label="Close"><X size={15} /></button></div>
            <label className="mb-3 flex items-center gap-2 rounded-xl border border-line bg-white/70 px-3 py-2 text-[13px]">
              <Search size={14} className="text-mute" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" className="flex-1 bg-transparent outline-none placeholder:text-faint" />
            </label>
            <ul className="scroll-quiet -mx-2 flex-1 overflow-y-auto">
              {items.map((c) => (
                <li key={c.id} className="group relative">
                  <button onClick={() => { openConversation(c.id); onClose() }}
                    className={cx('w-full rounded-xl px-3 py-2.5 text-left transition hover:bg-ink/[.035]', c.id === conversationId && 'bg-ink/[.05]')}>
                    <div className="truncate pr-6 text-[13.5px] text-ink">{c.title || 'Untitled'}</div>
                    <div className="mt-0.5 text-[11.5px] text-mute">{relative(c.updated_at)} · {c.message_count} messages</div>
                  </button>
                  <button onClick={() => remove(c.id)} aria-label="Delete conversation"
                    className="absolute right-2 top-3 rounded-md p-1 text-faint opacity-0 transition hover:text-rose group-hover:opacity-100"><Trash2 size={13} /></button>
                </li>
              ))}
              {!items.length && <li className="px-3 py-8 text-center text-[13px] text-mute">{q ? 'No matches.' : 'Your conversations will live here, permanently.'}</li>}
            </ul>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
