import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from 'motion/react'
import { useRef } from 'react'
import { AudioLines, Brain, LibraryBig, LogOut, MessageCircle, MessagesSquare, Orbit, SlidersHorizontal } from 'lucide-react'
import { useMessenger } from '../context/MessengerContext'
import { NavLink } from 'react-router-dom'
import { useAgent } from '../context/AgentContext'
import { useAuth } from '../context/AuthContext'
import { cx } from '../utils/format'
import { StatusDot } from './ui'

const NAV = [
  { to: '/', icon: MessageCircle, label: 'Aura AI' },
  { to: '/messenger', icon: MessagesSquare, label: 'Messenger' },
  { to: '/library', icon: LibraryBig, label: 'Library' },
  { to: '/galaxy', icon: Orbit, label: 'Knowledge galaxy' },
  { to: '/memory', icon: Brain, label: 'Memory' },
  { to: '/voice', icon: AudioLines, label: 'Train my voice' },
  { to: '/settings', icon: SlidersHorizontal, label: 'Settings' },
]

export function Rail() {
  const { socket } = useAgent()
  const { user, logout } = useAuth()
  const { unreadTotal } = useMessenger()
  const mouseY = useMotionValue(Infinity)
  return (
    <nav className="glass spot spot-border relative z-20 m-3 flex w-[60px] shrink-0 flex-col items-center rounded-[22px] border border-line py-4 shadow-soft">
      <div className="mb-6 h-7 w-7 rounded-full bg-[radial-gradient(circle_at_35%_30%,#fff,#ffb08a_35%,#b98cff_70%,#6f9bff)] shadow-[0_4px_14px_-2px_rgb(167_123_255/.5)]" title="Aura" />
      <div className="flex flex-col gap-1.5" onMouseMove={(e) => mouseY.set(e.clientY)} onMouseLeave={() => mouseY.set(Infinity)}>
        {NAV.map(({ to, icon: Icon, label }) => (
          <DockItem key={to} mouseY={mouseY}>
          <NavLink to={to} end={to === '/'} className="group relative grid h-10 w-10 place-items-center rounded-xl" aria-label={label}>
            {({ isActive }) => (
              <>
                {isActive && <motion.span layoutId="rail-active" className="absolute inset-0 rounded-xl bg-ink shadow-[0_6px_16px_-6px_rgb(12_12_16/.5)]" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                <Icon size={18} strokeWidth={1.6} className={cx('relative transition-colors', isActive ? 'text-white' : 'text-mute group-hover:text-ink')} />
                {to === '/messenger' && unreadTotal > 0 && <span className="absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-paper bg-mint px-1 text-[9.5px] font-semibold text-white">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
                <span className="pointer-events-none absolute left-[52px] whitespace-nowrap rounded-lg bg-ink px-2.5 py-1 text-[12px] text-white opacity-0 shadow-float transition-all duration-150 group-hover:translate-x-1 group-hover:opacity-100">{label}</span>
              </>
            )}
          </NavLink>
          </DockItem>
        ))}
      </div>
      <div className="mt-auto flex flex-col items-center gap-4">
        <span title={`Live connection: ${socket}`} className="grid h-6 w-6 place-items-center">
          <StatusDot tone={socket === 'open' ? 'ok' : socket === 'connecting' ? 'warn' : 'down'} pulse={socket !== 'open'} />
        </span>
        <button onClick={logout} title={`Sign out ${user?.display_name ?? ''}`}
          className="group grid h-9 w-9 place-items-center rounded-full border border-line bg-white text-[12px] font-semibold text-ink-2 transition hover:border-line-2">
          <span className="group-hover:hidden">{(user?.display_name ?? '?').slice(0, 1).toUpperCase()}</span>
          <LogOut size={14} className="hidden text-mute group-hover:block" />
        </button>
      </div>
    </nav>
  )
}

/** Dock magnification: icons swell as the cursor approaches (like the macOS dock), springing back when it leaves. */
function DockItem({ mouseY, children }: { mouseY: MotionValue<number>; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const dist = useTransform(mouseY, (y) => {
    const r = ref.current?.getBoundingClientRect()
    return r ? y - (r.top + r.height / 2) : Infinity
  })
  const scale = useSpring(useTransform(dist, [-90, 0, 90], [1, reduce ? 1 : 1.32, 1]), { stiffness: 380, damping: 26, mass: 0.4 })
  const x = useSpring(useTransform(dist, [-90, 0, 90], [0, reduce ? 0 : 5, 0]), { stiffness: 380, damping: 26, mass: 0.4 })
  return <motion.div ref={ref} style={{ scale, x }} className="origin-left">{children}</motion.div>
}
