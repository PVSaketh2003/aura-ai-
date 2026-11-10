import { AnimatePresence, motion } from 'motion/react'
import { FileText, Mic, MicOff, Phone, PhoneOff, Video, VideoOff, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMessenger } from '../../context/MessengerContext'
import { attachmentUrl, type AttachmentRec } from '../../services/messenger'
import { bytes, cx } from '../../utils/format'

const GRADS = [['#ff8a5b', '#ffb36e'], ['#a77bff', '#c9a4ff'], ['#5b8cff', '#8fb2ff'], ['#2fbf8f', '#7fdcb9'], ['#f5a524', '#ffd27a'], ['#e5484d', '#ff8f93']]

export function Avatar({ name, id, size = 40, group = false, ring = false }: { name: string; id?: string; size?: number; group?: boolean; ring?: boolean }) {
  const [bad, setBad] = useState(false)
  const g = GRADS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % GRADS.length]
  const initials = name.replace(/\(.*?\)/g, '').split(/\s+/).map((w) => [...w].find((c) => /\p{L}|\p{N}/u.test(c)) ?? '').filter(Boolean).slice(0, 2).join('').toUpperCase() || '?'
  return (
    <span className={cx('relative grid shrink-0 place-items-center overflow-hidden text-white', group ? 'rounded-[30%]' : 'rounded-full', ring && 'ring-2 ring-white')}
      style={{ width: size, height: size, background: `linear-gradient(135deg,${g[0]},${g[1]})`, fontSize: size * 0.38 }}>
      {id && !bad ? <img src={attachmentUrl(id)} alt="" onError={() => setBad(true)} className="h-full w-full object-cover" /> : <span className="font-semibold tracking-tight">{initials}</span>}
    </span>
  )
}

export function Modal({ open, onClose, title, children, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 grid place-items-center bg-ink/20 p-4 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.div role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}
            initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.98 }} transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            className={cx('max-h-[88vh] w-full overflow-y-auto rounded-[26px] border border-line bg-paper p-6 shadow-float', wide ? 'max-w-[560px]' : 'max-w-[420px]')}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-serif text-[24px] leading-none text-ink">{title}</h2>
              <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-mute hover:bg-ink/5 hover:text-ink"><X size={16} /></button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function Field({ label, ...p }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">{label}</span>
      <input {...p} className={cx('mt-1.5 w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[14.5px] text-ink outline-none transition placeholder:text-faint focus:border-violet/50 focus:ring-4 focus:ring-violet/10', p.className)} />
    </label>
  )
}

export const COUNTRIES: [string, string][] = [['+91', '🇮🇳 India'], ['+1', '🇺🇸 US / Canada'], ['+44', '🇬🇧 UK'], ['+971', '🇦🇪 UAE'], ['+65', '🇸🇬 Singapore'], ['+61', '🇦🇺 Australia'], ['+49', '🇩🇪 Germany'], ['+966', '🇸🇦 Saudi Arabia']]

export function PhoneInput({ country, setCountry, value, onChange, autoFocus }: { country: string; setCountry: (c: string) => void; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="block">
      <span className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">Phone number</span>
      <div className="mt-1.5 flex overflow-hidden rounded-xl border border-line bg-white transition focus-within:border-violet/50 focus-within:ring-4 focus-within:ring-violet/10">
        <select value={country} onChange={(e) => setCountry(e.target.value)} className="border-r border-line bg-ink/[.02] px-2 text-[13.5px] text-ink-2 outline-none" aria-label="Country code">
          {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n.split(' ')[0]} {c}</option>)}
        </select>
        <input value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} inputMode="tel" placeholder="98765 43210"
          className="min-w-0 flex-1 px-3 py-2.5 text-[14.5px] text-ink outline-none placeholder:text-faint" />
      </div>
    </label>
  )
}

export const kindIcon = (k: AttachmentRec['kind']) => ({ pdf: '📄', image: '🖼', video: '🎬', audio: '🎵', voice: '🎤', document: '📝', other: '📎' }[k])

