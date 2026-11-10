import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowLeft, Check, CheckCheck, Clock, Copy, CornerUpLeft, Forward, Info, Loader2, Mic, Paperclip, Pencil, Phone, Pin, RotateCw,
  SendHorizontal, Smile, Sparkles, Square, Trash2, Video, X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '../ui'
import { useMessenger } from '../../context/MessengerContext'
import { useMicrophone } from '../../hooks/useMicrophone'
import { mx, upload, type ChatRec, type Msg } from '../../services/messenger'
import { bytes, cx } from '../../utils/format'
import { AttachmentView, Avatar, Modal } from './bits'
import { ChatInfo } from './ChatInfo'
import { Markdown } from '../Markdown'

const EMOJI = ['👍', '❤️', '😂', '😮', '🙏', '🔥']
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const day = (iso: string) => {
  const d = new Date(iso), t = new Date()
  if (d.toDateString() === t.toDateString()) return 'Today'
  if (new Date(t.getTime() - 864e5).toDateString() === d.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

interface Pending { id: string; file: File; progress: number; error?: string; ctrl: AbortController; voice?: boolean; duration?: number }

export function Conversation({ chat, onBack }: { chat: ChatRec; onBack: () => void }) {
  const { messages, loadMessages, send, retry, typing, sendTyping, startCall, refreshChats, me } = useMessenger()
  const toast = useToast()
  const list = useMemo(() => messages[chat.id] ?? [], [messages, chat.id])
  const [text, setText] = useState('')
  const [reply, setReply] = useState<Msg | null>(null)
  const [editing, setEditing] = useState<Msg | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const [drag, setDrag] = useState(false)
  const [info, setInfo] = useState(false)
  const [forward, setForward] = useState<Msg | null>(null)
  const [ai, setAi] = useState<{ title: string; text?: string; model?: string; error?: string } | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const mic = useMicrophone()

  useEffect(() => { loadMessages(chat.id).then(setHasMore).catch((e) => toast((e as Error).message, 'error')); setReply(null); setEditing(null); setText('') }, [chat.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { const el = scroller.current; if (el && atBottom.current) el.scrollTop = el.scrollHeight }, [list.length, pending.length])

  const onScroll = () => {
    const el = scroller.current!
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 40 && hasMore) {
      const h = el.scrollHeight
      loadMessages(chat.id, true).then((more) => { setHasMore(more); requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - h }) })
    }
  }

  const startUpload = useCallback((files: File[], voice = false, duration?: number) => {
    for (const file of files) {
      const p: Pending = { id: crypto.randomUUID(), file, progress: 0, ctrl: new AbortController(), voice, duration }
      setPending((s) => [...s, p])
      upload(file, { voice, duration, signal: p.ctrl.signal, onProgress: (f) => setPending((s) => s.map((x) => (x.id === p.id ? { ...x, progress: f } : x))) })
        .then((a) => { setPending((s) => s.filter((x) => x.id !== p.id)); atBottom.current = true; return send(chat.id, { attachment_id: a.id }, { attachment: a }) })
        .catch((e) => { if (e.cancelled) setPending((s) => s.filter((x) => x.id !== p.id)); else setPending((s) => s.map((x) => (x.id === p.id ? { ...x, error: e.message } : x))) })
    }
  }, [chat.id, send])

  const submit = async () => {
    const t = text.trim()
    if (!t) return
    if (editing) {
      try { await mx.edit(editing.id, t) } catch (e) { toast((e as Error).message, 'error') }
      setEditing(null); setText(''); return
    }
    atBottom.current = true
    setText(''); const r = reply; setReply(null)
    await send(chat.id, { text: t, reply_to: r?.id }, { reply_to: r ? { id: r.id, sender_name: r.sender_name, text: r.text } : null })
  }

  const toggleVoice = async () => {
    if (mic.state !== 'recording') { await mic.start(); return }
    const secs = mic.elapsed / 1000
    const blob = await mic.stop()
    if (!blob || secs < 0.8) return
    const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'
    startUpload([new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type.split(';')[0] })], true, Math.round(secs * 10) / 10)
  }

  const runAi = async (action: 'summarize' | 'action_items' | 'translate' | 'explain', title: string, language = 'en') => {
    setAi({ title })
    try { const r = await mx.ai(chat.id, action, language); setAi({ title, text: r.text, model: `${r.model} · ${r.messages_used} messages from this chat` }) }
    catch (e) { setAi({ title, error: (e as Error).message }) }
  }

  const otherTyping = typing[chat.id]
  const lastMine = [...list].reverse().find((m) => m.mine && !m.local)
  const isRequest = chat.state === 'request'
  const blocked = chat.blocked

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col"
      onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) startUpload([...e.dataTransfer.files]) }}>
      {/* header */}
      <header className="relative z-20 flex items-center gap-3 border-b border-line bg-white/50 px-4 py-3 backdrop-blur-xl">
        <button onClick={onBack} className="grid h-9 w-9 place-items-center rounded-full text-ink-2 hover:bg-ink/5 lg:hidden" aria-label="Back"><ArrowLeft size={18} /></button>
        <button onClick={() => setInfo(true)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Avatar name={chat.name} id={chat.avatar} group={chat.kind === 'group'} size={40} />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-medium text-ink">{chat.name}</span>
            <span className="block truncate text-[12px] text-mute">
              {otherTyping ? <span className="text-violet">typing…</span>
                : chat.kind === 'group' ? `${chat.member_count} members · tap for group info`
                  : chat.peer?.last_seen ? `last seen ${new Date(chat.peer.last_seen).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}` : chat.peer?.phone_pretty}
            </span>
          </span>
        </button>
        <AiMenu onRun={runAi} />
        {chat.kind === 'direct' && !blocked && (
          <>
            <button onClick={() => startCall(chat, false).catch((e) => toast(e.message, 'error'))} aria-label="Voice call" className="grid h-9 w-9 place-items-center rounded-full text-ink-2 transition hover:bg-ink/5 hover:text-ink"><Phone size={17} /></button>
            <button onClick={() => startCall(chat, true).catch((e) => toast(e.message, 'error'))} aria-label="Video call" className="grid h-9 w-9 place-items-center rounded-full text-ink-2 transition hover:bg-ink/5 hover:text-ink"><Video size={18} /></button>
          </>
        )}
        <button onClick={() => setInfo(true)} aria-label="Info" className="grid h-9 w-9 place-items-center rounded-full text-ink-2 transition hover:bg-ink/5 hover:text-ink"><Info size={17} /></button>
      </header>

      {chat.pinned && chat.pinned.length > 0 && (
        <div className="flex items-center gap-2 border-b border-line bg-[#fff8f0]/70 px-5 py-2 text-[12.5px] text-ink-2"><Pin size={13} className="text-[#f5a524]" />
          <span className="truncate">{chat.pinned[chat.pinned.length - 1].text || chat.pinned[chat.pinned.length - 1].attachment?.name}</span></div>
      )}

      {/* messages */}
      <div ref={scroller} onScroll={onScroll} className="scroll-quiet flex-1 overflow-y-auto px-3 py-4 sm:px-8">
        {hasMore && <div className="py-2 text-center text-[11.5px] text-mute">Scroll up for older messages</div>}
        {list.map((m, i) => {
          const prev = list[i - 1]
          const newDay = !prev || day(prev.created_at) !== day(m.created_at)
          const grouped = prev && !newDay && prev.sender_id === m.sender_id && prev.kind === m.kind && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000
          return (
            <div key={m.id}>
              {newDay && <div className="sticky top-0 z-[1] my-3 flex justify-center"><span className="rounded-full border border-line bg-white/85 px-3 py-1 text-[11px] text-mute backdrop-blur">{day(m.created_at)}</span></div>}
              <Bubble m={m} chat={chat} grouped={!!grouped} showStatus={m.id === lastMine?.id}
                onReply={() => { setReply(m); input.current?.focus() }} onEdit={() => { setEditing(m); setText(m.text); input.current?.focus() }}
                onForward={() => setForward(m)} onRetry={() => retry(chat.id, m)} meId={me?.id} />
            </div>
          )
        })}
        {pending.map((p) => (
          <div key={p.id} className="my-1 flex justify-end">
            <div className="w-[260px] rounded-2xl rounded-br-md bg-ink/85 p-3 text-white">
              <div className="flex items-center gap-2 text-[13px]"><Paperclip size={14} /><span className="truncate">{p.voice ? 'Voice message' : p.file.name}</span><span className="ml-auto text-[11px] text-white/60">{bytes(p.file.size)}</span></div>
              {p.error ? (
                <div className="mt-2 flex items-center gap-2 text-[12px] text-[#ffb4b4]">{p.error}
                  <button onClick={() => { setPending((s) => s.filter((x) => x.id !== p.id)); startUpload([p.file], p.voice, p.duration) }} className="ml-auto flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-white"><RotateCw size={11} /> Retry</button>
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/20"><motion.div className="h-full rounded-full bg-[linear-gradient(90deg,#ff8a5b,#a77bff,#5b8cff)]" animate={{ width: `${Math.max(3, p.progress * 100)}%` }} /></div>
                  <span className="font-mono text-[10.5px] tabular-nums text-white/70">{Math.round(p.progress * 100)}%</span>
                  <button onClick={() => p.ctrl.abort()} aria-label="Cancel upload" className="text-white/70 hover:text-white"><X size={13} /></button>
                </div>
              )}
            </div>
          </div>
        ))}
        {otherTyping && <div className="my-2 flex gap-1 pl-2">{[0, 1, 2].map((i) => <motion.span key={i} className="h-2 w-2 rounded-full bg-violet/60" animate={{ y: [0, -4, 0] }} transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.12 }} />)}</div>}
      </div>

      {/* composer */}
      {isRequest ? (
        <div className="border-t border-line bg-white/70 p-4 text-center">
          <div className="text-[13.5px] text-ink-2">{chat.name} isn’t in your contacts. Reply to accept, or:</div>
          <div className="mt-3 flex justify-center gap-2">
            <button onClick={() => mx.request(chat.id, 'accept').then(refreshChats)} className="rounded-full bg-ink px-4 py-2 text-[13px] text-white">Accept</button>
            <button onClick={() => mx.request(chat.id, 'reject').then(() => { refreshChats(); onBack() })} className="rounded-full border border-line px-4 py-2 text-[13px] text-ink-2">Delete request</button>
            <button onClick={() => mx.request(chat.id, 'block').then(() => { refreshChats(); onBack() })} className="rounded-full border border-rose/30 px-4 py-2 text-[13px] text-rose">Block</button>
          </div>
        </div>
      ) : blocked ? (
        <div className="border-t border-line bg-white/70 p-4 text-center text-[13px] text-mute">You blocked this contact. Unblock them in chat info to send messages.</div>
      ) : (
        <div className="border-t border-line bg-white/55 px-3 pb-3 pt-2 backdrop-blur-xl sm:px-6">
          <AnimatePresence>
            {(reply || editing) && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="mb-2 flex items-center gap-2 rounded-xl border-l-[3px] border-violet bg-violet/[.06] px-3 py-2 text-[12.5px]">
                  {editing ? <Pencil size={13} className="text-violet" /> : <CornerUpLeft size={13} className="text-violet" />}
                  <span className="min-w-0 flex-1 truncate"><b className="font-medium text-violet">{editing ? 'Editing' : reply!.sender_name}</b> <span className="text-ink-2">{(editing ?? reply)!.text || (editing ?? reply)!.attachment?.name}</span></span>
                  <button onClick={() => { setReply(null); if (editing) { setEditing(null); setText('') } }} aria-label="Cancel"><X size={14} className="text-mute" /></button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="flex items-end gap-2">
            <button onClick={() => fileInput.current?.click()} aria-label="Attach files" className="mb-1 grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-2 transition hover:bg-ink/5 hover:text-ink"><Paperclip size={19} /></button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) startUpload([...e.target.files]); e.target.value = '' }} />
            {mic.state === 'recording' ? (
              <div className="flex h-12 flex-1 items-center gap-3 rounded-[22px] border border-rose/30 bg-rose/[.05] px-4">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose" />
                <span className="font-mono text-[13px] tabular-nums text-ink">{(mic.elapsed / 1000).toFixed(1)}s</span>
                <span className="text-[12.5px] text-mute">Recording a voice message…</span>
              </div>
            ) : (
              <textarea ref={input} value={text} rows={1} placeholder={editing ? 'Edit your message' : 'Message'}
                onChange={(e) => { setText(e.target.value); sendTyping(chat.id) }}
                onPaste={(e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); startUpload(fs) } }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } if (e.key === 'Escape') { setReply(null); setEditing(null) } }}
                className="max-h-40 min-h-12 flex-1 resize-none rounded-[22px] border border-line bg-white px-4 py-3 text-[15px] leading-snug text-ink outline-none transition placeholder:text-faint focus:border-violet/40 focus:ring-4 focus:ring-violet/10"
                style={{ height: Math.min(160, 48 + Math.max(0, text.split('\n').length - 1) * 21) }} />
            )}
            {text.trim() ? (
              <button onClick={submit} aria-label="Send" className="mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink text-white shadow-[0_8px_20px_-8px_rgb(12_12_16/.6)] transition hover:scale-105"><SendHorizontal size={18} /></button>
            ) : (
              <button onClick={toggleVoice} aria-label={mic.state === 'recording' ? 'Send voice message' : 'Record voice message'}
                className={cx('mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full transition', mic.state === 'recording' ? 'bg-rose text-white' : 'bg-ink text-white hover:scale-105')}>
                {mic.state === 'recording' ? <Square size={15} fill="currentColor" /> : <Mic size={18} />}
              </button>
            )}
          </div>
        </div>
      )}

      {drag && <div className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-[28px] border-2 border-dashed border-violet/50 bg-violet/[.06] text-[15px] text-violet backdrop-blur-[2px]">Drop files to share with {chat.name}</div>}
      <ChatInfo chat={chat} open={info} onClose={() => setInfo(false)} onLeft={onBack} />
      <ForwardModal msg={forward} onClose={() => setForward(null)} />
      <Modal open={!!ai} onClose={() => setAi(null)} title={ai?.title ?? ''} wide>
        {!ai?.text && !ai?.error && <div className="flex items-center gap-2 py-6 text-[13.5px] text-mute"><Loader2 size={15} className="animate-spin" /> Aura is reading this chat (only this chat, only messages you can see)…</div>}
        {ai?.error && <div className="text-[13.5px] text-rose">{ai.error}</div>}
        {ai?.text && <><div className="prose-aura text-[14.5px]"><Markdown text={ai.text} /></div><div className="mt-4 text-[11.5px] text-mute">Only you can see this · {ai.model}</div></>}
      </Modal>
    </div>
  )
}

