import { motion, AnimatePresence } from 'motion/react'
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { cx } from '../utils/format'

export function StatusDot({ tone, pulse }: { tone: 'ok' | 'warn' | 'down' | 'idle'; pulse?: boolean }) {
  const c = { ok: 'bg-mint', warn: 'bg-coral', down: 'bg-rose', idle: 'bg-faint' }[tone]
  return (
    <span className="relative inline-flex h-2 w-2">
      {pulse && <span className={cx('absolute inline-flex h-full w-full animate-ping rounded-full opacity-50', c)} />}
      <span className={cx('relative inline-flex h-2 w-2 rounded-full', c)} />
    </span>
  )
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1.5 rounded-full border border-line bg-white/60 px-2.5 py-1 text-[11px] font-medium tracking-wide text-ink-2', className)}>{children}</span>
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-mute">{children}</div>
}

type Toast = { id: number; text: string; tone: 'info' | 'error' | 'success' }
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x, { id, text, tone }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 6000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-5 z-50 flex flex-col items-center gap-2 px-4">
        <AnimatePresence>
          {items.map((t) => (
            <motion.div key={t.id} layout initial={{ opacity: 0, y: -12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }} transition={{ type: 'spring', stiffness: 400, damping: 32 }}
              className="glass pointer-events-auto flex max-w-md items-start gap-3 rounded-2xl border border-line px-4 py-3 text-[13px] leading-relaxed text-ink-2 shadow-float">
              <StatusDot tone={t.tone === 'error' ? 'down' : t.tone === 'success' ? 'ok' : 'idle'} />
              <span className="-mt-[3px]">{t.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  )
}
