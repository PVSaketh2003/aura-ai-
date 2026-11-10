import { AnimatePresence, motion } from 'motion/react'
import { Suspense, useEffect } from 'react'
import { useLocation, useOutlet } from 'react-router-dom'
import { CommandBar } from '../components/CommandBar'
import { Constellation } from '../components/Constellation'
import { Rail } from '../components/Rail'
import { MobileNav, PageErrorBoundary, PageSkeleton } from '../components/Shell'
import { TracePanel } from '../components/TracePanel'

/** The background sky follows the time of day — dawn peach, bright day, golden dusk, lavender night (always light). */
function skyNow() {
  const h = new Date().getHours()
  return h >= 5 && h < 9 ? 'dawn' : h >= 9 && h < 16 ? 'day' : h >= 16 && h < 20 ? 'dusk' : 'night'
}

export function AppLayout() {
  const outlet = useOutlet()
  const { pathname } = useLocation()
  useEffect(() => {
    const set = () => { document.documentElement.dataset.sky = skyNow() }
    set()
    const t = setInterval(set, 5 * 60_000)
    return () => clearInterval(t)
  }, [])
  // cursor position for the glass "spotlight" (see .spot in index.css)
  useEffect(() => {
    const root = document.documentElement
    const move = (e: MouseEvent) => { root.style.setProperty('--mx', `${e.clientX}px`); root.style.setProperty('--my', `${e.clientY}px`) }
    window.addEventListener('mousemove', move, { passive: true })
    return () => window.removeEventListener('mousemove', move)
  }, [])
  return (
    <div className="relative z-10 flex h-full">
      <div className="field" aria-hidden><i className="c1" /><i className="c2" /><i className="c3" /><i className="c4" /></div>
      <Constellation />
      <Rail />
      <main className="relative z-10 flex min-w-0 flex-1 pb-[84px] md:pb-0">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={pathname} className="flex min-w-0 flex-1"
            initial={{ opacity: 0, scale: 0.985, filter: 'blur(10px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 1.01, filter: 'blur(8px)' }} transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}>
            <PageErrorBoundary>
              <Suspense fallback={<PageSkeleton />}>{outlet}</Suspense>
            </PageErrorBoundary>
          </motion.div>
        </AnimatePresence>
      </main>
      <TracePanel />
      <CommandBar />
      <MobileNav />
    </div>
  )
}
