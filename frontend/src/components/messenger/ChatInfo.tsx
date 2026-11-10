import { AnimatePresence, motion } from 'motion/react'
import { Archive, BellOff, Camera, Check, Crown, Flag, LogOut, Search, Shield, ShieldOff, Trash2, UserPlus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useToast } from '../ui'
import { useMessenger } from '../../context/MessengerContext'
import { mx, upload, type ChatRec, type ContactRec } from '../../services/messenger'
import { cx } from '../../utils/format'
import { Avatar, Field, Modal } from './bits'

/** Slide-over with chat details. Every action is checked again by the backend; the UI only hides what can't work. */
export function ChatInfo({ chat, open, onClose, onLeft }: { chat: ChatRec; open: boolean; onClose: () => void; onLeft: () => void }) {
  const { refreshChats, me } = useMessenger()
  const toast = useToast()
  const [d, setD] = useState<ChatRec | null>(null)
  const [edit, setEdit] = useState(false)
  const [form, setForm] = useState({ name: '', description: '' })
  const [adding, setAdding] = useState(false)
  const [confirm, setConfirm] = useState<'' | 'leave' | 'delete' | 'report'>('')
  const reload = () => mx.chat(chat.id).then(setD).catch(() => {})
  useEffect(() => { if (open) reload() }, [open, chat.id, chat.last_seq]) // eslint-disable-line react-hooks/exhaustive-deps
  const admin = chat.kind === 'group' && (chat.role === 'owner' || chat.role === 'admin')
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast(ok); await reload(); await refreshChats() } catch (e) { toast((e as Error).message, 'error') } }

  const photo = (f: File) => act(async () => { const a = await upload(f); await mx.updateChat(chat.id, { avatar: a.id }) }, 'Group photo updated')

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-ink/10" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 36 }}
            className="scroll-quiet fixed inset-y-3 right-3 z-50 w-[min(380px,calc(100vw-24px))] overflow-y-auto rounded-[26px] border border-line bg-paper shadow-float">
            <div className="flex items-center justify-between px-5 pt-5"><span className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-mute">{chat.kind === 'group' ? 'Group info' : 'Contact info'}</span>
              <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-mute hover:bg-ink/5"><X size={16} /></button></div>
            <div className="flex flex-col items-center px-6 pb-5 pt-3 text-center">
              <label className={cx('relative', admin && 'cursor-pointer')}>
                <Avatar name={chat.name} id={d?.avatar ?? chat.avatar} group={chat.kind === 'group'} size={96} />
                {admin && <span className="absolute bottom-0 right-0 grid h-8 w-8 place-items-center rounded-full border-2 border-paper bg-ink text-white"><Camera size={14} /></span>}
                {admin && <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && photo(e.target.files[0])} />}
              </label>
              {edit ? (
                <div className="mt-4 w-full space-y-3 text-left">
                  <Field label="Group name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  <Field label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                  <div className="flex gap-2"><button onClick={() => act(() => mx.updateChat(chat.id, form), 'Saved').then(() => setEdit(false))} className="flex-1 rounded-full bg-ink py-2 text-[13px] text-white">Save</button>
                    <button onClick={() => setEdit(false)} className="rounded-full border border-line px-4 py-2 text-[13px] text-ink-2">Cancel</button></div>
                </div>
              ) : (
                <>
                  <div className="mt-3 font-serif text-[26px] leading-tight text-ink">{d?.name ?? chat.name}</div>
                  <div className="mt-1 text-[13px] text-mute">{chat.kind === 'group' ? `Group · ${d?.member_count ?? chat.member_count} members` : chat.peer?.phone_pretty}</div>
                  {(d?.description || chat.peer?.about) && <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">{d?.description || chat.peer?.about}</p>}
                  {admin && <button onClick={() => { setForm({ name: d?.name ?? chat.name, description: d?.description ?? '' }); setEdit(true) }} className="mt-3 text-[12.5px] text-violet">Edit name & description</button>}
                </>
              )}
            </div>

            <div className="space-y-1 border-t border-line px-3 py-3">
              <Row icon={BellOff} label={chat.muted ? 'Unmute notifications' : 'Mute notifications'} onClick={() => act(() => mx.updateChat(chat.id, { muted: !chat.muted }))} />
              <Row icon={Archive} label={chat.archived ? 'Unarchive chat' : 'Archive chat'} onClick={() => act(() => mx.updateChat(chat.id, { archived: !chat.archived }), chat.archived ? 'Unarchived' : 'Archived').then(onClose)} />
            </div>

            {chat.kind === 'group' && d?.members && (
              <div className="border-t border-line px-3 py-3">
                <div className="flex items-center justify-between px-2 pb-2"><span className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">{d.members.length} members</span>
                  {admin && <button onClick={() => setAdding(true)} className="flex items-center gap-1 text-[12.5px] text-violet"><UserPlus size={13} /> Add</button>}</div>
                {d.members.map((p) => (
                  <div key={p.id} className="group flex items-center gap-3 rounded-2xl px-2 py-2 hover:bg-ink/[.03]">
                    <Avatar name={p.name} id={p.avatar} size={36} />
                    <div className="min-w-0 flex-1"><div className="truncate text-[14px] text-ink">{p.me ? 'You' : p.name}</div><div className="truncate text-[11.5px] text-mute">{p.about || p.phone_pretty}</div></div>
                    {p.role !== 'member' && <span className="flex items-center gap-1 rounded-full bg-violet/10 px-2 py-0.5 text-[10.5px] text-violet">{p.role === 'owner' ? <Crown size={10} /> : <Shield size={10} />}{p.role}</span>}
                    {admin && !p.me && p.role !== 'owner' && (
                      <div className="hidden gap-1 group-hover:flex">
                        <button title={p.role === 'admin' ? 'Dismiss as admin' : 'Make admin'} onClick={() => act(() => mx.setRole(chat.id, p.id, p.role === 'admin' ? 'member' : 'admin'))} className="grid h-7 w-7 place-items-center rounded-full text-mute hover:bg-ink/5 hover:text-ink">{p.role === 'admin' ? <ShieldOff size={13} /> : <Shield size={13} />}</button>
                        {(chat.role === 'owner' || p.role === 'member') && <button title="Remove" onClick={() => act(() => mx.removeMember(chat.id, p.id), `Removed ${p.name}`)} className="grid h-7 w-7 place-items-center rounded-full text-mute hover:bg-rose/10 hover:text-rose"><X size={13} /></button>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1 border-t border-line px-3 py-3">
              {chat.kind === 'direct' && chat.peer && (
                <>
                  <Row icon={chat.blocked ? ShieldOff : Shield} label={chat.blocked ? `Unblock ${chat.name}` : `Block ${chat.name}`} danger={!chat.blocked}
                    onClick={() => act(() => (chat.blocked ? mx.unblock(chat.peer!.id) : mx.block(chat.peer!.id)), chat.blocked ? 'Unblocked' : 'Blocked')} />
                  <Row icon={Flag} label={`Report ${chat.name}`} danger onClick={() => setConfirm('report')} />
                </>
              )}
              {chat.kind === 'group' && <Row icon={LogOut} label="Leave group" danger onClick={() => setConfirm('leave')} />}
              {chat.kind === 'group' && chat.role === 'owner' && <Row icon={Trash2} label="Delete group for everyone" danger onClick={() => setConfirm('delete')} />}
            </div>
          </motion.aside>

          <AddMembers open={adding} chat={chat} existing={(d?.members ?? []).map((m) => m.id)} onClose={() => setAdding(false)} onDone={reload} />
          <Modal open={!!confirm} onClose={() => setConfirm('')} title={confirm === 'leave' ? 'Leave this group?' : confirm === 'delete' ? 'Delete this group?' : `Report ${chat.name}?`}>
            <p className="text-[13.5px] leading-relaxed text-ink-2">
              {confirm === 'leave' ? 'You’ll stop receiving its messages. An admin can add you back.' : confirm === 'delete' ? 'The group and all its messages are removed for every member. This can’t be undone.'
                : 'Aura records the report for this server’s owner and blocks this person for you.'}
            </p>
            <button onClick={async () => {
              const c = confirm; setConfirm('')
              if (c === 'leave') await act(() => mx.removeMember(chat.id, me!.id), 'You left the group')
              else if (c === 'delete') await act(() => mx.deleteGroup(chat.id), 'Group deleted')
              else await act(() => mx.report(chat.peer!.id, 'reported from chat', true), 'Reported and blocked')
              onClose(); if (c !== 'report') onLeft()
            }} className="mt-5 w-full rounded-full bg-rose py-3 text-[14px] text-white">{confirm === 'leave' ? 'Leave' : confirm === 'delete' ? 'Delete for everyone' : 'Report & block'}</button>
          </Modal>
        </>
      )}
    </AnimatePresence>
  )
}

function Row({ icon: Icon, label, onClick, danger }: { icon: typeof Archive; label: string; onClick: () => void; danger?: boolean }) {
  return <button onClick={onClick} className={cx('flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-[14px] transition', danger ? 'text-rose hover:bg-rose/[.06]' : 'text-ink-2 hover:bg-ink/[.04] hover:text-ink')}><Icon size={16} />{label}</button>
}

function AddMembers({ open, chat, existing, onClose, onDone }: { open: boolean; chat: ChatRec; existing: number[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [contacts, setContacts] = useState<ContactRec[]>([])
  const [sel, setSel] = useState<number[]>([])
  useEffect(() => { if (open) mx.contacts().then((r) => setContacts(r.contacts)) }, [open])
  const can = contacts.filter((c) => c.on_aura && c.user && !existing.includes(c.user.id) && !c.blocked)
  return (
    <Modal open={open} onClose={onClose} title="Add members">
      {can.length === 0 ? <p className="text-[13.5px] text-mute">Everyone in your contacts who is on Aura is already in this group.</p> : (
        <div className="max-h-[50vh] space-y-1 overflow-y-auto">
          {can.map((c) => <PickRow key={c.id} c={c} on={sel.includes(c.user!.id)} toggle={() => setSel((s) => (s.includes(c.user!.id) ? s.filter((x) => x !== c.user!.id) : [...s, c.user!.id]))} />)}
        </div>
      )}
      <button disabled={!sel.length} onClick={async () => { try { await mx.addMembers(chat.id, sel); toast('Members added') } catch (e) { toast((e as Error).message, 'error') } setSel([]); onDone(); onClose() }}
        className="mt-4 w-full rounded-full bg-ink py-3 text-[14px] text-white disabled:opacity-40">Add {sel.length || ''}</button>
    </Modal>
  )
}

export function PickRow({ c, on, toggle }: { c: ContactRec; on: boolean; toggle: () => void }) {
  return (
    <button onClick={toggle} className={cx('flex w-full items-center gap-3 rounded-2xl p-2 text-left transition', on ? 'bg-violet/[.08]' : 'hover:bg-ink/[.03]')}>
      <Avatar name={c.name} id={c.user?.avatar} size={38} />
      <span className="min-w-0 flex-1"><span className="block truncate text-[14px] text-ink">{c.name}</span><span className="block truncate text-[11.5px] text-mute">{c.phone_pretty}</span></span>
      <span className={cx('grid h-5 w-5 place-items-center rounded-full border transition', on ? 'border-violet bg-violet text-white' : 'border-line-2')}>{on && <Check size={12} />}</span>
    </button>
  )
}

/** Create Group: name + photo → pick contacts → review → create → open. */
export function NewGroup({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: ChatRec) => void }) {
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [contacts, setContacts] = useState<ContactRec[]>([])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<ContactRec[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { mx.contacts().then((r) => setContacts(r.contacts)); setStep(0); setName(''); setDesc(''); setPhoto(null); setSel([]); setQ('') } }, [open])
  const onAura = contacts.filter((c) => c.on_aura && c.user && !c.blocked && (!q || c.name.toLowerCase().includes(q.toLowerCase()) || c.phone.includes(q)))
  const notOnAura = contacts.filter((c) => !c.on_aura)
  const create = async () => {
    setBusy(true)
    try {
      const avatar = photo ? (await upload(photo)).id : undefined
      onCreated(await mx.group({ name, description: desc, member_ids: sel.map((c) => c.user!.id), avatar }))
      onClose()
    } catch (e) { toast((e as Error).message, 'error') }
    setBusy(false)
  }
  return (
    <Modal open={open} onClose={onClose} title={['New group', 'Add people', 'Review'][step]} wide>
      <div className="mb-5 flex gap-1.5">{[0, 1, 2].map((i) => <span key={i} className={cx('h-1 flex-1 rounded-full transition', i <= step ? 'bg-[linear-gradient(90deg,#ff8a5b,#a77bff)]' : 'bg-ink/[.08]')} />)}</div>
      {step === 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <label className="relative cursor-pointer">
              {photo ? <img src={URL.createObjectURL(photo)} alt="" className="h-20 w-20 rounded-[30%] object-cover" /> : <span className="grid h-20 w-20 place-items-center rounded-[30%] border-2 border-dashed border-line-2 text-mute"><Camera size={22} /></span>}
              <input type="file" accept="image/*" hidden onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
            </label>
            <div className="flex-1"><Field label="Group name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="ML study group" maxLength={80} /></div>
          </div>
          <Field label="Description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What's this group for?" />
          <button disabled={!name.trim()} onClick={() => setStep(1)} className="w-full rounded-full bg-ink py-3 text-[14px] text-white disabled:opacity-40">Next: add people</button>
        </div>
      )}
      {step === 1 && (
        <div>
          {sel.length > 0 && <div className="mb-3 flex flex-wrap gap-1.5">{sel.map((c) => <button key={c.id} onClick={() => setSel((s) => s.filter((x) => x.id !== c.id))} className="flex items-center gap-1.5 rounded-full bg-violet/10 py-1 pl-1 pr-2.5 text-[12.5px] text-violet"><Avatar name={c.name} size={20} />{c.name}<X size={11} /></button>)}</div>}
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-white px-3"><Search size={15} className="text-mute" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts" className="flex-1 py-2.5 text-[14px] outline-none" /></div>
          <div className="max-h-[42vh] space-y-1 overflow-y-auto">
            {onAura.map((c) => <PickRow key={c.id} c={c} on={sel.some((x) => x.id === c.id)} toggle={() => setSel((s) => (s.some((x) => x.id === c.id) ? s.filter((x) => x.id !== c.id) : [...s, c]))} />)}
            {onAura.length === 0 && <p className="px-2 py-4 text-[13px] text-mute">None of your contacts are on Aura yet. Add contacts by phone number first.</p>}
            {notOnAura.length > 0 && <p className="px-2 pt-3 text-[11.5px] leading-snug text-mute">{notOnAura.length} contact{notOnAura.length > 1 ? 's aren’t' : ' isn’t'} on Aura yet and can’t be added. Invite them from Contacts.</p>}
          </div>
          <div className="mt-4 flex gap-2"><button onClick={() => setStep(0)} className="rounded-full border border-line px-5 py-3 text-[14px] text-ink-2">Back</button>
            <button onClick={() => setStep(2)} className="flex-1 rounded-full bg-ink py-3 text-[14px] text-white">Review ({sel.length})</button></div>
        </div>
      )}
      {step === 2 && (
        <div>
          <div className="flex items-center gap-3 rounded-2xl border border-line bg-white p-3">
            {photo ? <img src={URL.createObjectURL(photo)} alt="" className="h-14 w-14 rounded-[30%] object-cover" /> : <Avatar name={name} group size={56} />}
            <div><div className="text-[16px] font-medium text-ink">{name}</div><div className="text-[12.5px] text-mute">{desc || 'No description'} · {sel.length + 1} members</div></div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2"><span className="flex items-center gap-1.5 rounded-full bg-ink/[.05] py-1 pl-1 pr-2.5 text-[12.5px]"><Crown size={12} className="ml-1 text-violet" />You (owner)</span>
            {sel.map((c) => <span key={c.id} className="flex items-center gap-1.5 rounded-full bg-ink/[.05] py-1 pl-1 pr-2.5 text-[12.5px]"><Avatar name={c.name} size={20} />{c.name}</span>)}</div>
          <div className="mt-5 flex gap-2"><button onClick={() => setStep(1)} className="rounded-full border border-line px-5 py-3 text-[14px] text-ink-2">Back</button>
            <button disabled={busy} onClick={create} className="flex-1 rounded-full bg-ink py-3 text-[14px] text-white disabled:opacity-50">{busy ? 'Creating…' : 'Create group'}</button></div>
        </div>
      )}
    </Modal>
  )
}
