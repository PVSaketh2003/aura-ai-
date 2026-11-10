import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { Eyebrow } from '../components/ui'

export function PageShell({ eyebrow, title, lede, children }: { eyebrow: string; title: ReactNode; lede: string; children: ReactNode }) {
  return (
    <div className="scroll-quiet relative h-full min-w-0 flex-1 overflow-y-auto">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="mx-auto max-w-[920px] px-8 pb-24 pt-16">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-3 font-serif text-[56px] leading-[1] tracking-[-0.02em] text-ink">{title}</h1>
        <p className="mt-4 max-w-[520px] text-[15px] leading-relaxed text-mute">{lede}</p>
        <div className="mt-14">{children}</div>
      </motion.div>
    </div>
  )
}

export function Pipeline({ stages }: { stages: { name: string; note: string; phase: number }[] }) {
  return (
    <ol className="relative">
      {stages.map((s, i) => (
        <motion.li key={s.name} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 + i * 0.06 }} className="relative flex gap-5 pb-7 last:pb-0">
          {i < stages.length - 1 && <span className="absolute left-[11.5px] top-7 bottom-0 w-px bg-[repeating-linear-gradient(to_bottom,var(--color-faint)_0_3px,transparent_3px_7px)]" />}
          <span className="relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line-2 bg-paper font-mono text-[10px] text-mute">{i + 1}</span>
          <div className="flex flex-1 items-baseline justify-between gap-6 border-b border-line pb-6">
            <div><div className="text-[15px] font-medium text-ink">{s.name}</div><div className="mt-1 text-[13px] text-mute">{s.note}</div></div>
            <span className="shrink-0 font-mono text-[11px] text-faint">phase {s.phase}</span>
          </div>
        </motion.li>
      ))}
    </ol>
  )
}
