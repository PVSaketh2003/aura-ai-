import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, AudioLines, Bell, Brain, Command, FileCheck2, LibraryBig, LogOut, MessageCircle, MessagesSquare, MoreHorizontal,
  Orbit, PhoneMissed, RotateCcw, SlidersHorizontal, X,
} from 'lucide-react'
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useMessenger } from '../context/MessengerContext'
import { cx, relative } from '../utils/format'
import { useNotifications, type AuraNotification } from '../context/NotificationContext'

/* ---------------------------------------------------------------------------------------------- error boundary */
/** One failing page never takes the whole app down: the rest of Aura keeps working and the page can be retried. */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {  // remounted per route (keyed by path)
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[Aura] page crashed', error, info.componentStack) }
  render() {
    if (!this.state.error) return this.props.children
    const chunk = /Loading chunk|dynamically imported module|Failed to fetch/i.test(this.state.error.message)
    return (
      <div role="alert" className="grid h-full flex-1 place-items-center p-8">
        <div className="max-w-[420px] text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose/10 text-rose"><RotateCcw size={22} /></div>
          <h2 className="mt-5 font-serif text-[30px] leading-tight text-ink">{chunk ? 'A new version of Aura is available' : 'This page hit a snag'}</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-mute">
            {chunk ? 'Reload to get the latest version.' : 'The rest of Aura is still working. Try this page again; if it keeps happening, reload.'}
          </p>
          <div className="mt-6 flex justify-center gap-2">
            {!chunk && <button onClick={() => this.setState({ error: null })} className="rounded-full bg-ink px-4 py-2 text-[13px] text-white">Try again</button>}
            <button onClick={() => location.reload()} className="rounded-full border border-line bg-white/70 px-4 py-2 text-[13px] text-ink-2">Reload Aura</button>
          </div>
        </div>
      </div>
    )
  }
}

