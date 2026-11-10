import { AnimatePresence, motion } from 'motion/react'
import { Check, Loader2, Mic, Pause, Play, RotateCcw, Sparkles, Square, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Orb } from './Orb'
import { useToast } from './ui'
import { useMicrophone } from '../hooks/useMicrophone'
import { api, type FreeSegment, type FreeSession, type FreeSummary } from '../services/api'
import { cx } from '../utils/format'

const LIMIT_MS = 5 * 60 * 1000
const LANG: Record<string, { name: string; color: string }> = {
  te: { name: 'తెలుగు', color: '#ff8a5b' }, hi: { name: 'हिन्दी', color: '#a77bff' }, en: { name: 'English', color: '#5b8cff' },
  ta: { name: 'தமிழ்', color: '#2fbf8f' }, kn: { name: 'ಕನ್ನಡ', color: '#f5a524' }, ml: { name: 'മലയാളം', color: '#e5484d' },
}
const lc = (l: string) => LANG[l]?.color ?? '#8a8a96'
const TOPICS = [
  'నీ గురించి చెప్పు — నీ పేరు, ఊరు, ఏం చేస్తావు',
  'Explain a project you are working on, in your own words',
  'अपने दिन के बारे में बताओ — सुबह से अभी तक',
  'మెషిన్ లెర్నింగ్ లో నీకు ఇష్టమైన టాపిక్ ఏమిటి?',
  'Mix languages the way you normally do — Aura follows every switch',
  'कोई ऐसा सवाल पूछो जो तुम Aura से अक्सर पूछोगे',
]
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
const t = (s: number) => clock(s * 1000)
const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const tone = (x: number | null | undefined) => (x == null ? 'text-mute' : x >= 0.85 ? 'text-mint' : x >= 0.65 ? 'text-[#f5a524]' : 'text-rose')

/** Talk freely: up to 5 minutes, any mix of languages. Aura splits the recording at pauses, detects the language of
 *  every utterance, transcribes it, and learns from the ones you confirm or correct. */
