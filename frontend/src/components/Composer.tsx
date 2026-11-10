import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, Mic, Paperclip, Square, X } from 'lucide-react'
import { useAgent } from '../context/AgentContext'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { api } from '../services/api'
import { useMicrophone } from '../hooks/useMicrophone'
import { cx } from '../utils/format'
import { useToast } from './ui'
import { LangPicker } from './LangPicker'
import { VoiceStage } from './VoiceStage'

function Waveform({ level }: { level: RefObject<number> }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const bars = Array.from(ref.current!.children) as HTMLElement[]
    const hist = new Array(bars.length).fill(0)
    const tick = () => {
      hist.push(level.current ?? 0); hist.shift()
      bars.forEach((b, i) => { b.style.transform = `scaleY(${0.12 + hist[i] * 1.6})` })
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [level])
  return (
    <div ref={ref} className="flex h-8 flex-1 items-center gap-[3px] overflow-hidden">
      {Array.from({ length: 64 }).map((_, i) => (
        <span key={i} className="h-full w-[3px] origin-center rounded-full bg-gradient-to-b from-coral via-violet to-sky transition-transform duration-75" />
      ))}
    </div>
  )
}

export function Composer({ onSend, onVoice, busy, onMicLevel, value, setValue }: {
  onSend: (t: string) => Promise<void> | void; onVoice: (b: Blob) => Promise<void>; busy: boolean
  onMicLevel?: (level: RefObject<number> | null) => void
  value: string; setValue: (v: string) => void
}) {
  const ta = useRef<HTMLTextAreaElement>(null)
  const mic = useMicrophone()
  const toast = useToast()
  const [focused, setFocused] = useState(false)
  const [stage, setStage] = useState(false)
  const recording = mic.state === 'recording'
  const file = useRef<HTMLInputElement>(null)
  const { watchRun } = useAgent()
  const attach = async (f: File | undefined) => {
    if (!f) return
    if (!/\.pdf$/i.test(f.name)) { toast('Only PDF files can be added to your library.', 'error'); return }
    try { const r = await api.uploadDocument(f); watchRun(r.execution_id, `Adding “${f.name}” to your library`); toast(`Reading ${f.name} — follow it in Mission control.`, 'success') }
    catch (e) { toast((e as Error).message, 'error') }
  }

  useEffect(() => {
    const el = ta.current; if (!el) return
    el.style.height = '0px'; el.style.height = Math.min(200, el.scrollHeight) + 'px'
  }, [value])
  useEffect(() => { onMicLevel?.(recording ? mic.level : null) }, [recording, mic.level, onMicLevel])
  useEffect(() => { if (mic.error) toast(mic.error, 'error') }, [mic.error, toast])

  const submit = async () => {
    const t = value.trim()
    if (!t || busy) return
    setValue('')
    try { await onSend(t) } catch (e) { setValue(t); toast((e as Error).message, 'error') }
  }

  const toggleMic = async () => {
    if (!recording) { api.warmSpeech().catch(() => {}); setStage(true); await mic.start(); return }
    const blob = await mic.stop()
    if (!blob || mic.elapsed < 400) { toast('That was too short. Hold the mic a little longer.'); return }
    try { await onVoice(blob) } catch (e) { toast((e as Error).message, 'error') }
  }
  const cancelMic = async () => { await mic.stop() }
  const listen = async () => { if (recording) return; api.warmSpeech().catch(() => {}); await mic.start() }
  // "Tap the orb to talk" anywhere in the app opens the voice stage
  useEffect(() => {
    const go = () => { if (!busy && !recording) { setStage(true); listen() } }
    window.addEventListener('aura:talk', go)
    return () => window.removeEventListener('aura:talk', go)
  })

  return (
    <motion.div layout className={cx('glass spot spot-border aurora-ring relative rounded-[28px] border shadow-float transition-[border-color,box-shadow] duration-300',
      focused || recording ? 'border-line-2 shadow-[0_1px_1px_rgb(12_12_16/.03),0_12px_40px_-8px_rgb(167_123_255/.25),0_30px_80px_-20px_rgb(12_12_16/.12)]' : 'border-line')}>
      <div className="flex items-end gap-1.5 p-2 pl-2">
        <input ref={file} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { attach(e.target.files?.[0]); e.target.value = '' }} />
        {!recording ? (
          <button onClick={() => file.current?.click()} title="Add a PDF to your library" aria-label="Attach a PDF"
            className="mb-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition hover:bg-ink/[.05] hover:text-ink"><Paperclip size={17} strokeWidth={1.7} /></button>
        ) : (
          <button onClick={cancelMic} title="Cancel recording" aria-label="Cancel recording"
            className="mb-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full text-rose transition hover:bg-rose/10"><X size={17} /></button>
        )}
        <AnimatePresence mode="popLayout" initial={false}>
          {recording ? (
            <motion.div key="wave" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="flex min-h-[44px] flex-1 items-center gap-4">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-rose"><span className="h-2 w-2 animate-pulse rounded-full bg-rose" />REC</span>
              <span className="font-mono text-[12px] tabular-nums text-ink-2">{new Date(mic.elapsed).toISOString().slice(15, 19)}</span>
              <Waveform level={mic.level} />
            </motion.div>
          ) : (
            <motion.textarea key="ta" ref={ta} rows={1} value={value} placeholder="Ask, instruct, or tell me something to remember…"
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
              className="scroll-quiet max-h-[200px] min-h-[44px] flex-1 resize-none bg-transparent py-[11px] text-[15px] leading-[22px] text-ink outline-none placeholder:text-faint" />
          )}
        </AnimatePresence>

        <div className="mb-1 hidden sm:block"><LangPicker /></div>
        <button onClick={toggleMic} aria-label={recording ? 'Stop and send' : 'Speak'} title={recording ? 'Stop & send' : 'Speak in any language'} disabled={mic.state === 'requesting' || (busy && !recording)}
          className={cx('relative grid h-11 w-11 shrink-0 place-items-center rounded-full transition-all duration-300',
            recording ? 'text-white' : 'text-ink-2 hover:bg-ink/[.04]')}>
          {recording && <span className="mic-ring" />}
          {recording && <motion.span layoutId="mic-bg" className="absolute inset-0 rounded-full bg-[conic-gradient(from_180deg,#ff8a5b,#a77bff,#5b8cff,#ff8a5b)] animate-[spin_3s_linear_infinite]" />}
          {recording && <span className="absolute inset-[2px] rounded-full bg-ink" />}
          {recording ? <Square size={14} fill="currentColor" className="relative" /> : <Mic size={19} strokeWidth={1.6} />}
        </button>

        <button onClick={submit} disabled={!value.trim() || busy || recording} aria-label="Send"
          className="btn-aura grid h-11 w-11 shrink-0 place-items-center rounded-full text-white transition-all duration-200 hover:scale-[1.06] active:scale-95 disabled:scale-100 disabled:text-mute">
          <ArrowUp size={18} strokeWidth={2} />
        </button>
      </div>
      <AnimatePresence>{stage && <VoiceStage recording={recording} level={mic.level} elapsed={mic.elapsed} onSend={toggleMic} onCancel={cancelMic}
        onListen={listen} onClose={() => { if (recording) mic.stop(); setStage(false) }} />}</AnimatePresence>
    </motion.div>
  )
}
