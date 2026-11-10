import { AnimatePresence, motion } from 'motion/react'
import { Archive, BellOff, Check, CheckCheck, FolderOpen, MessageCircle, Phone, Settings2, Sparkles, SquarePen, Users, UsersRound, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMessenger } from '../context/MessengerContext'
import { mx, type ChatRec } from '../services/messenger'
import { cx } from '../utils/format'
import { Avatar, kindIcon } from '../components/messenger/bits'
import { NewGroup } from '../components/messenger/ChatInfo'
import { Conversation } from '../components/messenger/Conversation'
import { CallsPanel, ContactsPanel, Empty, MediaPanel, PanelTitle, SearchBox, SettingsPanel } from '../components/messenger/Panels'

type Section = 'chats' | 'contacts' | 'groups' | 'calls' | 'media' | 'archived' | 'settings'
const NAV: [Section | 'aura', LucideIcon, string][] = [
  ['chats', MessageCircle, 'Chats'], ['aura', Sparkles, 'Aura AI'], ['contacts', Users, 'Contacts'], ['groups', UsersRound, 'Groups'],
  ['calls', Phone, 'Calls'], ['media', FolderOpen, 'Media & Files'], ['archived', Archive, 'Archived'], ['settings', Settings2, 'Settings'],
]

/** AURA MESSENGER — chats with people (direct + groups), calls, shared media; Aura AI stays one tap away. */
export function MessengerPage() {
  const { chats, setOpenChat, unreadTotal, me, refreshChats, socket } = useMessenger()
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const section = (params.get('s') as Section) || 'chats'
  const chatId = params.get('c')
  const [archived, setArchived] = useState<ChatRec[]>([])
  const [newGroup, setNewGroup] = useState(false)
  const go = (s: Section, c: string | null = null) => setParams((p) => { const n = new URLSearchParams(p); n.set('s', s); if (c) n.set('c', c); else n.delete('c'); return n })

  useEffect(() => { setOpenChat(chatId); return () => setOpenChat(null) }, [chatId, setOpenChat])
  useEffect(() => { if (section === 'archived') mx.chats(true).then((r) => setArchived(r.chats)).catch(() => {}) }, [section, chats])

  const all = useMemo(() => [...chats, ...archived.filter((a) => !chats.some((c) => c.id === a.id))], [chats, archived])
  const open = all.find((c) => c.id === chatId) ?? null
  const openId = (id: string) => go(section === 'calls' || section === 'media' || section === 'contacts' ? 'chats' : section, id)
  const openRec = (c: ChatRec) => { refreshChats().then(() => go('chats', c.id)) }

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      {/* AURA MESSENGER sub-navigation */}
      <aside className={cx('flex w-[64px] shrink-0 flex-col items-center gap-1 border-r border-line py-4 xl:w-[188px] xl:items-stretch xl:px-3', chatId && 'max-lg:hidden')}>
        <div className="mb-3 hidden px-2 xl:block"><div className="text-[9.5px] font-semibold uppercase tracking-[0.24em] text-mute">Aura</div><div className="font-serif text-[22px] leading-none text-ink">Messenger</div></div>
        {NAV.map(([id, Icon, label]) => {
          const active = section === id
          return (
            <button key={id} onClick={() => (id === 'aura' ? nav('/') : go(id))} title={label}
              className={cx('relative flex h-10 items-center gap-3 rounded-xl px-2.5 text-[13.5px] transition', active ? 'text-white' : 'text-ink-2 hover:bg-white/70 hover:text-ink')}>
              {active && <motion.span layoutId="mx-nav" className="absolute inset-0 rounded-xl bg-ink" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <Icon size={17} strokeWidth={1.7} className={cx('relative shrink-0', id === 'aura' && !active && 'text-violet')} />
              <span className="relative hidden xl:inline">{label}</span>
              {id === 'chats' && unreadTotal > 0 && <span className="relative ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-mint px-1 text-[10.5px] font-semibold text-white max-xl:absolute max-xl:-right-1 max-xl:-top-1">{unreadTotal}</span>}
            </button>
          )
        })}
        <div className="mt-auto hidden px-2 text-[10.5px] leading-snug text-mute xl:block">
          <span className={cx('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', socket === 'open' ? 'bg-mint' : 'bg-[#f5a524]')} />{socket === 'open' ? 'Live' : 'Reconnecting…'}
          {me && !me.verified && <button onClick={() => go('settings')} className="mt-2 block text-left text-violet">Verify your number so people can find you →</button>}
        </div>
      </aside>

      {/* list column */}
      <section className={cx('flex min-w-0 flex-1 flex-col border-r border-line bg-white/25 lg:w-[360px] lg:flex-none', chatId && 'max-lg:hidden')}>
        {section === 'chats' && <ChatList title="Chats" chats={chats} onOpen={(id) => go('chats', id)} active={chatId} onNewGroup={() => setNewGroup(true)} onContacts={() => go('contacts')} search />}
        {section === 'groups' && <ChatList title="Groups" chats={chats.filter((c) => c.kind === 'group')} onOpen={(id) => go('groups', id)} active={chatId} onNewGroup={() => setNewGroup(true)} groupsOnly />}
        {section === 'archived' && <ChatList title="Archived" chats={archived} onOpen={(id) => go('archived', id)} active={chatId} />}
        {section === 'contacts' && <ContactsPanel onOpenChat={openRec} />}
        {section === 'calls' && <CallsPanel onOpenChat={openId} />}
        {section === 'media' && <MediaPanel onOpenChat={openId} />}
        {section === 'settings' && <SettingsPanel />}
      </section>

      {/* conversation */}
      <main className={cx('relative min-w-0 flex-1', !chatId && 'max-lg:hidden')}>
        {open ? <Conversation key={open.id} chat={open} onBack={() => go(section)} /> : (
          <div className="grid h-full place-items-center p-8">
            <div className="max-w-[380px] text-center">
              <div className="mx-auto grid h-20 w-20 place-items-center rounded-[28px] bg-[conic-gradient(from_200deg,#ff8a5b,#a77bff,#5b8cff,#ff8a5b)] shadow-[0_18px_40px_-14px_rgb(167_123_255/.6)]">
                <MessageCircle size={32} className="text-white" />
              </div>
              <h2 className="mt-6 font-serif text-[34px] leading-tight text-ink">Talk to <span className="italic aura-text">your people</span>.</h2>
              <p className="mt-2 text-[13.5px] leading-relaxed text-mute">Chats, groups, calls and files with people you save by phone number. Tap <Sparkles size={12} className="inline text-violet" /> Ask Aura inside any chat to summarise or translate it, privately.</p>
              <div className="mt-6 flex justify-center gap-2">
                <button onClick={() => go('contacts')} className="rounded-full bg-ink px-4 py-2.5 text-[13px] text-white">Start a chat</button>
                <button onClick={() => setNewGroup(true)} className="rounded-full border border-line bg-white/70 px-4 py-2.5 text-[13px] text-ink-2">New group</button>
              </div>
            </div>
          </div>
        )}
      </main>
      <NewGroup open={newGroup} onClose={() => setNewGroup(false)} onCreated={(c) => { refreshChats(); go('groups', c.id) }} />
    </div>
  )
}