/* --------------------------------------------------------------------------------------------- page skeleton */
/** Shown while a page's code loads (pages are split into separate chunks). */
export function PageSkeleton() {
  return (
    <div className="flex h-full flex-1 flex-col gap-4 p-8" aria-busy="true" aria-label="Loading">
      <div className="h-3 w-24 animate-pulse rounded-full bg-ink/[.06]" />
      <div className="h-10 w-72 max-w-full animate-pulse rounded-2xl bg-ink/[.06]" />
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-28 animate-pulse rounded-3xl bg-white/60" style={{ animationDelay: `${i * 80}ms` }} />)}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------------------------- account menu */
export function AccountMenu({ placement = 'right' }: { placement?: 'right' | 'up' }) {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open])
  const name = user?.display_name ?? '?'
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${name}`}
        className="grid h-9 w-9 place-items-center rounded-full border border-line bg-white text-[12px] font-semibold text-ink-2 shadow-soft transition hover:border-line-2">
        {name.slice(0, 1).toUpperCase()}
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
            <motion.div role="menu" initial={{ opacity: 0, scale: 0.96, y: placement === 'up' ? 6 : 0, x: placement === 'right' ? -6 : 0 }}
              animate={{ opacity: 1, scale: 1, y: 0, x: 0 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ type: 'spring', stiffness: 500, damping: 36 }}
              className={cx('absolute z-50 w-[230px] rounded-2xl border border-line bg-paper p-1.5 shadow-float', placement === 'right' ? 'bottom-0 left-12' : 'bottom-12 right-0')}>
              <div className="px-3 pb-2 pt-1.5">
                <div className="truncate text-[14px] font-medium text-ink">{name}</div>
                <div className="truncate text-[11.5px] text-mute">{user?.username}</div>
              </div>
              <NavLink to="/settings" role="menuitem" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] text-ink-2 hover:bg-ink/[.04] hover:text-ink"><SlidersHorizontal size={14} /> Settings</NavLink>
              <button role="menuitem" onClick={() => { setOpen(false); window.dispatchEvent(new Event('aura:command')) }} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-ink/[.04] hover:text-ink">
                <Command size={14} /> Command bar <kbd className="ml-auto font-mono text-[10.5px] text-mute">⌘K</kbd></button>
              <div className="my-1 h-px bg-line" />
              <button role="menuitem" onClick={() => { setOpen(false); logout() }} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-rose hover:bg-rose/[.06]"><LogOut size={14} /> Sign out</button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

/* --------------------------------------------------------------------------------------------- mobile nav */
const PRIMARY = [
  { to: '/', icon: MessageCircle, label: 'Aura' },
  { to: '/messenger', icon: MessagesSquare, label: 'Chats' },
  { to: '/library', icon: LibraryBig, label: 'Library' },
  { to: '/memory', icon: Brain, label: 'Memory' },
]
const MORE = [
  { to: '/galaxy', icon: Orbit, label: 'Knowledge galaxy' },
  { to: '/voice', icon: AudioLines, label: 'Train my voice' },
  { to: '/settings', icon: SlidersHorizontal, label: 'Settings' },
]

/** Phones and small tablets: a bottom tab bar (the side rail is hidden below md). */
export function MobileNav() {
  const { unreadTotal } = useMessenger()
  const { logout } = useAuth()
  const [more, setMore] = useState(false)
  const { pathname } = useLocation()
  const moreActive = MORE.some((m) => pathname.startsWith(m.to))
  return (
    <>
      <nav aria-label="Main" className="glass fixed inset-x-3 bottom-3 z-30 flex items-center justify-around rounded-[22px] border border-line px-1 py-1.5 shadow-float md:hidden"
        style={{ paddingBottom: 'max(6px, env(safe-area-inset-bottom))' }}>
        {PRIMARY.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} end={to === '/'} className="relative flex min-w-[58px] flex-col items-center gap-0.5 rounded-xl px-2 py-1.5" aria-label={label}>
            {({ isActive }) => (
              <>
                {isActive && <motion.span layoutId="mnav" className="absolute inset-0 rounded-xl bg-ink" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                <Icon size={19} strokeWidth={1.7} className={cx('relative', isActive ? 'text-white' : 'text-ink-2')} />
                <span className={cx('relative text-[10px] font-medium', isActive ? 'text-white' : 'text-mute')}>{label}</span>
                {to === '/messenger' && unreadTotal > 0 && <span className="absolute right-2 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-mint px-1 text-[9px] font-semibold text-white">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
              </>
            )}
          </NavLink>
        ))}
        <button onClick={() => setMore(true)} aria-label="More" aria-expanded={more}
          className={cx('relative flex min-w-[58px] flex-col items-center gap-0.5 rounded-xl px-2 py-1.5', moreActive && 'bg-ink')}>
          <MoreHorizontal size={19} strokeWidth={1.7} className={moreActive ? 'text-white' : 'text-ink-2'} />
          <span className={cx('text-[10px] font-medium', moreActive ? 'text-white' : 'text-mute')}>More</span>
        </button>
      </nav>
      <AnimatePresence>
        {more && (
          <motion.div className="fixed inset-0 z-50 bg-ink/20 backdrop-blur-[2px] md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMore(false)}>
            <motion.div role="dialog" aria-label="More" onClick={(e) => e.stopPropagation()}
              initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 36 }}
              className="absolute inset-x-3 bottom-3 rounded-[26px] border border-line bg-paper p-3 shadow-float" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
              <div className="flex items-center justify-between px-2 pb-2"><span className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-mute">More</span>
                <button onClick={() => setMore(false)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-mute"><X size={16} /></button></div>
              {MORE.map(({ to, icon: Icon, label }) => (
                <NavLink key={to} to={to} onClick={() => setMore(false)} className={({ isActive }) => cx('flex items-center gap-3 rounded-2xl px-3 py-3 text-[15px]', isActive ? 'bg-ink text-white' : 'text-ink-2')}>
                  <Icon size={18} /> {label}
                </NavLink>
              ))}
              <NotificationsRow onOpen={() => setMore(false)} />
              <button onClick={() => { setMore(false); window.dispatchEvent(new Event('aura:command')) }} className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-[15px] text-ink-2"><Command size={18} /> Search everything</button>
              <button onClick={logout} className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-[15px] text-rose"><LogOut size={18} /> Sign out</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

/* ------------------------------------------------------------------------------------------ notifications */
export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const { items, unread, markAllRead, clear, markRead } = useNotifications()
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  useEffect(() => {
    const o = () => setOpen(true)
    window.addEventListener('aura:notifications', o)
    if (!open) return () => window.removeEventListener('aura:notifications', o)
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', k)
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('aura:notifications', o) }
  }, [open])
  const icon = (k: AuraNotification['kind']) => ({ document: <FileCheck2 size={15} className="text-mint" />, message: <MessagesSquare size={15} className="text-violet" />,
    call: <PhoneMissed size={15} className="text-rose" />, error: <AlertTriangle size={15} className="text-rose" /> }[k])
  return (
    <>
      {!compact && (
        <button onClick={() => setOpen(true)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
          className="relative grid h-9 w-9 place-items-center rounded-xl text-mute transition hover:bg-ink/[.05] hover:text-ink">
          <Bell size={17} strokeWidth={1.7} />
          {unread > 0 && <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-coral px-1 text-[9px] font-semibold text-white">{unread > 9 ? '9+' : unread}</span>}
        </button>
      )}
      <AnimatePresence>
        {open && (
          <motion.div className="fixed inset-0 z-[60] bg-ink/10" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)}>
            <motion.aside role="dialog" aria-label="Notifications" onClick={(e) => e.stopPropagation()}
              initial={{ x: -24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -24, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 36 }}
              className="absolute inset-y-3 left-3 flex w-[min(380px,calc(100vw-24px))] flex-col rounded-[26px] border border-line bg-paper shadow-float md:left-[84px]">
              <div className="flex items-center gap-2 px-5 pb-3 pt-5">
                <h2 className="font-serif text-[26px] leading-none text-ink">Notifications</h2>
                <button onClick={() => setOpen(false)} aria-label="Close" className="ml-auto grid h-8 w-8 place-items-center rounded-full text-mute hover:bg-ink/5"><X size={16} /></button>
              </div>
              {items.length > 0 && (
                <div className="flex gap-3 px-5 pb-2 text-[12px]">
                  <button onClick={markAllRead} disabled={!unread} className="text-violet disabled:text-faint">Mark all read</button>
                  <button onClick={clear} className="text-mute hover:text-ink">Clear</button>
                </div>
              )}
              <div className="scroll-quiet flex-1 overflow-y-auto px-2 pb-3">
                {items.length === 0 && (
                  <div className="px-6 py-16 text-center">
                    <Bell size={22} className="mx-auto text-faint" />
                    <p className="mt-3 text-[13px] leading-relaxed text-mute">Nothing yet. Finished documents, new messages and missed calls appear here.</p>
                  </div>
                )}
                {items.map((n) => (
                  <button key={n.id} onClick={() => { markRead(n.id); setOpen(false); if (n.href) nav(n.href) }}
                    className={cx('flex w-full gap-3 rounded-2xl px-3 py-3 text-left transition hover:bg-ink/[.04]', !n.read && 'bg-violet/[.05]')}>
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white shadow-soft">{icon(n.kind)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2"><span className="truncate text-[13.5px] font-medium text-ink">{n.title}</span>
                        <span className="ml-auto shrink-0 text-[10.5px] text-mute">{relative(new Date(n.at).toISOString())}</span></span>
                      <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-ink-2">{n.body}</span>
                    </span>
                    {!n.read && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-coral" aria-label="unread" />}
                  </button>
                ))}
              </div>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

/* ---------------------------------------------------------------------------------------- keyboard shortcuts */
const SHORTCUTS: [string, string][] = [
  ['⌘ K', 'Command bar: go anywhere, search everything'], ['g  c', 'Aura AI chat'], ['g  m', 'Messenger'], ['g  l', 'Library'],
  ['g  y', 'Memory'], ['g  k', 'Knowledge galaxy'], ['g  v', 'Train my voice'], ['g  s', 'Settings'], ['g  n', 'Notifications'], ['?', 'This help'],
]
const GO: Record<string, string> = { c: '/', m: '/messenger', l: '/library', y: '/memory', k: '/galaxy', v: '/voice', s: '/settings' }

/** Two-key navigation (g then a letter) and a "?" cheat sheet. Ignored while typing in a field. */
export function KeyboardShortcuts() {
  const nav = useNavigate()
  const [help, setHelp] = useState(false)
  useEffect(() => {
    let pending = 0
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')) return
      if (e.key === 'Escape') { setHelp(false); return }
      if (e.key === '?') { e.preventDefault(); setHelp((h) => !h); return }
      if (e.key === 'g') { pending = Date.now(); return }
      if (pending && Date.now() - pending < 1200) {
        pending = 0
        if (e.key === 'n') { window.dispatchEvent(new Event('aura:notifications')); return }
        if (GO[e.key]) { e.preventDefault(); nav(GO[e.key]) }
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [nav])
  return (
    <AnimatePresence>
      {help && (
        <motion.div className="fixed inset-0 z-[70] grid place-items-center bg-ink/15 p-4 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setHelp(false)}>
          <motion.div role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()} initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, opacity: 0 }}
            className="w-full max-w-[420px] rounded-[26px] border border-line bg-paper p-6 shadow-float">
            <div className="flex items-center"><h2 className="font-serif text-[26px] text-ink">Keyboard shortcuts</h2>
              <button onClick={() => setHelp(false)} aria-label="Close" className="ml-auto grid h-8 w-8 place-items-center rounded-full text-mute hover:bg-ink/5"><X size={16} /></button></div>
            <div className="mt-4 space-y-1.5">
              {SHORTCUTS.map(([keys, label]) => (
                <div key={keys} className="flex items-center gap-3 text-[13.5px] text-ink-2">
                  <span className="flex gap-1">{keys.split('  ').map((x) => <kbd key={x} className="min-w-7 rounded-lg border border-line bg-white px-2 py-0.5 text-center font-mono text-[11.5px] text-ink shadow-soft">{x}</kbd>)}</span>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function NotificationsRow({ onOpen }: { onOpen: () => void }) {
  const { unread } = useNotifications()
  return (
    <button onClick={() => { onOpen(); window.dispatchEvent(new Event('aura:notifications')) }} className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-[15px] text-ink-2">
      <Bell size={18} /> Notifications {unread > 0 && <span className="ml-auto rounded-full bg-coral px-2 text-[11px] font-semibold text-white">{unread}</span>}
    </button>
  )
}