function AiMenu({ onRun }: { onRun: (a: 'summarize' | 'action_items' | 'translate' | 'explain', title: string, lang?: string) => void }) {
  const [open, setOpen] = useState(false)
  const items: [Parameters<typeof onRun>[0], string, string?][] = [['summarize', 'Summarise this chat'], ['action_items', 'Action items'], ['translate', 'Translate last message to Telugu', 'te'],
    ['translate', 'Translate last message to Hindi', 'hi'], ['translate', 'Translate last message to English', 'en'], ['explain', 'Explain the last message']]
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} aria-label="Ask Aura" className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-ink-2 transition hover:bg-violet/[.08] hover:text-violet">
        <Sparkles size={15} /><span className="hidden sm:inline">Ask Aura</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6 }} onMouseLeave={() => setOpen(false)}
            className="absolute right-0 top-11 z-30 w-[250px] rounded-2xl border border-line bg-paper p-1.5 shadow-float">
            {items.map(([a, t, l]) => <button key={t} onClick={() => { setOpen(false); onRun(a, t, l) }} className="block w-full rounded-xl px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-violet/[.07] hover:text-ink">{t}</button>)}
            <div className="px-3 pb-1.5 pt-1 text-[10.5px] leading-snug text-mute">Aura reads only this chat. The result is shown only to you.</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Status({ s }: { s?: Msg['status'] }) {
  if (s === 'sending') return <Clock size={12} className="opacity-70" />
  if (s === 'failed') return null
  if (s === 'read') return <CheckCheck size={14} className="text-sky" />
  if (s === 'delivered') return <CheckCheck size={14} className="opacity-70" />
  return <Check size={14} className="opacity-70" />
}

