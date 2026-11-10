import { motion } from 'motion/react'
import { ArrowDownLeft, ArrowUpRight, Bell, Check, Copy, MessageCircle, Phone, PhoneMissed, Search, ShieldCheck, Trash2, UserPlus, Video } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useToast } from '../ui'
import { useMessenger } from '../../context/MessengerContext'
import { attachmentUrl, mx, upload, type CallRec, type ChatRec, type ContactRec, type MediaItem, type Person } from '../../services/messenger'
import { bytes, cx, relative } from '../../utils/format'
import { Avatar, Field, Modal, PhoneInput, kindIcon } from './bits'

export function PanelTitle({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 px-5 pb-3 pt-5">
      <div><h2 className="font-serif text-[30px] leading-none tracking-[-0.01em] text-ink">{title}</h2>{sub && <p className="mt-1.5 text-[12.5px] text-mute">{sub}</p>}</div>
      {action}
    </div>
  )
}

/* -------------------------------------------------------------------------------------------------- contacts */
export function ContactsPanel({ onOpenChat }: { onOpenChat: (c: ChatRec) => void }) {
  const toast = useToast()
  const [list, setList] = useState<ContactRec[]>([])
  const [invite, setInvite] = useState('')
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ContactRec | null>(null)
  const load = () => mx.contacts().then((r) => { setList(r.contacts); setInvite(r.invite_text) }).catch((e) => toast(e.message, 'error'))
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = list.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.phone.includes(q.replace(/\s/g, '')))
  const open = async (c: ContactRec) => { try { onOpenChat(await mx.direct(c.user!.id)) } catch (e) { toast((e as Error).message, 'error') } }
  return (
    <div className="flex h-full flex-col">
      <PanelTitle title="Contacts" sub={`${list.filter((c) => c.on_aura).length} on Aura · ${list.length} saved`}
        action={<button onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[12.5px] text-white"><UserPlus size={14} /> Add</button>} />
      <SearchBox q={q} setQ={setQ} placeholder="Search name or number" />
      <div className="scroll-quiet flex-1 overflow-y-auto px-2 pb-4">
        {shown.map((c, i) => (
          <motion.div key={c.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.02 }}
            className="group flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-white/70">
            <Avatar name={c.name} id={c.user?.avatar} size={42} />
            <button onClick={() => setEditing(c)} className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[14.5px] text-ink">{c.name}</span>
              <span className="block truncate text-[12px] text-mute">{c.phone_pretty}{c.description && ` · ${c.description}`}</span>
            </button>
            {c.on_aura ? (
              c.blocked ? <span className="text-[11px] text-rose">blocked</span>
                : <button onClick={() => open(c)} className="flex items-center gap-1.5 rounded-full bg-mint/12 px-3 py-1.5 text-[12px] text-mint transition hover:bg-mint/20"><MessageCircle size={13} /> Chat</button>
            ) : (
              <button onClick={() => { navigator.clipboard.writeText(`${invite} ${location.origin}`); toast(`Invite copied: send it to ${c.name} your usual way`) }}
                title="Not on Aura yet" className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-mute transition hover:text-ink"><Copy size={12} /> Invite</button>
            )}
          </motion.div>
        ))}
        {list.length === 0 && <Empty icon={UserPlus} title="No contacts yet" text="Save people by their phone number. Those who use Aura can chat and call with you; others can be invited." />}
      </div>
      <AddContact open={adding} onClose={() => setAdding(false)} onSaved={load} />
      <EditContact c={editing} onClose={() => setEditing(null)} onSaved={load} />
    </div>
  )
}

