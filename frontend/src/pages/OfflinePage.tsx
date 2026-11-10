import { motion } from 'motion/react'
import { Orb } from '../components/Orb'

/** Shown on aura.pvsairamsaketh.in when the Aura server (the Mac) can't be reached. Checks again every 15 s and opens
 *  Aura by itself the moment the server is back: nothing to refresh. */
export function OfflinePage() {
  return (
    <div className="relative z-10 grid min-h-full place-items-center px-6 py-16 text-center">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }} className="max-w-[440px]">
        <div className="mb-10 flex justify-center"><Orb size={130} mode="idle" /></div>
        <h1 className="font-serif text-[48px] leading-none tracking-[-0.02em] text-ink">Aura is <span className="italic aura-text">resting</span>.</h1>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
          Aura runs privately on its owner’s Mac, and that Mac isn’t reachable right now. This page checks again by itself
          and opens Aura as soon as it’s back.
        </p>
        <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-line bg-white/70 px-4 py-2 text-[12.5px] text-mute shadow-soft">
          <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#f5a524] opacity-70" /><span className="relative h-2 w-2 rounded-full bg-[#f5a524]" /></span>
          Waiting for the Aura server…
        </div>
      </motion.div>
    </div>
  )
}
