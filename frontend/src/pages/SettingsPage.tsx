import { motion } from 'motion/react'
import { AudioLines, Brain, Cpu, Database, HardDrive, Languages, Laptop, Radio, Volume2, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { StatusDot, useToast } from '../components/ui'
import { useAgent } from '../context/AgentContext'
import { useAuth } from '../context/AuthContext'
import { useHealth } from '../hooks/useHealth'
import { PageShell } from '../layouts/PageShell'
import { api } from '../services/api'
import type { Health, LocalAgentStatus, ModelInfo, ModelStatus, Preferences } from '../types'
import { SPOKEN } from '../components/LangPicker'
import { bytes, cx, relative } from '../utils/format'

const VOICES: Record<string, string[]> = { en: ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george'],
  hi: ['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi'], es: ['ef_dora', 'em_alex'], fr: ['ff_siwis'], it: ['if_sara', 'im_nicola'], pt: ['pf_dora', 'pm_alex'] }

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={cx('relative h-6 w-10 rounded-full transition-colors duration-300', on ? 'bg-ink' : 'bg-ink/15')}>
      <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-soft transition-all duration-300', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  )
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-full bg-ink/[.05] p-0.5">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className={cx('rounded-full px-3 py-1 text-[12.5px] transition', value === v ? 'bg-white text-ink shadow-soft' : 'text-mute hover:text-ink')}>{l}</button>
      ))}
    </div>
  )
}

const selectCls = 'rounded-full border border-line bg-white px-3 py-1.5 text-[13px] text-ink outline-none'

const COMPONENT_LABEL: Record<string, string> = {
  database: 'PostgreSQL', realtime: 'Realtime (Redis)', llm_runtime: 'Model runtime (Ollama)', vector_store: 'Vector store (ChromaDB)', local_agent: 'Local Mac Agent',
}
const MS: Record<ModelStatus, { l: string; c: string; bg: string }> = {
  running: { l: 'Running', c: '#0e9f6e', bg: 'rgb(47 191 143 / .14)' }, loading: { l: 'Loading…', c: '#b7791f', bg: 'rgb(255 196 0 / .16)' },
  available: { l: 'Available', c: '#2f6bff', bg: 'rgb(91 140 255 / .13)' }, downloaded: { l: 'Downloaded', c: '#2f6bff', bg: 'rgb(91 140 255 / .13)' },
  unavailable: { l: 'Unavailable', c: '#8a8a96', bg: 'rgb(12 12 16 / .06)' }, auth_required: { l: 'Login required', c: '#c2410c', bg: 'rgb(255 138 91 / .16)' },
  failed: { l: 'Failed', c: '#e5484d', bg: 'rgb(229 72 77 / .12)' },
}
function ModelBadge({ s }: { s: ModelStatus }) {
  const v = MS[s] ?? MS.unavailable
  return <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium" style={{ color: v.c, background: v.bg }}>
    <span className={cx('h-1.5 w-1.5 rounded-full', s === 'running' || s === 'loading' ? 'animate-pulse' : '')} style={{ background: v.c }} />{v.l}</span>
}