function AddContact({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ name: '', phone: '', country: '+91', description: '' })
  const [found, setFound] = useState<{ on_aura: boolean; user?: Person } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setFound(null) }, [f.phone, f.country])
  const check = async () => { try { setFound(await mx.lookup(f.phone, f.country)) } catch (e) { toast((e as Error).message, 'error') } }
  const save = async () => {
    setBusy(true)
    try { await mx.addContact(f); toast(`${f.name} saved`); onSaved(); onClose(); setF({ name: '', phone: '', country: f.country, description: '' }) } catch (e) { toast((e as Error).message, 'error') }
    setBusy(false)
  }
  return (
    <Modal open={open} onClose={onClose} title="New contact">
      <div className="space-y-4">
        <Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus placeholder="Rahul" maxLength={80} />
        <PhoneInput country={f.country} setCountry={(country) => setF({ ...f, country })} value={f.phone} onChange={(phone) => setF({ ...f, phone })} />
        <Field label="Note (optional)" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="College friend" maxLength={200} />
        {found && (
          <div className={cx('flex items-center gap-3 rounded-2xl border p-3 text-[13px]', found.on_aura ? 'border-mint/30 bg-mint/[.06]' : 'border-line bg-white')}>
            {found.on_aura ? <><Avatar name={found.user!.display_name} size={34} /><span><b className="font-medium text-ink">{found.user!.display_name}</b> <span className="text-mute">is on Aura</span></span><ShieldCheck size={16} className="ml-auto text-mint" /></>
              : <span className="text-mute">This number isn’t on Aura (or doesn’t want to be found). You can still save it and invite them.</span>}
          </div>
        )}
        <div className="flex gap-2">
          <button onClick={check} disabled={!f.phone} className="rounded-full border border-line px-4 py-3 text-[13.5px] text-ink-2 disabled:opacity-40">Check on Aura</button>
          <button onClick={save} disabled={busy || !f.name.trim() || !f.phone} className="flex-1 rounded-full bg-ink py-3 text-[14px] text-white disabled:opacity-40">{busy ? 'Saving…' : 'Save contact'}</button>
        </div>
      </div>
    </Modal>
  )
}