function preview(c: ChatRec) {
  const m = c.last_message
  if (!m) return c.kind === 'group' ? 'Group created' : 'Say hello 👋'
  if (m.deleted) return 'This message was deleted'
  const who = c.kind === 'group' && m.kind === 'text' ? `${m.mine ? 'You' : m.sender_name.split(' ')[0]}: ` : ''
  return who + (m.text || (m.attachment ? `${kindIcon(m.attachment.kind)} ${m.attachment.kind === 'voice' ? 'Voice message' : m.attachment.name}` : ''))
}
const when = (iso: string) => {
  const d = new Date(iso), now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (now.getTime() - d.getTime() < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

function ChatList({ title, chats, onOpen, active, onNewGroup, onContacts, search, groupsOnly }: {
  title: string; chats: ChatRec[]; onOpen: (id: string) => void; active: string | null; onNewGroup?: () => void; onContacts?: () => void; search?: boolean; groupsOnly?: boolean
}) {
  const { typing } = useMessenger()
  const [q, setQ] = useState('')
  const [res, setRes] = useState<Awaited<ReturnType<typeof mx.search>> | null>(null)
  const [filter, setFilter] = useState<'all' | 'unread' | 'requests'>('all')
  useEffect(() => {
    if (!search || q.trim().length < 2) { setRes(null); return }
    const t = setTimeout(() => mx.search(q.trim()).then(setRes).catch(() => {}), 220)
    return () => clearTimeout(t)
  }, [q, search])
  const requests = chats.filter((c) => c.state === 'request')
  const shown = chats.filter((c) => (filter === 'unread' ? c.unread > 0 : filter === 'requests' ? c.state === 'request' : true)).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="flex h-full flex-col">
      <PanelTitle title={title} action={onNewGroup && (
        <div className="flex gap-1">
          {onContacts && <button onClick={onContacts} title="New chat" className="grid h-9 w-9 place-items-center rounded-full text-ink-2 transition hover:bg-white hover:text-ink"><SquarePen size={17} /></button>}
          <button onClick={onNewGroup} title="New group" className="grid h-9 w-9 place-items-center rounded-full text-ink-2 transition hover:bg-white hover:text-ink"><UsersRound size={17} /></button>
        </div>
      )} />
      {search && <SearchBox q={q} setQ={setQ} placeholder="Search chats, people, messages, files" />}
      {search && !res && (
        <div className="flex gap-1.5 px-4 pb-2">
          {(['all', 'unread', 'requests'] as const).map((f) => (f !== 'requests' || requests.length > 0) && (
            <button key={f} onClick={() => setFilter(f)} className={cx('rounded-full px-3 py-1 text-[12px] capitalize transition', filter === f ? 'bg-ink text-white' : 'bg-white/60 text-ink-2 hover:bg-white')}>
              {f}{f === 'requests' && ` (${requests.length})`}</button>
          ))}
        </div>
      )}
      <div className="scroll-quiet flex-1 overflow-y-auto px-2 pb-4">
        {res ? <SearchResults res={res} onOpen={onOpen} /> : (
          <AnimatePresence initial={false}>
            {shown.map((c) => (
              <motion.button layout key={c.id} onClick={() => onOpen(c.id)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className={cx('flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition', active === c.id ? 'bg-white shadow-soft' : 'hover:bg-white/60')}>
                <Avatar name={c.name} id={c.avatar} group={c.kind === 'group'} size={46} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2"><span className="truncate text-[14.5px] font-medium text-ink">{c.name}</span>
                    <span className={cx('ml-auto shrink-0 text-[11px] tabular-nums', c.unread ? 'font-medium text-mint' : 'text-mute')}>{when(c.last_message_at)}</span></span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    {c.last_message?.mine && c.last_message.kind === 'text' && (c.last_message.status === 'read' ? <CheckCheck size={14} className="shrink-0 text-sky" /> : c.last_message.status === 'delivered' ? <CheckCheck size={14} className="shrink-0 text-mute" /> : <Check size={14} className="shrink-0 text-mute" />)}
                    <span className="truncate text-[12.5px] text-mute">{typing[c.id] ? <span className="text-violet">typing…</span> : c.state === 'request' ? <span className="text-[#c98a00]">Message request</span> : preview(c)}</span>
                    {c.muted && <BellOff size={12} className="ml-auto shrink-0 text-faint" />}
                    {c.unread > 0 && <span className={cx('grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 text-[10.5px] font-semibold text-white', c.muted ? 'bg-faint' : 'bg-mint', !c.muted && 'ml-auto')}>{c.unread}</span>}
                  </span>
                </span>
              </motion.button>
            ))}
          </AnimatePresence>
        )}
        {!res && shown.length === 0 && (groupsOnly ? <Empty icon={UsersRound} title="No groups yet" text="Create a group from your saved contacts. You'll be its owner and can add admins." />
          : <Empty icon={MessageCircle} title={filter === 'all' ? 'No chats yet' : `No ${filter} chats`} text="Save someone's phone number in Contacts, then start chatting." />)}
      </div>
    </div>
  )
}

function H({ t }: { t: string }) { return <div className="px-3 pb-1 pt-3 text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">{t}</div> }

function SearchResults({ res, onOpen }: { res: Awaited<ReturnType<typeof mx.search>>; onOpen: (id: string) => void }) {
  const none = !res.chats.length && !res.messages.length && !res.files.length && !res.contacts.length
  return (
    <div>
      {none && <p className="px-4 py-8 text-center text-[13px] text-mute">No matches.</p>}
      {res.chats.length > 0 && <H t="Chats" />}
      {res.chats.map((c) => <button key={c.id} onClick={() => onOpen(c.id)} className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-white/60"><Avatar name={c.name} id={c.avatar} group={c.kind === 'group'} size={36} /><span className="text-[14px]">{c.name}</span></button>)}
      {res.contacts.length > 0 && <H t="Contacts" />}
      {res.contacts.map((c) => <div key={c.id} className="flex items-center gap-3 rounded-2xl px-3 py-2"><Avatar name={c.name} size={36} /><span className="flex-1 text-[14px]">{c.name}</span><span className="text-[11.5px] text-mute">{c.on_aura ? 'on Aura' : c.phone_pretty}</span></div>)}
      {res.messages.length > 0 && <H t="Messages" />}
      {res.messages.map((m) => (
        <button key={m.id} onClick={() => onOpen(m.chat_id)} className="block w-full rounded-2xl px-3 py-2 text-left hover:bg-white/60">
          <div className="flex text-[12px] text-mute"><span className="truncate">{m.chat_name} · {m.sender_name}</span><span className="ml-auto shrink-0">{when(m.created_at)}</span></div>
          <div className="truncate text-[13.5px] text-ink-2">{m.text}</div>
        </button>
      ))}
      {res.files.length > 0 && <H t="Files" />}
      {res.files.map((f) => <button key={f.message_id} onClick={() => onOpen(f.chat_id)} className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-white/60"><span className="text-[18px]">{kindIcon(f.attachment.kind)}</span><span className="min-w-0 flex-1 truncate text-[13.5px]">{f.attachment.name}</span><span className="text-[11px] text-mute">{f.chat_name}</span></button>)}
    </div>
  )
}