function Bubble({ m, chat, grouped, showStatus, onReply, onEdit, onForward, onRetry, meId }: {
  m: Msg; chat: ChatRec; grouped: boolean; showStatus: boolean; onReply: () => void; onEdit: () => void; onForward: () => void; onRetry: () => void; meId?: number
}) {
  const toast = useToast()
  const [menu, setMenu] = useState(false)
  const [react, setReact] = useState(false)
  if (m.kind === 'system') return <div className="my-2 text-center text-[11.5px] text-mute">{m.text}</div>
  if (m.kind === 'call') return (
    <div className="my-2 flex justify-center"><span className="flex items-center gap-2 rounded-full border border-line bg-white/80 px-3.5 py-1.5 text-[12px] text-ink-2">
      {m.text.toLowerCase().includes('video') ? <Video size={13} /> : <Phone size={13} />}{m.text} · {time(m.created_at)}</span></div>
  )
  const mine = m.mine
  const canEdit = mine && !m.deleted && !m.attachment && Date.now() - new Date(m.created_at).getTime() < 15 * 60_000
  const canDelete = mine || (chat.kind === 'group' && chat.role !== 'member')
  const canPin = chat.kind === 'direct' || chat.role !== 'member'
  const reactions = Object.entries(m.reactions)
  return (
    <motion.div layout="position" initial={m.local ? { opacity: 0, y: 8, scale: 0.98 } : false} animate={{ opacity: 1, y: 0, scale: 1 }}
      className={cx('group relative flex', mine ? 'justify-end' : 'justify-start', grouped ? 'mt-0.5' : 'mt-2.5')} onMouseLeave={() => { setMenu(false); setReact(false) }}>
      <div className={cx('relative max-w-[min(78%,560px)]', reactions.length > 0 && 'mb-3')}>
        {!mine && chat.kind === 'group' && !grouped && <div className="mb-0.5 ml-3 text-[11.5px] font-medium" style={{ color: `hsl(${(m.sender_id ?? 0) * 67 % 360} 60% 45%)` }}>{m.sender_name}</div>}
        <div className={cx('relative rounded-[20px] px-3.5 py-2 text-[14.5px] leading-relaxed shadow-[0_1px_2px_rgb(12_12_16/.05)]',
          mine ? 'bg-ink text-white' : 'border border-line bg-white text-ink', mine ? (grouped ? 'rounded-tr-md' : 'rounded-br-md') : (grouped ? 'rounded-tl-md' : 'rounded-bl-md'),
          m.status === 'failed' && 'opacity-60', m.pinned && 'ring-2 ring-[#f5a524]/40')}>
          {m.forwarded && <div className={cx('mb-0.5 flex items-center gap-1 text-[11px] italic', mine ? 'text-white/55' : 'text-mute')}><Forward size={11} /> Forwarded</div>}
          {m.reply_to && <div className={cx('mb-1.5 rounded-xl border-l-[3px] px-2.5 py-1 text-[12.5px]', mine ? 'border-white/50 bg-white/10' : 'border-violet bg-violet/[.06]')}>
            <div className={cx('font-medium', mine ? 'text-white/85' : 'text-violet')}>{m.reply_to.sender_name}</div><div className={cx('truncate', mine ? 'text-white/65' : 'text-ink-2')}>{m.reply_to.text}</div></div>}
          {m.deleted ? <span className={cx('italic', mine ? 'text-white/55' : 'text-mute')}>This message was deleted</span> : (
            <>
              {m.attachment && <div className={cx(m.text && 'mb-1.5', '-mx-1 mt-0.5')}><AttachmentView a={m.attachment} mine={mine} /></div>}
              {m.text && <span className="whitespace-pre-wrap break-words">{m.text}</span>}
            </>
          )}
          <span className={cx('float-right ml-3 mt-1.5 flex translate-y-0.5 items-center gap-1 text-[10.5px]', mine ? 'text-white/55' : 'text-mute')}>
            {m.edited && !m.deleted && 'edited'} {m.pinned && <Pin size={10} />} {time(m.created_at)} {mine && (showStatus || m.local || m.status === 'failed') && <Status s={m.status} />}
          </span>
        </div>
        {m.status === 'failed' && <button onClick={onRetry} className="mt-1 flex items-center gap-1 text-[11.5px] text-rose"><RotateCw size={11} /> Not sent: tap to retry</button>}
        {reactions.length > 0 && (
          <div className={cx('absolute -bottom-3 flex gap-0.5 rounded-full border border-line bg-white px-1.5 py-0.5 text-[12px] shadow-soft', mine ? 'right-3' : 'left-3')}>
            {reactions.map(([e, us]) => <button key={e} onClick={() => mx.react(m.id, us.includes(meId ?? -1) ? '' : e)} title={`${us.length}`}>{e}{us.length > 1 && <span className="ml-0.5 text-[10px] text-mute">{us.length}</span>}</button>)}
          </div>
        )}
        {/* actions */}
        {!m.local && !m.deleted && (
          <div className={cx('absolute top-1 z-10 flex gap-0.5 opacity-0 transition group-hover:opacity-100', mine ? '-left-[74px]' : '-right-[74px]')}>
            <button onClick={() => setReact(!react)} aria-label="React" className="grid h-7 w-7 place-items-center rounded-full bg-white text-mute shadow-soft hover:text-ink"><Smile size={14} /></button>
            <button onClick={onReply} aria-label="Reply" className="grid h-7 w-7 place-items-center rounded-full bg-white text-mute shadow-soft hover:text-ink"><CornerUpLeft size={14} /></button>
            <button onClick={() => setMenu(!menu)} aria-label="More" className="grid h-7 w-7 place-items-center rounded-full bg-white text-[15px] leading-none text-mute shadow-soft hover:text-ink">⋯</button>
          </div>
        )}
        <AnimatePresence>
          {react && (
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0 }}
              className={cx('absolute -top-11 z-20 flex gap-1 rounded-full border border-line bg-white p-1 shadow-float', mine ? 'right-0' : 'left-0')}>
              {EMOJI.map((e) => <button key={e} onClick={() => { mx.react(m.id, e); setReact(false) }} className="grid h-8 w-8 place-items-center rounded-full text-[18px] transition hover:scale-125 hover:bg-ink/5">{e}</button>)}
            </motion.div>
          )}
          {menu && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className={cx('absolute top-9 z-20 w-[170px] rounded-2xl border border-line bg-paper p-1.5 text-[13px] shadow-float', mine ? 'right-full mr-2' : 'left-full ml-2')}>
              {m.text && <MenuItem icon={Copy} label="Copy" onClick={() => { navigator.clipboard.writeText(m.text); toast('Copied') }} />}
              <MenuItem icon={Forward} label="Forward" onClick={onForward} />
              {canPin && <MenuItem icon={Pin} label={m.pinned ? 'Unpin' : 'Pin'} onClick={() => mx.pin(m.id, !m.pinned).catch((e) => toast(e.message, 'error'))} />}
              {canEdit && <MenuItem icon={Pencil} label="Edit" onClick={onEdit} />}
              {canDelete && <MenuItem icon={Trash2} label="Delete for everyone" danger onClick={() => mx.remove(m.id).catch((e) => toast(e.message, 'error'))} />}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Copy; label: string; onClick: () => void; danger?: boolean }) {
  return <button onClick={onClick} className={cx('flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition', danger ? 'text-rose hover:bg-rose/[.07]' : 'text-ink-2 hover:bg-ink/[.05] hover:text-ink')}><Icon size={14} />{label}</button>
}

