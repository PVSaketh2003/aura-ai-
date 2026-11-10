import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ArrowRight, Check, Loader2, Mic, RotateCcw, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Orb } from '../components/Orb'
import { useToast } from '../components/ui'
import { useMicrophone } from '../hooks/useMicrophone'
import { api, type VoiceProfile, type VoiceSampleRec } from '../services/api'
import { cx } from '../utils/format'
import { FreeTalk } from '../components/FreeTalk'

const LANGS: [string, string, string][] = [['te', 'తెలుగు', 'Telugu'], ['hi', 'हिन्दी', 'Hindi'], ['en', 'English', 'English']]
const GOAL = 20

function Ring({ value, size = 120 }: { value: number; size?: number }) {
  const r = size / 2 - 7, c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} className="-rotate-90">
      <defs><linearGradient id="vt-g" x1="0" x2="1"><stop offset="0" stopColor="#ff8a5b" /><stop offset=".5" stopColor="#a77bff" /><stop offset="1" stopColor="#5b8cff" /></linearGradient></defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity=".08" strokeWidth="7" />
      <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#vt-g)" strokeWidth="7" strokeLinecap="round"
        strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - Math.min(1, value)) }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
    </svg>
  )
}

const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const tone = (x: number | null | undefined) => (x == null ? 'text-mute' : x >= 0.85 ? 'text-mint' : x >= 0.65 ? 'text-[#f5a524]' : 'text-rose')

/** "Train my voice": talk freely for up to 5 minutes in any mix of languages (default), or read set sentences.
 *  Either way Aura shows what it heard and how accurately, and keeps a private dataset for fine-tuning. */
