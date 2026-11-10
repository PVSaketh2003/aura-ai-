import { motion } from 'motion/react'
import type { RefObject } from 'react'
import { cx } from '../utils/format'
import { useSpokenLanguage } from './LangPicker'
import { Orb, type OrbMode } from './Orb'

/** Each language's script, as it would be written on the ring. Tapping one makes it the spoken language. */
export const GLYPHS: [code: string, glyph: string, name: string][] = [
  ['te', 'తె', 'Telugu'], ['hi', 'हि', 'Hindi'], ['en', 'En', 'English'], ['ta', 'த', 'Tamil'], ['kn', 'ಕ', 'Kannada'],
  ['ml', 'മ', 'Malayalam'], ['mr', 'म', 'Marathi'], ['bn', 'বা', 'Bengali'], ['gu', 'ગુ', 'Gujarati'], ['pa', 'ਪੰ', 'Punjabi'],
  ['or', 'ଓ', 'Odia'], ['ur', 'ا', 'Urdu'],
]

/** The home-screen centrepiece: the living orb, two orbit tracks with travelling sparks, and a slowly turning ring of
 *  scripts. The ring is functional — it is a language picker. */
export function Halo({ size, mode, level, onTalk }: { size: number; mode: OrbMode; level?: RefObject<number>; onTalk: () => void }) {
  const [lang, setLang] = useSpokenLanguage()
  const R = size * 0.98 // glyph ring radius
  const box = R * 2 + 64
  return (
    <div className="relative" style={{ width: box, height: box }}>
      {/* orbit tracks */}
      <span className="halo-orbit" style={{ inset: 32 }} />
      <span className="halo-orbit" style={{ inset: 32 + R * 0.22, borderStyle: 'solid', borderColor: 'rgb(255 138 91 / .16)' }} />
      {/* sparks riding the tracks */}
      {[0, 1].map((i) => {
        const r = i === 0 ? R : R * 0.78
        return <span key={i} className="spark" style={{ left: box / 2, top: box / 2, offsetPath: `path("M ${-r} 0 a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0")`,
          animationDuration: i ? '13s' : '9s', animationDelay: i ? '-4s' : '0s', ...(i ? { background: 'radial-gradient(circle,#fff 0%,#5b8cff 45%,transparent 70%)', boxShadow: '0 0 14px 4px rgb(91 140 255 / .5)' } : {}) }} />
      })}

      {/* the orb itself */}
      <motion.button onClick={onTalk} aria-label="Tap to talk" whileHover={{ scale: 1.035 }} whileTap={{ scale: 0.96 }}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full outline-none" style={{ width: size, height: size }}>
        <Orb size={size} mode={mode} level={level} />
      </motion.button>

      {/* ring of scripts */}
      <div className="halo-ring" role="radiogroup" aria-label="Language you speak">
        {GLYPHS.map(([code, g, name], i) => {
          const a = (i / GLYPHS.length) * Math.PI * 2 - Math.PI / 2
          const x = box / 2 + Math.cos(a) * R, y = box / 2 + Math.sin(a) * R
          const on = lang === code
          return (
            <div key={code} className="absolute" style={{ left: x, top: y, transform: 'translate(-50%,-50%)' }}>
              <div className="halo-glyph-inner">
                <motion.button role="radio" aria-checked={on} title={`I speak ${name}`} onClick={() => setLang(on ? 'auto' : code)}
                  initial={{ opacity: 0, scale: 0.4 }} animate={{ opacity: 1, scale: on ? 1.18 : 1 }} transition={{ delay: 0.4 + i * 0.05, type: 'spring', stiffness: 260, damping: 18 }}
                  whileHover={{ scale: 1.25 }}
                  className={cx('grid h-11 w-11 place-items-center rounded-full border text-[17px] font-semibold transition-colors duration-300',
                    on ? 'border-transparent text-white shadow-[0_10px_24px_-8px_rgb(167_123_255/.9)]' : 'border-white/80 bg-white/70 text-ink-2 shadow-soft backdrop-blur hover:text-ink')}
                  style={on ? { background: 'linear-gradient(135deg,#ff7a4d,#b35cff 55%,#4f7dff)' } : undefined}>
                  {g}
                </motion.button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