/** One tile per layer of the stack: what is active right now, and its real state. */
function StackBoard({ health, prefs }: { health: Health; prefs: Preferences | null }) {
  const by = (c: string) => health.models.filter((m) => m.component === c)
  const pick = (ms: ModelInfo[]) => ms.find((m) => m.status === 'running') ?? ms.find((m) => m.status !== 'unavailable' && m.status !== 'auth_required') ?? ms[0]
  const comp = health.components
  const svc = (k: string): ModelStatus => (comp[k]?.status === 'ok' ? 'running' : comp[k] ? 'failed' : 'unavailable')
  const asr = by('asr')
  const indic = asr.find((m) => m.name.includes('Indic'))
  const asrActive = prefs?.asr_engine === 'whisper' || !indic || indic.status === 'auth_required' || indic.status === 'unavailable' ? asr.find((m) => m.name.startsWith('Whisper')) : indic
  const tiles: { k: string; icon: typeof Cpu; name: string; sub: string; st: ModelStatus; note?: string }[] = [
    { k: 'ASR', icon: AudioLines, name: asrActive?.name ?? '—', sub: indic && asrActive !== indic ? `IndicConformer: ${MS[indic.status]?.l.toLowerCase()}` : 'Speech → text', st: asrActive?.status ?? 'unavailable' },
    { k: 'Language ID', icon: Languages, name: pick(by('lid'))?.name ?? '—', sub: 'Fused with Whisper LID + transcript fit', st: pick(by('lid'))?.status ?? 'unavailable' },
    { k: 'LLM', icon: Brain, name: by('llm')[0]?.name ?? '—', sub: `fallbacks: ${by('llm').slice(1).map((m) => m.name).join(', ') || 'none'}`, st: by('llm')[0]?.status ?? 'unavailable' },
    { k: 'Embeddings', icon: Cpu, name: by('embeddings')[0]?.name ?? '—', sub: '2560-d · cosine', st: by('embeddings')[0]?.status ?? 'unavailable' },
    { k: 'TTS', icon: Volume2, name: 'Kokoro-82M + MMS-TTS', sub: 'chosen by answer language', st: pick(by('tts'))?.status ?? 'unavailable' },
    { k: 'Vector DB', icon: HardDrive, name: 'ChromaDB', sub: comp.vector_store?.error ?? 'documents · memories', st: svc('vector_store') },
    { k: 'Database', icon: Database, name: 'PostgreSQL', sub: comp.database?.version ?? comp.database?.error ?? '', st: svc('database') },
    { k: 'Redis', icon: Radio, name: 'Redis', sub: 'live events', st: svc('realtime') },
    { k: 'Local Agent', icon: Laptop, name: 'Mac agent', sub: comp.local_agent?.status === 'ok' ? 'online' : comp.local_agent?.status ?? '', st: comp.local_agent?.status === 'ok' ? 'running' : 'unavailable' },
  ]
  return (
    <div className="mb-14 grid grid-cols-2 gap-3 md:grid-cols-3">
      {tiles.map((t, i) => (
        <motion.div key={t.k} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
          className="bento glass rounded-[20px] border border-white/80 p-4 shadow-soft">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-mute"><t.icon size={13} className="text-violet" />{t.k}</span>
            <ModelBadge s={t.st} />
          </div>
          <div className="mt-3 truncate text-[14.5px] font-medium text-ink" title={t.name}>{t.name}</div>
          <div className="mt-0.5 truncate text-[12px] text-mute" title={t.sub}>{t.sub}</div>
        </motion.div>
      ))}
    </div>
  )
}