function EditContact({ c, onClose, onSaved }: { c: ContactRec | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [armed, setArmed] = useState(false)
  useEffect(() => { if (c) { setName(c.name); setDesc(c.description); setArmed(false) } }, [c])
  if (!c) return null
  return (
    <Modal open={!!c} onClose={onClose} title="Edit contact">
      <div className="space-y-4">
        <div className="flex items-center gap-3"><Avatar name={c.name} id={c.user?.avatar} size={52} /><div><div className="text-[13px] text-mute">{c.phone_pretty}</div><div className="text-[12px] text-mute">{c.on_aura ? 'On Aura' : 'Not on Aura'}</div></div></div>
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="Note" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <div className="flex gap-2">
          <button onClick={async () => { if (!armed) return setArmed(true); await mx.deleteContact(c.id); toast('Contact deleted'); onSaved(); onClose() }}
            className={cx('flex items-center gap-1.5 rounded-full px-4 py-3 text-[13.5px] transition', armed ? 'bg-rose text-white' : 'border border-line text-rose')}><Trash2 size={14} />{armed ? 'Confirm delete' : 'Delete'}</button>
          <button onClick={async () => { await mx.updateContact(c.id, { name, description: desc }); toast('Saved'); onSaved(); onClose() }} className="flex-1 rounded-full bg-ink py-3 text-[14px] text-white">Save</button>
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------------------------------------------ calls */
export function CallsPanel({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const { chats, startCall, call } = useMessenger()
  const [calls, setCalls] = useState<CallRec[]>([])
  useEffect(() => { mx.calls().then((r) => setCalls(r.calls)).catch(() => {}) }, [call])
  const icon = (c: CallRec) => (c.state === 'missed' || c.state === 'declined') && !c.outgoing ? <PhoneMissed size={14} className="text-rose" />
    : c.outgoing ? <ArrowUpRight size={14} className={c.state === 'ended' ? 'text-mint' : 'text-mute'} /> : <ArrowDownLeft size={14} className="text-mint" />
  return (
    <div className="flex h-full flex-col">
      <PanelTitle title="Calls" sub="One-to-one voice and video, peer to peer (WebRTC)" />
      <div className="scroll-quiet flex-1 overflow-y-auto px-2 pb-4">
        {calls.map((c) => {
          const chat = chats.find((x) => x.id === c.chat_id)
          return (
            <div key={c.id} className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-white/70">
              <Avatar name={c.chat_name} size={42} />
              <button onClick={() => onOpenChat(c.chat_id)} className="min-w-0 flex-1 text-left">
                <span className={cx('block truncate text-[14.5px]', (c.state === 'missed' || c.state === 'declined') && !c.outgoing ? 'text-rose' : 'text-ink')}>{c.chat_name}</span>
                <span className="flex items-center gap-1.5 text-[12px] text-mute">{icon(c)}{c.state === 'ended' && c.duration != null ? `${Math.floor(c.duration / 60)}:${String(Math.round(c.duration % 60)).padStart(2, '0')}` : c.state} · {relative(c.created_at)}</span>
              </button>
              {chat && <button onClick={() => startCall(chat, c.video)} aria-label="Call back" className="grid h-9 w-9 place-items-center rounded-full text-mint hover:bg-mint/10">{c.video ? <Video size={17} /> : <Phone size={16} />}</button>}
            </div>
          )
        })}
        {calls.length === 0 && <Empty icon={Phone} title="No calls yet" text="Open a chat with someone and tap the phone or camera icon. Calls go directly between the two browsers." />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------------------------------ media & files */
const KINDS: [string, string][] = [['', 'All'], ['image', 'Images'], ['video', 'Videos'], ['pdf', 'PDFs'], ['document', 'Documents'], ['audio', 'Audio'], ['other', 'Other']]
export function MediaPanel({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const { chats } = useMessenger()
  const [kind, setKind] = useState('')
  const [chat, setChat] = useState('')
  const [items, setItems] = useState<MediaItem[]>([])
  useEffect(() => { mx.media(kind, chat).then((r) => setItems(r.items)).catch(() => {}) }, [kind, chat])
  const visual = items.filter((i) => i.attachment.kind === 'image' || i.attachment.kind === 'video')
  const files = items.filter((i) => !(i.attachment.kind === 'image' || i.attachment.kind === 'video'))
  return (
    <div className="flex h-full flex-col">
      <PanelTitle title="Media & files" sub={`${items.length} shared item${items.length === 1 ? '' : 's'}`} />
      <div className="flex flex-wrap gap-1.5 px-4 pb-2">
        {KINDS.map(([k, n]) => <button key={k} onClick={() => setKind(k)} className={cx('rounded-full px-3 py-1.5 text-[12px] transition', kind === k ? 'bg-ink text-white' : 'bg-white/60 text-ink-2 hover:bg-white')}>{n}</button>)}
      </div>
      <div className="px-4 pb-3"><select value={chat} onChange={(e) => setChat(e.target.value)} className="w-full rounded-xl border border-line bg-white px-3 py-2 text-[13px] text-ink-2 outline-none">
        <option value="">All chats & groups</option>{chats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="scroll-quiet flex-1 overflow-y-auto px-4 pb-4">
        {visual.length > 0 && <div className="grid grid-cols-3 gap-1.5">{visual.map((i) => (
          <button key={i.message_id} onClick={() => onOpenChat(i.chat_id)} title={`${i.chat_name} · ${i.sender_name}`} className="group relative aspect-square overflow-hidden rounded-xl bg-ink/5">
            {i.attachment.kind === 'image' ? <img src={attachmentUrl(i.attachment.id)} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
              : <video src={attachmentUrl(i.attachment.id)} preload="metadata" className="h-full w-full object-cover" />}
            {i.attachment.kind === 'video' && <span className="absolute bottom-1 right-1 rounded bg-ink/60 px-1 text-[10px] text-white">▶</span>}
          </button>
        ))}</div>}
        <div className="mt-3 space-y-1">{files.map((i) => (
          <div key={i.message_id} className="flex items-center gap-3 rounded-2xl px-2 py-2 transition hover:bg-white/70">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-white text-[18px] shadow-soft">{kindIcon(i.attachment.kind)}</span>
            <a href={attachmentUrl(i.attachment.id, i.attachment.kind !== 'pdf')} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] text-ink">{i.attachment.name}</span>
              <span className="block truncate text-[11.5px] text-mute">{bytes(i.attachment.size)} · {i.sender_name} · {relative(i.created_at)}</span>
            </a>
            <button onClick={() => onOpenChat(i.chat_id)} className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] text-mute hover:text-ink">{i.chat_name}</button>
          </div>
        ))}</div>
        {items.length === 0 && <Empty icon={Search} title="Nothing shared yet" text="Photos, videos, PDFs, documents and voice messages from your chats appear here." />}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------------------------------- settings */
export function SettingsPanel() {
  const { me, refreshMe } = useMessenger()
  const toast = useToast()
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [phone, setPhone] = useState('')
  const [country, setCountry] = useState('+91')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState('')
  const [blocked, setBlocked] = useState<Person[]>([])
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied')
  useEffect(() => { if (me) { setName(me.display_name); setAbout(me.about) } }, [me])
  useEffect(() => { mx.blocks().then((r) => setBlocked(r.blocked)).catch(() => {}) }, [])
  const save = async (b: Parameters<typeof mx.updateMe>[0], ok = 'Saved') => { try { await mx.updateMe(b); await refreshMe(); toast(ok) } catch (e) { toast((e as Error).message, 'error') } }
  if (!me) return null
  return (
    <div className="scroll-quiet h-full overflow-y-auto pb-8">
      <PanelTitle title="Messenger settings" />
      <div className="space-y-5 px-5">
        <section className="rounded-3xl border border-line bg-white/60 p-5">
          <div className="flex items-center gap-4">
            <label className="relative cursor-pointer"><Avatar name={me.display_name} id={me.avatar} size={64} />
              {me.verified && <input type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const a = await upload(f); await save({ avatar: a.id } as never, 'Photo updated') } }} />}</label>
            <div className="flex-1 space-y-3">
              <Field label="Display name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== me.display_name && save({ display_name: name })} />
              {me.verified && <Field label="About" value={about} onChange={(e) => setAbout(e.target.value)} onBlur={() => about !== me.about && save({ about })} maxLength={140} placeholder="Hey there! I'm using Aura." />}
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-line bg-white/60 p-5">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">Phone number</div>
          {me.verified && !sent ? (
            <div className="mt-2 flex items-center gap-2 text-[15px] text-ink">{me.phone_pretty}<span className="flex items-center gap-1 rounded-full bg-mint/12 px-2 py-0.5 text-[11px] text-mint"><ShieldCheck size={12} /> verified</span>
              <button onClick={() => setSent('change')} className="ml-auto text-[12.5px] text-violet">Change</button></div>
          ) : (
            <div className="mt-3 space-y-3">
              <p className="text-[12.5px] leading-relaxed text-mute">Verify your number so people who saved it can find and message you. Aura sends a one-time code by SMS.</p>
              {!me.sms_backend && <p className="rounded-xl bg-[#fff6e5] p-3 text-[12px] leading-relaxed text-[#9a6500]">SMS isn’t configured on this server yet. The owner sets SMS_BACKEND (Twilio Verify) in backend/.env. See README → Messenger.</p>}
              <PhoneInput country={country} setCountry={setCountry} value={phone} onChange={setPhone} />
              {sent && sent !== 'change' && <Field label="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoFocus />}
              {sent && sent !== 'change' && me.sms_backend === 'dev' && <p className="text-[11.5px] text-mute">Dev mode: the code is in backend/data/dev_sms_outbox/ on this Mac.</p>}
              <button disabled={!phone || !me.sms_backend} onClick={async () => {
                try {
                  if (!sent || sent === 'change') { const r = await mx.linkPhone(phone, undefined, country); setSent(r.phone); toast('Code sent') }
                  else { await mx.linkPhone(sent, code); await refreshMe(); setSent(''); setCode(''); toast('Number verified') }
                } catch (e) { toast((e as Error).message, 'error') }
              }} className="w-full rounded-full bg-ink py-3 text-[14px] text-white disabled:opacity-40">{sent && sent !== 'change' ? 'Verify' : 'Send code'}</button>
            </div>
          )}
        </section>

        {me.verified && (
          <section className="space-y-1 rounded-3xl border border-line bg-white/60 p-3">
            <div className="px-2 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">Privacy</div>
            <Toggle label="Let people find me by my number" on={me.discoverable} set={(v) => save({ discoverable: v })} />
            <Toggle label="Show when I was last online" on={me.show_last_seen} set={(v) => save({ show_last_seen: v })} />
            <Toggle label="Only my contacts can message me directly (others arrive as requests)" on={me.who_can_message === 'contacts'} set={(v) => save({ who_can_message: v ? 'contacts' : 'everyone' })} />
          </section>
        )}

        <section className="rounded-3xl border border-line bg-white/60 p-5">
          <div className="flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute"><Bell size={12} /> Notifications</div>
          <p className="mt-2 text-[12.5px] text-mute">Desktop notifications for new messages and calls while Aura is in the background.</p>
          {notif === 'granted' ? <div className="mt-3 flex items-center gap-1.5 text-[13px] text-mint"><Check size={14} /> On (mute individual chats from chat info)</div>
            : <button disabled={notif === 'denied'} onClick={() => Notification.requestPermission().then(setNotif)} className="mt-3 rounded-full border border-line px-4 py-2 text-[13px] text-ink-2 disabled:opacity-50">{notif === 'denied' ? 'Blocked in browser settings' : 'Turn on notifications'}</button>}
        </section>

        <section className="rounded-3xl border border-line bg-white/60 p-5">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">Blocked</div>
          {blocked.length === 0 ? <p className="mt-2 text-[13px] text-mute">Nobody.</p> : blocked.map((p) => (
            <div key={p.id} className="mt-2 flex items-center gap-3"><Avatar name={p.name} size={32} /><span className="flex-1 text-[14px]">{p.name}</span>
              <button onClick={async () => { await mx.unblock(p.id); setBlocked((b) => b.filter((x) => x.id !== p.id)) }} className="text-[12.5px] text-violet">Unblock</button></div>
          ))}
        </section>

        <section className="rounded-3xl border border-line bg-white/40 p-5 text-[12.5px] leading-relaxed text-mute">
          <div className="font-medium text-ink-2">How your messages are protected</div>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Messages and files are stored on this Aura server and shown only to members of each chat. Every request is checked by the server.</li>
            <li>In transit: encrypted with TLS when Aura is served over HTTPS. Calls use WebRTC, which always encrypts media (DTLS-SRTP) between the two browsers.</li>
            <li>Messages are <b className="font-medium">not end-to-end encrypted</b>: the server owner can technically read them.</li>
          </ul>
        </section>
      </div>
    </div>
  )
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button onClick={() => set(!on)} className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left text-[13.5px] text-ink-2 hover:bg-ink/[.03]">
      <span className="flex-1">{label}</span>
      <span className={cx('relative h-6 w-10 shrink-0 rounded-full transition', on ? 'bg-mint' : 'bg-ink/15')}><motion.span layout className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow', on ? 'right-0.5' : 'left-0.5')} /></span>
    </button>
  )
}

export function SearchBox({ q, setQ, placeholder }: { q: string; setQ: (s: string) => void; placeholder: string }) {
  return (
    <div className="px-4 pb-2"><div className="flex items-center gap-2 rounded-2xl border border-line bg-white/70 px-3 transition focus-within:border-violet/40 focus-within:bg-white">
      <Search size={15} className="text-mute" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="flex-1 bg-transparent py-2.5 text-[14px] outline-none placeholder:text-faint" />
    </div></div>
  )
}

export function Empty({ icon: Icon, title, text }: { icon: typeof Search; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center px-8 py-16 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white text-violet shadow-soft"><Icon size={22} /></span>
      <div className="mt-4 text-[15px] font-medium text-ink">{title}</div>
      <p className="mt-1.5 max-w-[280px] text-[12.5px] leading-relaxed text-mute">{text}</p>
    </div>
  )
}

export const useSorted = (chats: ChatRec[]) => useMemo(() => [...chats].sort((a, b) => b.last_message_at.localeCompare(a.last_message_at)), [chats])