/** Inline preview of an attachment inside a message bubble. */
export function AttachmentView({ a, mine }: { a: AttachmentRec; mine: boolean }) {
  const url = attachmentUrl(a.id)
  if (a.kind === 'image') return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={a.name} loading="lazy" className="max-h-[320px] w-full max-w-[340px] rounded-2xl object-cover" /></a>
  if (a.kind === 'video') return <video src={url} controls preload="metadata" className="max-h-[320px] w-full max-w-[360px] rounded-2xl bg-ink" />
  if (a.kind === 'audio' || a.kind === 'voice') return <VoicePlayer url={url} duration={a.duration} mine={mine} voice={a.kind === 'voice'} name={a.name} />
  return (
    <a href={a.kind === 'pdf' ? url : attachmentUrl(a.id, true)} target="_blank" rel="noreferrer"
      className={cx('flex min-w-[240px] items-center gap-3 rounded-2xl border p-3 transition', mine ? 'border-white/20 bg-white/10 hover:bg-white/15' : 'border-line bg-white hover:border-line-2')}>
      <span className={cx('grid h-11 w-9 place-items-center rounded-lg text-[10px] font-bold', a.kind === 'pdf' ? 'bg-[#ff8a5b]/15 text-[#e2612f]' : 'bg-violet/15 text-violet')}>
        {a.kind === 'pdf' ? 'PDF' : <FileText size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{a.name}</span>
        <span className={cx('text-[11.5px]', mine ? 'text-white/60' : 'text-mute')}>{bytes(a.size)} · {a.kind === 'pdf' ? 'Open' : 'Download'}</span>
      </span>
    </a>
  )
}

function VoicePlayer({ url, duration, mine, voice, name }: { url: string; duration: number | null; mine: boolean; voice: boolean; name: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [t, setT] = useState(0)
  const [d, setD] = useState(duration ?? 0)
  const [playing, setPlaying] = useState(false)
  const bars = 28
  const seed = [...url].reduce((a, c) => a + c.charCodeAt(0), 0)
  return (
    <div className="flex min-w-[230px] items-center gap-3">
      <button onClick={() => (playing ? ref.current?.pause() : ref.current?.play())} aria-label={playing ? 'Pause' : 'Play'}
        className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-full', mine ? 'bg-white text-ink' : 'bg-ink text-white')}>
        {playing ? <span className="flex gap-[3px]"><i className="h-3 w-[3px] bg-current" /><i className="h-3 w-[3px] bg-current" /></span> : <span className="ml-0.5 h-0 w-0 border-y-[6px] border-l-[9px] border-y-transparent border-l-current" />}
      </button>
      <div className="flex-1">
        {voice ? (
          <div className="flex h-7 items-center gap-[2px]">
            {Array.from({ length: bars }).map((_, i) => {
              const h = 25 + ((Math.sin(seed + i * 1.7) + 1) / 2) * 75
              const lit = d ? i / bars < t / d : false
              return <span key={i} className={cx('w-[3px] rounded-full transition-colors', lit ? (mine ? 'bg-white' : 'bg-violet') : mine ? 'bg-white/35' : 'bg-ink/15')} style={{ height: `${h}%` }} />
            })}
          </div>
        ) : <div className="truncate text-[13px]">{name}</div>}
        <div className={cx('mt-0.5 font-mono text-[10.5px] tabular-nums', mine ? 'text-white/60' : 'text-mute')}>{fmt(playing || t ? t : d)}</div>
      </div>
      <audio ref={ref} src={url} preload="metadata" onLoadedMetadata={(e) => isFinite(e.currentTarget.duration) && setD(e.currentTarget.duration)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setT(0) }} />
    </div>
  )
}
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** Incoming-call card + full call screen (WebRTC media from MessengerContext). */
export function CallOverlay() {
  const { call, answer, hangup, toggleMute, toggleCamera } = useMessenger()
  const remoteRef = useRef<HTMLVideoElement>(null)
  const localRef = useRef<HTMLVideoElement>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (remoteRef.current && call?.remote) remoteRef.current.srcObject = call.remote }, [call?.remote])
  useEffect(() => { if (localRef.current && call?.local) localRef.current.srcObject = call.local }, [call?.local])
  useEffect(() => { if (call?.phase !== 'active') return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [call?.phase])
  if (!call) return null
  const video = call.call.video
  const status = { outgoing: 'Ringing…', incoming: `Incoming ${video ? 'video' : 'voice'} call`, connecting: 'Connecting…', active: fmt((now - (call.startedAt ?? now)) / 1000), ended: call.error ?? 'Call ended' }[call.phase]

  if (call.phase === 'incoming') return (
    <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="fixed left-1/2 top-5 z-[60] w-[min(380px,calc(100vw-32px))] -translate-x-1/2 rounded-[26px] border border-line bg-paper/95 p-4 shadow-float backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <div className="relative"><span className="absolute inset-0 animate-ping rounded-full bg-mint/30" /><Avatar name={call.peerName} size={48} /></div>
        <div className="min-w-0 flex-1"><div className="truncate text-[15px] font-medium text-ink">{call.peerName}</div><div className="text-[12.5px] text-mute">{status}</div></div>
        <button onClick={() => hangup('decline')} aria-label="Decline" className="grid h-11 w-11 place-items-center rounded-full bg-rose text-white"><PhoneOff size={18} /></button>
        <button onClick={answer} aria-label="Answer" className="grid h-11 w-11 place-items-center rounded-full bg-mint text-white">{video ? <Video size={18} /> : <Phone size={18} />}</button>
      </div>
    </motion.div>
  )
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-[radial-gradient(circle_at_30%_20%,#fff4ee,#f3eeff_45%,#eaf1ff)]">
      {video && <video ref={remoteRef} autoPlay playsInline className={cx('absolute inset-0 h-full w-full object-cover transition-opacity', call.remote && call.phase === 'active' ? 'opacity-100' : 'opacity-0')} />}
      {!video && <audio ref={remoteRef as unknown as React.RefObject<HTMLAudioElement>} autoPlay />}
      {(!video || call.phase !== 'active') && (
        <div className="relative z-10 flex flex-col items-center">
          <div className="relative">
            {call.phase !== 'ended' && [0, 1, 2].map((i) => <motion.span key={i} className="absolute inset-0 rounded-full border border-violet/40" animate={{ scale: [1, 1.9], opacity: [0.6, 0] }} transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8 }} />)}
            <Avatar name={call.peerName} size={120} />
          </div>
          <div className="mt-6 font-serif text-[34px] text-ink">{call.peerName}</div>
          <div className="mt-1 font-mono text-[14px] tabular-nums text-mute">{status}</div>
        </div>
      )}
      {video && call.local && <video ref={localRef} autoPlay playsInline muted className="absolute right-5 top-5 z-10 h-[150px] w-[110px] rounded-2xl border-2 border-white object-cover shadow-float sm:h-[180px] sm:w-[135px]" />}
      {video && call.phase === 'active' && <div className="absolute left-1/2 top-5 z-10 -translate-x-1/2 rounded-full bg-white/80 px-4 py-1.5 font-mono text-[13px] tabular-nums text-ink backdrop-blur">{call.peerName} · {status}</div>}
      {call.phase !== 'ended' && (
        <div className="absolute bottom-10 z-10 flex items-center gap-4 rounded-full border border-line bg-white/85 p-2.5 shadow-float backdrop-blur-xl">
          <button onClick={toggleMute} aria-label={call.muted ? 'Unmute' : 'Mute'} className={cx('grid h-12 w-12 place-items-center rounded-full transition', call.muted ? 'bg-ink text-white' : 'bg-ink/[.05] text-ink')}>{call.muted ? <MicOff size={19} /> : <Mic size={19} />}</button>
          {video && <button onClick={toggleCamera} aria-label={call.cameraOff ? 'Camera on' : 'Camera off'} className={cx('grid h-12 w-12 place-items-center rounded-full transition', call.cameraOff ? 'bg-ink text-white' : 'bg-ink/[.05] text-ink')}>{call.cameraOff ? <VideoOff size={19} /> : <Video size={19} />}</button>}
          <button onClick={() => hangup('end')} aria-label="End call" className="grid h-14 w-14 place-items-center rounded-full bg-rose text-white shadow-[0_10px_24px_-8px_rgb(229_72_77/.7)]"><PhoneOff size={21} /></button>
        </div>
      )}
    </motion.div>
  )
}
