import { AnimatePresence, motion } from 'motion/react'
import { Check, Languages } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../services/api'
import { cx } from '../utils/format'

/** Spoken languages, written in their own script. "Auto" lets Aura detect it (restricted to Indian languages + English). */
export const SPOKEN: [string, string, string][] = [
  ['auto', 'Auto', 'Detect for me'], ['te', 'తెలుగు', 'Telugu'], ['hi', 'हिन्दी', 'Hindi'], ['en', 'English', 'English'],
  ['ta', 'தமிழ்', 'Tamil'], ['kn', 'ಕನ್ನಡ', 'Kannada'], ['ml', 'മലയാളം', 'Malayalam'], ['mr', 'मराठी', 'Marathi'],
  ['bn', 'বাংলা', 'Bengali'], ['gu', 'ગુજરાતી', 'Gujarati'], ['pa', 'ਪੰਜਾਬੀ', 'Punjabi'], ['ur', 'اردو', 'Urdu'],
  ['or', 'ଓଡ଼ିଆ', 'Odia'], ['as', 'অসমীয়া', 'Assamese'], ['sa', 'संस्कृतम्', 'Sanskrit'],
]

let cached: string | null = null
/** The language picked for the next voice turn ("auto" = detect). Sent with each recording so it is authoritative. */
export const spokenLanguage = () => cached ?? 'auto'
const subs = new Set<(v: string) => void>()

export function useSpokenLanguage(): [string, (v: string) => void] {
  const [v, setV] = useState(cached ?? 'auto')
  useEffect(() => {
    subs.add(setV)
    if (cached == null) api.preferences().then((p) => { cached = p.asr_language || 'auto'; subs.forEach((f) => f(cached!)) }).catch(() => {})
    return () => { subs.delete(setV) }
  }, [])
  const set = (x: string) => {
    cached = x; subs.forEach((f) => f(x))
    api.savePreferences({ asr_language: x }).catch(() => {})
  }
  return [v, set]
}

export function LangPicker({ dark = false, up = true }: { dark?: boolean; up?: boolean }) {
  const [lang, setLang] = useSpokenLanguage()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc) }
  }, [open])
  const cur = SPOKEN.find((s) => s[0] === lang) ?? SPOKEN[0]
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} title="The language you speak in"
        className={cx('flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition',
          dark ? 'border-white/15 bg-white/10 text-white hover:bg-white/15' : 'border-line bg-white/70 text-ink-2 hover:border-line-2 hover:text-ink')}>
        <Languages size={13} className={dark ? 'text-white/70' : 'text-violet'} />
        {cur[1]}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: up ? 6 : -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: up ? 6 : -6, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 500, damping: 34 }}
            className={cx('glass absolute right-0 z-50 w-[248px] rounded-2xl border border-line p-1.5 shadow-float', up ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]')}>
            <div className="px-2.5 pb-1.5 pt-1 text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">I’m speaking in</div>
            <div className="grid grid-cols-2 gap-0.5">
              {SPOKEN.map(([code, native, en]) => (
                <button key={code} onClick={() => { setLang(code); setOpen(false) }}
                  className={cx('flex items-center justify-between rounded-xl px-2.5 py-2 text-left transition', lang === code ? 'btn-aura text-white' : 'text-ink-2 hover:bg-ink/[.05]')}>
                  <span><span className="block text-[13px] leading-tight">{native}</span><span className={cx('block text-[10px]', lang === code ? 'text-white/60' : 'text-mute')}>{en}</span></span>
                  {lang === code && <Check size={12} />}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