export function VoiceTrainPage() {
  const [mode, setMode] = useState<'free' | 'read'>('free')
  return (
    <div className="scroll-quiet relative h-full min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[980px] px-4 pb-16 pt-10 sm:px-8">
        <div className="text-[10.5px] font-medium uppercase tracking-[0.22em] text-mute">Train my voice</div>
        <h1 className="hero-title mt-2 font-serif text-[clamp(34px,4.4vw,54px)] leading-[1.02] tracking-[-0.01em] text-ink">
          Teach Aura <span className="italic aura-text">how you speak</span>
        </h1>
        <div className="mt-6 inline-flex rounded-full border border-line bg-white/60 p-1">
          {([['free', 'Talk freely', 'up to 5 min, any language'], ['read', 'Read sentences', 'set prompts']] as const).map(([k, n, sub]) => (
            <button key={k} onClick={() => setMode(k)} className={cx('relative rounded-full px-4 py-2 text-[13px] transition', mode === k ? 'text-white' : 'text-ink-2 hover:text-ink')}>
              {mode === k && <motion.span layoutId="vt-mode" className="absolute inset-0 rounded-full bg-ink" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
              <span className="relative">{n}<span className={cx('ml-1.5 hidden text-[10.5px] sm:inline', mode === k ? 'opacity-60' : 'text-mute')}>{sub}</span></span>
            </button>
          ))}
        </div>
        {mode === 'free' ? <FreeTalk /> : <ReadSentences />}
      </div>
    </div>
  )
}

function ReadSentences() {
  const [profile, setProfile] = useState<VoiceProfile | null>(null)
  const [lang, setLang] = useState('te')
  const [idx, setIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<VoiceSampleRec | null>(null)
  const mic = useMicrophone()
  const toast = useToast()
  const recording = mic.state === 'recording'

  const load = useCallback(() => api.voiceProfile().then(setProfile).catch((e) => toast((e as Error).message, 'error')), [toast])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (mic.error) toast(mic.error, 'error') }, [mic.error, toast])

  const prompts = profile?.prompts[lang] ?? []
  const done = useMemo(() => new Map((profile?.samples ?? []).filter((s) => s.language === lang).map((s) => [s.index, s])), [profile, lang])
  const stats = profile?.stats[lang]
  // jump to the first sentence not yet recorded when switching language
  useEffect(() => { const first = prompts.findIndex((_, i) => !done.has(i)); setIdx(first === -1 ? 0 : first); setLast(null) }, [lang, profile === null]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async () => {
    if (!recording) { api.warmSpeech().catch(() => {}); setLast(null); await mic.start(); return }
    const blob = await mic.stop()
    if (!blob || mic.elapsed < 600) { toast('Too short — read the whole sentence.'); return }
    setBusy(true)
    try {
      const s = await api.voiceSample(blob, lang, idx)
      setLast(s); await load()
    } catch (e) { toast((e as Error).message, 'error') }
    setBusy(false)
  }
  const next = () => { const n = prompts.findIndex((_, i) => i > idx && !done.has(i)); setIdx(n === -1 ? Math.min(prompts.length - 1, idx + 1) : n); setLast(null) }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === ' ') { e.preventDefault(); if (!busy) toggle() }
      if (e.key === 'ArrowRight' && !recording) next()
      if (e.key === 'ArrowLeft' && !recording) { setIdx((i) => Math.max(0, i - 1)); setLast(null) }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const count = stats?.samples ?? 0
  return (
    <div>
        <p className="mt-3 max-w-[620px] text-[14px] leading-relaxed text-mute">
          Read each sentence naturally, in your own accent and dialect. Aura shows what it heard and how accurately.
          Your recordings become a private dataset to fine-tune speech recognition on your voice — they never leave this Mac.
        </p>

        {/* language + progress */}
        <div className="mt-8 flex flex-wrap items-center gap-6">
          <div className="flex rounded-full border border-line bg-white/60 p-1">
            {LANGS.map(([c, n, en]) => (
              <button key={c} onClick={() => setLang(c)} className={cx('relative rounded-full px-4 py-2 text-[13px] transition', lang === c ? 'text-white' : 'text-ink-2 hover:text-ink')}>
                {lang === c && <motion.span layoutId="vt-lang" className="absolute inset-0 rounded-full bg-ink" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
                <span className="relative">{n}<span className={cx('ml-1.5 text-[10.5px]', lang === c ? 'opacity-60' : 'text-mute')}>{en}</span></span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-4">
            <div className="relative grid place-items-center text-ink"><Ring value={count / GOAL} size={72} />
              <span className="absolute font-mono text-[12px] tabular-nums">{count}/{GOAL}</span></div>
            <div className="text-[12.5px] leading-relaxed text-mute">
              <div><span className="text-ink-2">{(stats?.seconds ?? 0).toFixed(0)}s</span> recorded</div>
              <div>Aura understands you: <span className={cx('font-medium', tone(stats?.accuracy))}>{pct(stats?.accuracy)}</span></div>
            </div>
          </div>
        </div>

        {/* the sentence */}
        <div className="spot-border relative mt-8 overflow-hidden rounded-[30px] border border-line bg-white/60 p-8 shadow-float backdrop-blur-xl">
          <div className="flex items-center justify-between text-[11.5px] text-mute">
            <span>Sentence {idx + 1} of {prompts.length}{done.has(idx) && <span className="ml-2 text-mint">· recorded</span>}</span>
            <span className="hidden sm:inline">Space to record · ← → to move</span>
          </div>
          <AnimatePresence mode="wait">
            <motion.p key={`${lang}-${idx}`} initial={{ opacity: 0, y: 12, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -12, filter: 'blur(6px)' }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }} lang={lang}
              className="mt-6 min-h-[2.6em] text-center font-serif text-[clamp(26px,3.2vw,40px)] leading-snug text-ink">
              {prompts[idx] ?? '…'}
            </motion.p>
          </AnimatePresence>

          <div className="mt-8 flex items-center justify-center gap-6">
            <button onClick={() => { setIdx((i) => Math.max(0, i - 1)); setLast(null) }} disabled={recording || idx === 0}
              className="grid h-11 w-11 place-items-center rounded-full border border-line text-ink-2 transition hover:text-ink disabled:opacity-30"><ArrowLeft size={17} /></button>
            <button onClick={toggle} disabled={busy || mic.state === 'requesting'} aria-label={recording ? 'Stop' : 'Record'}
              className="relative grid h-24 w-24 place-items-center rounded-full disabled:opacity-50">
              {recording ? <Orb size={96} mode="listening" level={mic.level} /> : (
                <>
                  <span className="absolute inset-0 animate-[spin_4s_linear_infinite] rounded-full bg-[conic-gradient(from_180deg,#ff8a5b,#a77bff,#5b8cff,#ff8a5b)] opacity-90" />
                  <span className="absolute inset-[3px] rounded-full bg-paper" />
                </>
              )}
              <span className="absolute grid place-items-center text-ink">
                {busy ? <Loader2 size={24} className="animate-spin" /> : recording ? <Square size={20} fill="currentColor" className="text-white drop-shadow" /> : <Mic size={26} />}
              </span>
            </button>
            <button onClick={next} disabled={recording}
              className="grid h-11 w-11 place-items-center rounded-full border border-line text-ink-2 transition hover:text-ink disabled:opacity-30"><ArrowRight size={17} /></button>
          </div>
          <div className="mt-3 text-center text-[12px] text-mute">{recording ? `Recording… ${(mic.elapsed / 1000).toFixed(1)}s — tap to stop` : busy ? 'Listening to how you said it…' : 'Tap to record this sentence'}</div>

          <AnimatePresence>
            {last && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-7 rounded-2xl border border-line bg-white/60 p-5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-mute">Aura heard</span>
                  <span className={cx('font-mono text-[20px] tabular-nums', tone(last.accuracy))}>{pct(last.accuracy)}</span>
                </div>
                <p lang={lang} className="mt-2 text-[17px] leading-relaxed text-ink-2">{last.heard || '—'}</p>
                <div className="mt-4 flex gap-2">
                  <button onClick={toggle} className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-[12.5px] text-ink-2 hover:text-ink"><RotateCcw size={13} /> Record again</button>
                  <button onClick={next} className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12.5px] text-white">Next <ArrowRight size={13} /></button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* all sentences */}
        <div className="mt-10 text-[10.5px] font-medium uppercase tracking-[0.18em] text-mute">Your recordings</div>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          {prompts.map((p, i) => {
            const s = done.get(i)
            return (
              <button key={i} onClick={() => { setIdx(i); setLast(s ?? null); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                className={cx('group flex items-start gap-3 rounded-2xl border p-3 text-left transition', i === idx ? 'border-violet/40 bg-violet/[.07]' : 'border-line bg-white/40 hover:border-line-2')}>
                <span className={cx('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10.5px]', s ? 'bg-mint/20 text-mint' : 'border border-dashed border-faint text-mute')}>
                  {s ? <Check size={12} strokeWidth={3} /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span lang={lang} className="block text-[13px] leading-snug text-ink-2">{p}</span>
                  {s && <span className="mt-1 block truncate text-[11.5px] text-mute">heard: {s.heard}</span>}
                </span>
                {s && <span className={cx('font-mono text-[11.5px] tabular-nums', tone(s.accuracy))}>{pct(s.accuracy)}</span>}
                {s && <span role="button" onClick={(e) => { e.stopPropagation(); api.deleteVoiceSample(s.id).then(load) }}
                  className="opacity-0 transition group-hover:opacity-100"><Trash2 size={13} className="text-mute hover:text-rose" /></span>}
              </button>
            )
          })}
        </div>

        <div className="mt-10 rounded-2xl border border-line bg-white/40 p-5 text-[13px] leading-relaxed text-mute">
          <div className="font-medium text-ink-2">What happens with these recordings</div>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Right away: the languages you train become a prior for language detection, and each sentence shows how well Aura understands you.</li>
            <li>Fine-tuning: with ~40+ recordings per language, run <code className="rounded bg-ink/[.06] px-1.5 py-0.5 font-mono text-[12px]">cd backend && .venv/bin/python ../scripts/finetune_voice.py</code> (backend stopped). Aura then uses the model trained on your voice automatically.</li>
            <li>Everything stays on this Mac{profile ? ` (${profile.dataset_dir})` : ''}.</li>
          </ul>
        </div>
    </div>
  )
}
