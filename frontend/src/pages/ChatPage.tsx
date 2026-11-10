import { AnimatePresence, motion } from 'motion/react'
import { BookOpen, Code2, Globe, History, Languages, Plus } from 'lucide-react'
import { useCallback, useEffect, useState, type RefObject } from 'react'
import { Composer } from '../components/Composer'
import { HistoryDrawer } from '../components/HistoryDrawer'
import { Messages } from '../components/Messages'
import { Halo } from '../components/Halo'
import { Orb, type OrbMode } from '../components/Orb'
import { useAgent } from '../context/AgentContext'
import { useAuth } from '../context/AuthContext'
import { player } from '../services/player'
import { greeting } from '../utils/format'
import { API_BASE } from '../services/apiBase'
import { Command } from 'lucide-react'
import { useMotionValue, useSpring, useReducedMotion } from 'motion/react'

const SUGGESTIONS = [
  { t: 'Explain SVM from my PDF, with an example', tag: 'Your PDF', glyph: 'D', icon: BookOpen, tint: '#a77bff' },
  { t: 'PCA గురించి సులభంగా వివరించండి', tag: 'తెలుగు', glyph: 'తె', icon: Languages, tint: '#ff7a4d' },
  { t: 'मुझे linear regression का python code दिखाओ', tag: 'हिन्दी · code', glyph: 'हि', icon: Code2, tint: '#4f7dff' },
  { t: 'Who built the Taj Mahal?', tag: 'Wikipedia', glyph: 'W', icon: Globe, tint: '#2fbf8f' },
]
const SAY = ['తెలుగు', 'हिन्दी', 'English', 'தமிழ்', 'ಕನ್ನಡ', 'മലയാളം', 'বাংলা', 'ગુજરાતી']

/** "Ask in <language> — I'll answer in it, out loud." with the language morphing letter by letter. */
function KineticLanguage() {
  const [i, setI] = useState(0)
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % SAY.length), 2400); return () => clearInterval(t) }, [])
  const word = SAY[i]
  return (
    <span className="relative inline-grid h-[1.35em] min-w-[4.6em] place-items-center overflow-hidden align-[-0.38em]">
      <AnimatePresence mode="popLayout">
        <motion.span key={word} className="hero-name col-start-1 row-start-1 whitespace-nowrap px-1 font-semibold"
          initial={{ y: '90%', opacity: 0, filter: 'blur(8px)', rotateX: -70 }} animate={{ y: 0, opacity: 1, filter: 'blur(0px)', rotateX: 0 }}
          exit={{ y: '-90%', opacity: 0, filter: 'blur(8px)', rotateX: 70 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
          {word}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

/** A suggestion card that tilts toward the cursor in 3D, with a refracting light (the "prism") under it. */
function PrismCard({ children, onClick, className }: { children: React.ReactNode; onClick: () => void; className: string }) {
  const reduce = useReducedMotion()
  const rx = useSpring(useMotionValue(0), { stiffness: 220, damping: 18 })
  const ry = useSpring(useMotionValue(0), { stiffness: 220, damping: 18 })
  const move = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height
    e.currentTarget.style.setProperty('--bx', `${e.clientX - r.left}px`); e.currentTarget.style.setProperty('--by', `${e.clientY - r.top}px`)
    e.currentTarget.style.setProperty('--px', `${px * 100}%`)
    if (!reduce) { rx.set((0.5 - py) * 14); ry.set((px - 0.5) * 16) }
  }
  return (
    <motion.button variants={{ h: { opacity: 0, y: 14, scale: 0.96 }, s: { opacity: 1, y: 0, scale: 1 } }} onClick={onClick} onMouseMove={move}
      onMouseLeave={() => { rx.set(0); ry.set(0) }} whileHover={{ y: -6, z: 30 }} whileTap={{ scale: 0.97 }}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 800 }} transition={{ type: 'spring', stiffness: 300, damping: 22 }}
      className={className + ' prism'}>
      {children}
    </motion.button>
  )
}