export function FreeTalk() {
  const mic = useMicrophone()
  const toast = useToast()
  const [sessions, setSessions] = useState<FreeSession[]>([])
  const [summary, setSummary] = useState<FreeSummary | null>(null)
  const [open, setOpen] = useState<FreeSession | null>(null)
  const [uploading, setUploading] = useState(false)
  const [topic, setTopic] = useState(0)
  const recording = mic.state === 'recording'
  const stopping = useRef(false)

  const loadList = useCallback(() => api.freeTalk().then((r) => { setSessions(r.sessions); setSummary(r.summary) })
    .catch((e) => toast((e as Error).message, 'error')), [toast])
  useEffect(() => { loadList() }, [loadList])
  useEffect(() => { if (mic.error) toast(mic.error, 'error') }, [mic.error, toast])
  // open the latest recording on first load
  useEffect(() => { if (!open && sessions[0]) api.freeTalkSession(sessions[0].id).then(setOpen).catch(() => {}) }, [sessions]) // eslint-disable-line react-hooks/exhaustive-deps

  // poll while Aura is still listening to the recording
  const busy = open && (open.status === 'queued' || open.status === 'processing')
  useEffect(() => {
    if (!busy || !open) return
    const id = setInterval(() => api.freeTalkSession(open.id).then((s) => { setOpen(s); if (s.status === 'done' || s.status === 'failed') loadList() }).catch(() => {}), 1500)
    return () => clearInterval(id)
  }, [busy, open?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!recording) return; const id = setInterval(() => setTopic((x) => (x + 1) % TOPICS.length), 9000); return () => clearInterval(id) }, [recording])

  const stop = useCallback(async () => {
    if (stopping.current) return
    stopping.current = true
    const blob = await mic.stop()
    const ms = mic.elapsed
    stopping.current = false
    if (!blob || ms < 5000) { toast('Talk for at least a few seconds.'); return }
    setUploading(true)
    try {
      const s = await api.freeTalkUpload(blob)
      setOpen({ ...s, segments: [] }); loadList()
    } catch (e) { toast((e as Error).message, 'error') }
    setUploading(false)
  }, [mic, toast, loadList])
  useEffect(() => { if (recording && mic.elapsed >= LIMIT_MS) stop() }, [recording, mic.elapsed, stop])

  const toggle = async () => {
    if (recording) return stop()
    api.warmSpeech().catch(() => {})
    await mic.start()
  }

  const updateSeg = (s: FreeSegment) => {
    setOpen((o) => (o ? { ...o, segments: o.segments?.map((x) => (x.id === s.id ? s : x)) } : o))
    api.freeTalk().then((r) => setSummary(r.summary)).catch(() => {})
  }
  const remove = async (id: string) => {
    try { await api.freeTalkDelete(id); if (open?.id === id) setOpen(null); loadList() } catch (e) { toast((e as Error).message, 'error') }
  }

  const progress = Math.min(1, mic.elapsed / LIMIT_MS)
  return (
    <div className="mt-6">
      <p className="max-w-[640px] text-[14px] leading-relaxed text-mute">
        Talk for up to 5 minutes about anything, in Telugu, Hindi, English, or all three mixed together. Aura splits the
        recording at your pauses, works out the language of every sentence and writes down what it heard. Fix anything it got
        wrong. Each fix teaches Aura your words and its usual mistakes on your voice, and is saved as a private training pair on this Mac.
      </p>

      {/* recorder */}
      <div className="spot-border relative mt-7 overflow-hidden rounded-[30px] border border-line bg-white/60 p-6 shadow-float backdrop-blur-xl sm:p-8">
        <div className="flex flex-col items-center">
          <button onClick={toggle} disabled={uploading || mic.state === 'requesting' || !!busy} aria-label={recording ? 'Stop' : 'Start talking'}
            className="relative grid h-[180px] w-[180px] place-items-center rounded-full disabled:opacity-50">
            <svg className="absolute inset-0 -rotate-90" viewBox="0 0 180 180">
              <defs><linearGradient id="ft-g" x1="0" x2="1"><stop offset="0" stopColor="#ff8a5b" /><stop offset=".5" stopColor="#a77bff" /><stop offset="1" stopColor="#5b8cff" /></linearGradient></defs>
              <circle cx="90" cy="90" r="84" fill="none" stroke="currentColor" strokeOpacity=".07" strokeWidth="5" className="text-ink" />
              <circle cx="90" cy="90" r="84" fill="none" stroke="url(#ft-g)" strokeWidth="5" strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 84} strokeDashoffset={2 * Math.PI * 84 * (1 - progress)} style={{ transition: 'stroke-dashoffset .3s linear' }} />
            </svg>
            <Orb size={150} mode={recording ? 'listening' : busy || uploading ? 'thinking' : 'idle'} level={mic.level} />
            <span className="absolute grid place-items-center text-white drop-shadow">
              {uploading ? <Loader2 size={30} className="animate-spin" /> : recording ? <Square size={26} fill="currentColor" /> : <Mic size={34} />}
            </span>
          </button>
          <div className="mt-4 font-mono text-[28px] tabular-nums text-ink">{clock(recording ? mic.elapsed : 0)}<span className="text-[15px] text-mute"> / 5:00</span></div>
          <div className="mt-1 text-[12.5px] text-mute">
            {recording ? 'Listening, tap to finish' : uploading ? 'Uploading…' : busy ? 'Aura is still listening to your last recording…' : 'Tap and start talking'}
          </div>
          <AnimatePresence mode="wait">
            {recording && (
              <motion.div key={topic} initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -8 }}
                className="mt-5 max-w-[560px] rounded-2xl border border-line bg-white/70 px-5 py-3 text-center text-[15px] text-ink-2">
                <span className="mr-2 text-[10px] font-medium uppercase tracking-[0.18em] text-mute">idea</span>{TOPICS[topic]}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {summary && summary.segments > 0 && <Learned s={summary} />}

      {/* the open recording */}
      {open && <SessionView s={open} onSeg={updateSeg} />}

      {sessions.length > 0 && (
        <>
          <div className="mt-10 text-[10.5px] font-medium uppercase tracking-[0.18em] text-mute">Your recordings</div>
          <div className="mt-3 flex flex-col gap-2">
            {sessions.map((s) => (
              <div key={s.id} className={cx('group flex items-center gap-3 rounded-2xl border p-3 transition', open?.id === s.id ? 'border-violet/40 bg-violet/[.07]' : 'border-line bg-white/40 hover:border-line-2')}>
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => api.freeTalkSession(s.id).then(setOpen)}>
                  <span className="font-mono text-[13px] tabular-nums text-ink">{t(s.seconds)}</span>
                  <span className="truncate text-[12.5px] text-mute">{new Date(s.created_at).toLocaleString()} · {s.done_segments} sentences · {s.verified} checked{s.status !== 'done' ? ` · ${s.status}` : ''}</span>
                </button>
                <ConfirmDelete onDelete={() => remove(s.id)} disabled={s.status === 'queued' || s.status === 'processing'} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ConfirmDelete({ onDelete, disabled }: { onDelete: () => void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => { if (!armed) return; const id = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(id) }, [armed])
  if (disabled) return null
  return armed
    ? <button onClick={onDelete} className="rounded-full bg-rose px-3 py-1 text-[11.5px] text-white">Delete recording</button>
    : <button onClick={() => setArmed(true)} aria-label="Delete" className="opacity-40 transition hover:opacity-100"><Trash2 size={14} className="text-mute hover:text-rose" /></button>
}

function Learned({ s }: { s: FreeSummary }) {
  const mix = Object.entries(s.language_mix)
  const total = mix.reduce((a, [, n]) => a + n, 0) || 1
  const vocab = Object.entries(s.vocabulary).flatMap(([l, ws]) => ws.slice(0, 10).map((w) => [l, w] as const))
  const fixes = Object.entries(s.corrections).flatMap(([l, rs]) => rs.slice(0, 8).map((r) => [l, r] as const))
  return (
    <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
      <div className="rounded-3xl border border-line bg-white/60 p-5">
        <div className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">Aura understands you</div>
        <div className={cx('mt-2 font-mono text-[40px] leading-none tabular-nums', tone(s.accuracy))}>{pct(s.accuracy)}</div>
        <div className="mt-2 text-[12px] leading-snug text-mute">
          {s.verified ? `measured on ${s.verified} sentence${s.verified === 1 ? '' : 's'} you checked (character accuracy)` : 'Check a few sentences below to measure this. Aura never guesses its own accuracy.'}
        </div>
        {Object.entries(s.per_language).length > 1 && (
          <div className="mt-3 flex flex-wrap gap-2">{Object.entries(s.per_language).map(([l, v]) => (
            <span key={l} className="rounded-full border border-line px-2.5 py-0.5 text-[11.5px]"><span style={{ color: lc(l) }}>{LANG[l]?.name ?? l}</span> <span className={tone(v.accuracy)}>{pct(v.accuracy)}</span></span>
          ))}</div>
        )}
      </div>
      <div className="rounded-3xl border border-line bg-white/60 p-5">
        <div className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">How you mix languages</div>
        <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-ink/[.05]">
          {mix.map(([l, n]) => <motion.div key={l} initial={{ width: 0 }} animate={{ width: `${(n / total) * 100}%` }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} style={{ background: lc(l) }} />)}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
          {mix.map(([l, n]) => <span key={l} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: lc(l) }} />{LANG[l]?.name ?? l} <span className="text-mute">{Math.round((n / total) * 100)}%</span></span>)}
        </div>
        <div className="mt-3 text-[12px] leading-snug text-mute">Used as a prior when Aura detects your language in Auto mode.</div>
      </div>
      <div className="rounded-3xl border border-line bg-white/60 p-5">
        <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute"><Sparkles size={12} /> What Aura learned</div>
        {!vocab.length && !fixes.length && <div className="mt-3 text-[12.5px] leading-snug text-mute">Correct a sentence and Aura remembers the words it missed and the mistake it made, then uses them in every later voice turn.</div>}
        {fixes.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{fixes.map(([l, r]) => (
          <span key={l + r.wrong} lang={l} className="rounded-full bg-ink/[.04] px-2.5 py-1 text-[12px]"><s className="text-mute">{r.wrong}</s> → <span className="text-ink">{r.right}</span>{r.times > 1 && <span className="ml-1 text-mute">×{r.times}</span>}</span>
        ))}</div>}
        {vocab.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{vocab.map(([l, w]) => (
          <span key={l + w} lang={l} className="rounded-full border px-2.5 py-0.5 text-[12px] text-ink-2" style={{ borderColor: lc(l) + '55' }}>{w}</span>
        ))}</div>}
      </div>
    </div>
  )
}

function SessionView({ s, onSeg }: { s: FreeSession; onSeg: (x: FreeSegment) => void }) {
  const segs = s.segments ?? []
  const busy = s.status === 'queued' || s.status === 'processing'
  const total = Math.max(1, s.total_segments)
  return (
    <div className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-mute">What Aura heard · {t(s.seconds)}</div>
        {s.status === 'done' && <div className="text-[12px] text-mute">{segs.filter((x) => x.verified).length} of {segs.length} checked. Check the ones that matter most first.</div>}
      </div>
      {busy && (
        <div className="mt-3 rounded-2xl border border-line bg-white/60 p-4">
          <div className="flex items-center gap-2 text-[13px] text-ink-2"><Loader2 size={14} className="animate-spin" />
            {s.total_segments ? `Detecting the language and transcribing sentence ${Math.min(segs.length + 1, total)} of ${total}…` : 'Finding the pauses in your recording…'}</div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/[.06]">
            <motion.div className="h-full bg-[linear-gradient(90deg,#ff8a5b,#a77bff,#5b8cff)]" animate={{ width: `${(segs.length / total) * 100}%` }} />
          </div>
        </div>
      )}
      {s.status === 'failed' && <div className="mt-3 rounded-2xl border border-rose/30 bg-rose/[.06] p-4 text-[13px] text-rose">{s.error || 'Processing failed.'}</div>}
      {segs.length > 0 && (
        <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-ink/[.04]">
          {segs.map((x) => <div key={x.id} title={`${t(x.start)} ${x.language_name}`} style={{ width: `${((x.end - x.start) / Math.max(1, s.seconds)) * 100}%`, marginLeft: 1, background: x.language_uncertain ? '#f5a524' : lc(x.language), opacity: x.verified ? 1 : 0.55 }} />)}
        </div>
      )}
      <div className="mt-4 flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {segs.map((x) => <Segment key={`${x.id}:${x.verified}:${x.corrected}:${x.language}`} x={x} onSaved={onSeg} />)}
        </AnimatePresence>
      </div>
    </div>
  )
}

function Segment({ x, onSaved }: { x: FreeSegment; onSaved: (s: FreeSegment) => void }) {
  const toast = useToast()
  const [text, setText] = useState(x.corrected || x.heard)
  const [lang, setLang] = useState(x.language)
  const [saving, setSaving] = useState(false)
  const [playing, setPlaying] = useState(false)
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => () => audio.current?.pause(), [])
  const edited = text.trim() !== (x.corrected || x.heard).trim() || lang !== x.language

  const play = () => {
    if (playing) { audio.current?.pause(); return }
    if (!audio.current) {
      audio.current = new Audio(api.freeTalkAudioUrl(x.id))
      audio.current.onended = audio.current.onpause = () => setPlaying(false)
    }
    audio.current.currentTime = 0
    audio.current.play().then(() => setPlaying(true)).catch(() => toast('Could not play this recording.', 'error'))
  }
  const save = async (body: Parameters<typeof api.freeTalkCorrect>[1]) => {
    setSaving(true)
    try { onSaved(await api.freeTalkCorrect(x.id, body)) } catch (e) { toast((e as Error).message, 'error') }
    setSaving(false)
  }

  return (
    <motion.div layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      className={cx('rounded-2xl border bg-white/60 p-4 transition', x.verified ? 'border-mint/40' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-mute">
        <button onClick={play} aria-label="Play" className="grid h-7 w-7 place-items-center rounded-full bg-ink text-white">{playing ? <Pause size={12} /> : <Play size={12} className="ml-0.5" />}</button>
        <span className="font-mono tabular-nums">{t(x.start)}–{t(x.end)}</span>
        {['te', 'hi', 'en'].concat(LANG[x.language] && !['te', 'hi', 'en'].includes(x.language) ? [x.language] : []).map((l) => (
          <button key={l} onClick={() => setLang(l)} className={cx('rounded-full border px-2 py-0.5 transition', lang === l ? 'text-white' : 'border-line text-mute hover:text-ink')}
            style={lang === l ? { background: lc(l), borderColor: lc(l) } : undefined}>{LANG[l]?.name ?? l}</button>
        ))}
        {x.language_uncertain ? <span className="text-[#c98a00]">language unclear: pick one</span>
          : x.language_probability != null && <span>{Math.round(x.language_probability * 100)}% sure</span>}
        {x.verified && <span className={cx('ml-auto font-mono text-[13px] tabular-nums', tone(x.accuracy))}>{pct(x.accuracy)} right</span>}
      </div>
      {x.heard || x.verified ? (
        <textarea lang={lang} value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(5, Math.max(1, Math.ceil(text.length / 70)))}
          className="mt-2 w-full resize-none rounded-xl border border-transparent bg-transparent px-2 py-1.5 text-[16px] leading-relaxed text-ink outline-none transition focus:border-line focus:bg-white" />
      ) : (
        <textarea lang={lang} value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Aura couldn’t make this out. Type what you said."
          className="mt-2 w-full resize-none rounded-xl border border-line bg-white px-2 py-1.5 text-[15px] text-ink outline-none" />
      )}
      {x.verified && x.corrected !== x.heard && x.heard && <div lang={x.language} className="px-2 text-[12px] text-mute">Aura heard: <s>{x.heard}</s></div>}
      <div className="mt-2 flex flex-wrap gap-2">
        {!x.verified && !edited && x.heard && (
          <button disabled={saving} onClick={() => save({ text: x.heard, language: lang })} className="flex items-center gap-1.5 rounded-full bg-mint px-3.5 py-1.5 text-[12.5px] text-white disabled:opacity-50"><Check size={13} /> That’s what I said</button>
        )}
        {edited && text.trim() && (
          <button disabled={saving} onClick={() => save({ text, language: lang })} className="flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] text-white disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save correction</button>
        )}
        {edited && <button onClick={() => { setText(x.corrected || x.heard); setLang(x.language) }} className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12.5px] text-ink-2"><RotateCcw size={12} /> Reset</button>}
        {x.verified && !edited && <button disabled={saving} onClick={() => save({ verified: false })} className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12.5px] text-mute hover:text-ink"><Undo2 size={12} /> Unmark</button>}
      </div>
    </motion.div>
  )
}