function ForwardModal({ msg, onClose }: { msg: Msg | null; onClose: () => void }) {
  const { chats } = useMessenger()
  const toast = useToast()
  const [sel, setSel] = useState<string[]>([])
  return (
    <Modal open={!!msg} onClose={() => { setSel([]); onClose() }} title="Forward to…">
      <div className="max-h-[50vh] space-y-1 overflow-y-auto">
        {chats.filter((c) => c.state === 'active' && !c.blocked).map((c) => (
          <button key={c.id} onClick={() => setSel((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))}
            className={cx('flex w-full items-center gap-3 rounded-2xl p-2 text-left transition', sel.includes(c.id) ? 'bg-violet/[.08]' : 'hover:bg-ink/[.03]')}>
            <Avatar name={c.name} id={c.avatar} group={c.kind === 'group'} size={36} /><span className="flex-1 text-[14px] text-ink">{c.name}</span>
            <span className={cx('grid h-5 w-5 place-items-center rounded-full border', sel.includes(c.id) ? 'border-violet bg-violet text-white' : 'border-line-2')}>{sel.includes(c.id) && <Check size={12} />}</span>
          </button>
        ))}
      </div>
      <button disabled={!sel.length} onClick={async () => { try { await mx.forward(msg!.id, sel); toast(`Forwarded to ${sel.length} chat${sel.length > 1 ? 's' : ''}`) } catch (e) { toast((e as Error).message, 'error') } setSel([]); onClose() }}
        className="mt-4 w-full rounded-full bg-ink py-3 text-[14px] text-white disabled:opacity-40">Forward</button>
    </Modal>
  )
}