const tone = (s: string) => (s === 'ok' || s === 'installed' || s === 'configured' ? 'ok' : s === 'down' || s === 'missing' ? 'down' : 'idle') as 'ok' | 'down' | 'idle'
const label = (s: string) => ({ ok: 'Healthy', down: 'Unavailable', offline: 'Offline', configured: 'Configured', not_configured: 'Not configured', not_installed: 'Not installed', installed: 'Installed', missing: 'Not installed', planned: 'Planned' }[s] ?? s)

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-14"><h2 className="mb-5 font-serif text-[28px] tracking-[-0.01em] text-ink">{title}</h2><div className="divide-y divide-line border-y border-line">{children}</div></section>
}
function Row({ k, children }: { k: React.ReactNode; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-6 py-4 text-[14px]"><div className="text-ink">{k}</div><div className="flex items-center gap-2.5 text-right text-ink-2">{children}</div></div>
}
function Meter({ value, label: l }: { value: number; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-40 overflow-hidden rounded-full bg-ink/[.06]">
        <div className={cx('h-full rounded-full bg-gradient-to-r', value > 90 ? 'from-coral to-rose' : 'from-violet to-sky')} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="w-40 font-mono text-[12px] tabular-nums text-mute">{l}</span>
    </div>
  )
}

export function SettingsPage() {
  const { health, error } = useHealth(5000)
  const { user } = useAuth()
  const { localAgentOnline } = useAgent()
  const toast = useToast()
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast('Copied to clipboard', 'success'))
  const r = health?.resources
  const [prefs, setPrefs] = useState<Preferences | null>(null)
  const [agent, setAgent] = useState<LocalAgentStatus | null>(null)
  useEffect(() => { api.preferences().then(setPrefs).catch((e) => toast(e.message, 'error')) }, [toast])
  useEffect(() => { api.localAgent().then(setAgent).catch(() => {}) }, [localAgentOnline])
  const save = async (p: Partial<Preferences>) => {
    setPrefs((x) => (x ? { ...x, ...p } : x))
    try { setPrefs(await api.savePreferences(p)) } catch (e) { toast((e as Error).message, 'error') }
  }
  const toggleRoot = async (name: string, enabled: boolean) => {
    const disabled = new Set(agent?.disabled_roots ?? [])
    if (enabled) disabled.delete(name); else disabled.add(name)
    try { setAgent(await api.setDisabledRoots([...disabled])) } catch (e) { toast((e as Error).message, 'error') }
  }

  return (
    <PageShell eyebrow="Settings" title={<>Your AI stack, <span className="hero-name italic">live</span>.</>} lede="Every model and service Aura depends on, with its real state right now — nothing is shown as running unless it is.">
      {error && <p className="mb-8 text-[13px] text-rose">{error}</p>}
      {health && <StackBoard health={health} prefs={prefs} />}
      <Section title="Local Mac Agent">
        <Row k={<div><div>Connection</div><div className="mt-0.5 text-[12px] text-mute">{agent?.paired ? `${agent.name} · v${agent.version || '?'}${agent.last_seen ? ` · seen ${relative(agent.last_seen)}` : ''}` : 'Not installed yet'}</div></div>}>
          <StatusDot tone={localAgentOnline ? 'ok' : agent?.paired ? 'down' : 'idle'} pulse={!!localAgentOnline} />
          <span className="w-28">{localAgentOnline ? 'Online' : agent?.paired ? 'Offline / asleep' : 'Not installed'}</span>
        </Row>
        {agent?.roots?.map((x) => (
          <Row key={x.name} k={<div><div>{x.name}</div><div className="mt-0.5 font-mono text-[11.5px] text-mute">{x.path}</div>
            {x.error && <div className="mt-1 max-w-[460px] text-[12px] text-rose">{x.error}</div>}</div>}>
            <Toggle on={x.enabled} onChange={(v) => toggleRoot(x.name, v)} label={`Allow ${x.name}`} />
          </Row>
        ))}
        {!agent?.paired && (
          <Row k={<span className="text-[13px] text-mute">Install once. It starts at login and only sees the folders listed here.</span>}>
            <button onClick={() => copy('./scripts/install_local_agent.sh')} className="flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[11px] text-ink-2 hover:border-line-2">
              <Copy size={11} /> ./scripts/install_local_agent.sh
            </button>
          </Row>
        )}
      </Section>

      {prefs && (
        <Section title="Speech recognition">
          <Row k={<div><div>Languages I speak</div><div className="mt-0.5 max-w-[380px] text-[12px] text-mute">Auto-detect only chooses among these, so Telugu can never be turned into Marathi or Gujarati.</div></div>}>
            <div className="flex max-w-[420px] flex-wrap justify-end gap-1.5">
              {SPOKEN.filter(([c]) => c !== 'auto').map(([c, native]) => {
                const on = prefs.spoken_languages.includes(c)
                return <button key={c} onClick={() => { const next = on ? prefs.spoken_languages.filter((x) => x !== c) : [...prefs.spoken_languages, c]; if (next.length) save({ spoken_languages: next }) }}
                  className={cx('rounded-full border px-2.5 py-1 text-[12.5px] transition', on ? 'border-transparent bg-ink text-white' : 'border-line bg-white text-ink-2 hover:border-line-2')}>{native}</button>
              })}
            </div>
          </Row>
          <Row k={<div><div>Default spoken language</div><div className="mt-0.5 text-[12px] text-mute">A chosen language is final — no detector can override it</div></div>}>
            <select className={selectCls} value={prefs.asr_language} onChange={(e) => save({ asr_language: e.target.value })}>
              <option value="auto">Detect (among my languages)</option>
              {SPOKEN.filter(([c]) => c !== 'auto').map(([c, n, en]) => <option key={c} value={c}>{n} · {en}</option>)}
            </select>
          </Row>
          <Row k={<div><div>Preferred engine for Indian languages</div><div className="mt-0.5 text-[12px] text-mute">English always uses Whisper</div></div>}>
            <Segmented value={prefs.asr_engine} onChange={(v) => save({ asr_engine: v })} options={[['auto', 'Best available'], ['indic-conformer', 'IndicConformer'], ['whisper', 'Whisper']]} />
          </Row>
          <Row k={<div><div>Fallback engine</div><div className="mt-0.5 text-[12px] text-mute">Used if the preferred engine fails or its transcript fails validation</div></div>}>
            <Segmented value={prefs.asr_fallback} onChange={(v) => save({ asr_fallback: v })} options={[['whisper', 'Whisper'], ['none', 'None']]} />
          </Row>
        </Section>
      )}

      {prefs && (
        <Section title="Voice replies">
          <Row k={<div><div>Speak replies</div><div className="mt-0.5 text-[12px] text-mute">Always in the language you asked in</div></div>}>
            <Segmented value={prefs.speak_replies} onChange={(v) => save({ speak_replies: v })}
              options={[['always', 'Always'], ['voice_only', 'When I speak'], ['never', 'Never']]} />
          </Row>
          <Row k="Speaking speed">
            <input type="range" min={0.7} max={1.4} step={0.05} value={prefs.tts_speed} onChange={(e) => setPrefs({ ...prefs, tts_speed: +e.target.value })}
              onMouseUp={() => save({ tts_speed: prefs.tts_speed })} onTouchEnd={() => save({ tts_speed: prefs.tts_speed })} className="w-40 accent-ink" />
            <span className="w-12 font-mono text-[12px] text-mute">{prefs.tts_speed.toFixed(2)}×</span>
          </Row>
          {Object.entries(VOICES).map(([lang, vs]) => (
            <Row key={lang} k={<div>{prefs.languages[lang]} voice <span className="text-[12px] text-mute">· Kokoro</span></div>}>
              <select className={selectCls} value={prefs.tts_voices[lang] ?? vs[0]} onChange={(e) => save({ tts_voices: { ...prefs.tts_voices, [lang]: e.target.value } })}>
                {vs.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Row>
          ))}
          <Row k={<div><div>Indian languages</div><div className="mt-0.5 text-[12px] text-mute">Telugu, Tamil, Kannada, Malayalam, Bengali, Marathi, Gujarati, Punjabi, Odia, Urdu</div></div>}>
            <span className="text-[12.5px] text-mute">Meta MMS-TTS · downloaded on first use</span>
          </Row>
        </Section>
      )}

      {prefs && (
        <Section title="Knowledge sources">
          <Row k={<div><div>Wikipedia fallback</div><div className="mt-0.5 text-[12px] text-mute">When your documents don’t have the answer</div></div>}>
            <Toggle on={prefs.wikipedia} onChange={(v) => save({ wikipedia: v })} label="Wikipedia" />
          </Row>
          <Row k={<div><div>Web search</div><div className="mt-0.5 text-[12px] text-mute">For current information (DuckDuckGo)</div></div>}>
            <Toggle on={prefs.web_search} onChange={(v) => save({ web_search: v })} label="Web search" />
          </Row>
          <Row k={<div><div>Multi-query retrieval</div><div className="mt-0.5 text-[12px] text-mute">Rephrases complex or non-English questions to find more</div></div>}>
            <Toggle on={prefs.multi_query} onChange={(v) => save({ multi_query: v })} label="Multi-query" />
          </Row>
        </Section>
      )}

      <Section title="Services">
        {health ? Object.entries(health.components).map(([k, c]) => (
          <Row key={k} k={COMPONENT_LABEL[k] ?? k}>
            {c.latency_ms != null && <span className="font-mono text-[12px] text-mute">{c.latency_ms}ms</span>}
            {c.error && <span className="max-w-[320px] truncate text-[12px] text-rose" title={c.error}>{c.error}</span>}
            <StatusDot tone={tone(c.status)} /><span className="w-28">{label(c.status)}</span>
          </Row>
        )) : <Row k={<span className="text-shimmer">Checking services…</span>}>{null}</Row>}
      </Section>

      <Section title="Models">
        {health?.models.map((m) => (
          <Row key={m.role + m.name} k={<div><div>{m.role}</div><div className="mt-0.5 font-mono text-[12px] text-mute">{m.name}</div>
            {m.note && <div className={cx('mt-1 max-w-[460px] text-[12px]', m.status === 'failed' || m.status === 'auth_required' ? 'text-coral' : 'text-mute')}>{m.note}</div>}</div>}>
            {m.status === 'unavailable' && m.runtime === 'ollama' && (
              <button onClick={() => copy(`ollama pull ${m.name}`)} className="flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[11px] text-ink-2 hover:border-line-2">
                <Copy size={11} /> ollama pull {m.name}
              </button>
            )}
            {m.size_bytes && <span className="font-mono text-[12px] text-mute">{bytes(m.size_bytes)}</span>}
            <ModelBadge s={m.status} />
          </Row>
        ))}
      </Section>

      {r && (
        <Section title="This Mac">
          <Row k="Memory"><Meter value={r.memory_percent} label={`${bytes(r.memory_used)} / ${bytes(r.memory_total)}`} /></Row>
          <Row k="Disk"><Meter value={100 - (r.disk_free / r.disk_total) * 100} label={`${bytes(r.disk_free)} free`} /></Row>
          <Row k="CPU"><Meter value={r.cpu_percent} label={`${r.cpu_percent.toFixed(0)}%`} /></Row>
        </Section>
      )}

      <Section title="Account">
        <Row k="Signed in as"><span>{user?.display_name}</span><span className="font-mono text-[12px] text-mute">@{user?.username}</span></Row>
      </Section>
    </PageShell>
  )
}