export function ChatPage() {
  const { messages, send, sendVoice, busy, newConversation, runs, activeRunId } = useAgent()
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => player.subscribe((s) => setSpeaking(s.playing)), [])
  const { user } = useAuth()
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState(false)
  const [micLevel, setMicLevel] = useState<RefObject<number> | null>(null)
  const onMicLevel = useCallback((l: RefObject<number> | null) => setMicLevel(l), [])
  const empty = messages.length === 0
  const lastFailed = activeRunId && runs[activeRunId]?.status === 'failed'
  const mode: OrbMode = micLevel ? 'listening' : speaking ? 'speaking' : busy ? 'thinking' : lastFailed ? 'error' : 'idle'
  const title = messages.find((m) => m.role === 'user')?.content
  const [vh, setVh] = useState(() => window.innerHeight)
  useEffect(() => { const r = () => setVh(window.innerHeight); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r) }, [])
  const orbSize = Math.max(96, Math.min(170, Math.round(vh * 0.17)))

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <header className="relative z-10 flex h-16 shrink-0 items-center gap-2 px-6">
        <button onClick={() => setHistory(true)} className="flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-ink/[.04]">
          <History size={15} strokeWidth={1.7} /> History
        </button>
        <AnimatePresence>
          {!empty && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex min-w-0 flex-1 items-center justify-center gap-3">
              <Orb size={22} mode={mode} level={micLevel ?? (speaking ? player.level : undefined)} />
              <span className="truncate font-serif text-[19px] text-ink">{title}</span>
            </motion.div>
          )}
        </AnimatePresence>
        <button onClick={() => window.dispatchEvent(new Event('aura:command'))} className={(empty ? 'ml-auto ' : '') + 'group hidden items-center gap-2 rounded-full border border-line bg-white/60 py-1.5 pl-3 pr-1.5 text-[12.5px] text-mute shadow-soft backdrop-blur transition hover:text-ink sm:flex'}>
          Search or jump anywhere <kbd className="flex items-center gap-0.5 rounded-full bg-ink/[.06] px-2 py-0.5 font-mono text-[10.5px] text-ink-2"><Command size={10} />K</kbd>
        </button>
        {!empty && (
          <button onClick={newConversation} className="ml-auto flex items-center gap-1.5 rounded-full border border-line bg-white/70 px-3 py-1.5 text-[13px] text-ink-2 shadow-soft transition hover:border-line-2 hover:text-ink">
            <Plus size={14} /> New
          </button>
        )}
      </header>

      <div className="scroll-quiet relative min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {empty ? (
            <motion.section key="hero" exit={{ opacity: 0, scale: 0.98, filter: 'blur(6px)' }} transition={{ duration: 0.35 }}
              className="flex min-h-full flex-col items-center justify-center px-6 pb-10 pt-2">
              <motion.div initial={{ opacity: 0, scale: 0.8, rotate: -8 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} transition={{ duration: 1.3, ease: [0.16, 1, 0.3, 1] }}
                className="[@media(max-height:760px)]:-mb-3">
                <Halo size={orbSize} mode={mode} level={micLevel ?? (speaking ? player.level : undefined)} onTalk={() => window.dispatchEvent(new Event('aura:talk'))} />
              </motion.div>
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}
                className="flex items-center gap-2 rounded-full border border-white/80 bg-white/70 px-3.5 py-1.5 text-[12px] font-medium text-ink-2 shadow-soft backdrop-blur">
                <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-coral opacity-70" /><span className="relative h-1.5 w-1.5 rounded-full bg-coral" /></span>
                Tap the orb to talk · tap a letter to choose your language
              </motion.div>
              <motion.h1 initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 1, ease: [0.16, 1, 0.3, 1] }}
                className="hero-title mt-6 text-center font-serif text-[clamp(38px,min(6.4vw,8.5vh),84px)] leading-[0.98] tracking-[-0.025em] text-ink">
                {greeting()}, <span className="hero-name italic">{user?.display_name}</span>.
              </motion.h1>
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.45, duration: 0.8 }}
                className="mt-3 text-center text-[clamp(15px,1.6vw,20px)] text-ink-2 [perspective:600px]">
                Ask in <KineticLanguage /> — I’ll answer in it, out loud, and show you every step.
              </motion.p>
              <motion.div initial="h" animate="s" variants={{ s: { transition: { staggerChildren: 0.07, delayChildren: 0.7 } } }}
                className="mt-7 grid w-full max-w-[880px] grid-cols-2 gap-3 lg:grid-cols-4 [@media(max-height:760px)]:mt-5">
                {SUGGESTIONS.map(({ t: s, tag, glyph, icon: Icon, tint }) => (
                  <PrismCard key={s} onClick={() => setDraft(s)}
                    className="bento glass flex min-h-[132px] flex-col rounded-[22px] border border-white/80 p-4 text-left shadow-soft [@media(max-height:760px)]:min-h-0 [@media(max-height:760px)]:p-3">
                    <span className="grid h-8 w-8 place-items-center rounded-xl text-white shadow-[0_8px_18px_-8px_currentColor]" style={{ background: tint, color: tint }}>
                      <Icon size={15} className="text-white" />
                    </span>
                    <span className="mt-3 text-[10px] font-semibold uppercase [@media(max-height:760px)]:mt-2 tracking-[0.16em]" style={{ color: tint }}>{tag}</span>
                    <span className="mt-1 text-[13px] leading-snug text-ink">{s}</span>
                    <span className="glyph" aria-hidden>{glyph}</span>
                  </PrismCard>
                ))}
              </motion.div>
            </motion.section>
          ) : (
            <motion.div key="thread" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><Messages onEdit={setDraft} /></motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="relative z-10 shrink-0 px-6 pb-6 pt-2">
        <div className="composer-fade pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-t from-paper/80 to-transparent" />
        <div className="mx-auto max-w-[720px]">
          <Composer onSend={send} onVoice={sendVoice} busy={busy} onMicLevel={onMicLevel} value={draft} setValue={setDraft} />
          <p className="mt-2.5 text-center text-[11px] text-faint">{API_BASE ? 'Your private Aura cloud' : 'Runs locally on your Mac'} · Enter to send · Shift + Enter for a new line · ⌘K to jump anywhere</p>
        </div>
      </div>
      <HistoryDrawer open={history} onClose={() => setHistory(false)} />
    </div>
  )
}
