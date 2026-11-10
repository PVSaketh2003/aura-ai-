import { motion } from 'motion/react'
import { ArrowRight } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Orb } from '../components/Orb'
import { useAuth } from '../context/AuthContext'
import { mx } from '../services/messenger'
import { COUNTRIES } from '../components/messenger/bits'
import { cx } from '../utils/format'

function Field({ label, ...p }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="group block">
      <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-mute transition group-focus-within:text-ink">{label}</span>
      <input {...p} className="mt-1.5 w-full border-b border-line-2 bg-transparent pb-2 text-[16px] text-ink outline-none transition placeholder:text-faint focus:border-ink" />
    </label>
  )
}

export function AuthPage() {
  const { setupRequired, login, setup, error: bootError } = useAuth()
  const [mode, setMode] = useState<'password' | 'phone'>('password')
  const [f, setF] = useState({ name: '', username: '', password: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true)
    try { setupRequired ? await setup(f.username, f.password, f.name) : await login(f.username, f.password) }
    catch (x) { setErr((x as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="relative z-10 grid min-h-full place-items-center px-6 py-16">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }} className="w-full max-w-[360px]">
        <div className="mb-12 flex justify-center"><Orb size={120} /></div>
        <h1 className="text-center font-serif text-[52px] leading-none tracking-[-0.02em] text-ink">
          {setupRequired ? <>Make it <span className="italic aura-text">yours</span>.</> : <>Welcome <span className="italic aura-text">back</span>.</>}
        </h1>
        <p className="mt-3 text-center text-[14px] text-mute">
          {setupRequired ? 'Create the owner account for this Aura. Only you will have access.' : 'Your private, voice-first assistant.'}
        </p>
        {!setupRequired && (
          <div className="mx-auto mt-8 flex w-fit rounded-full border border-line bg-white/60 p-1 text-[12.5px]">
            {(['password', 'phone'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={cx('rounded-full px-4 py-1.5 transition', mode === m ? 'bg-ink text-white' : 'text-ink-2')}>{m === 'password' ? 'Username' : 'Phone number'}</button>
            ))}
          </div>
        )}
        {mode === 'phone' && !setupRequired ? <PhoneAuth /> : (
        <form onSubmit={submit} className="mt-10 space-y-7">
          {setupRequired && <Field label="Your name" value={f.name} onChange={set('name')} placeholder="What should I call you?" autoFocus />}
          <Field label="Username" value={f.username} onChange={set('username')} autoComplete="username" autoFocus={!setupRequired} required />
          <Field label="Password" type="password" value={f.password} onChange={set('password')} autoComplete={setupRequired ? 'new-password' : 'current-password'} required minLength={8} />
          {(err || bootError) && <p className="text-[13px] text-rose">{err || bootError}</p>}
          <button disabled={busy} className="group flex w-full items-center justify-center gap-2 rounded-full bg-ink py-3.5 text-[14px] font-medium text-white shadow-[0_10px_30px_-10px_rgb(12_12_16/.6)] transition hover:shadow-[0_14px_40px_-10px_rgb(167_123_255/.55)] disabled:opacity-60">
            {busy ? 'One moment…' : setupRequired ? 'Create account' : 'Sign in'}
            <ArrowRight size={15} className="transition group-hover:translate-x-0.5" />
          </button>
        </form>
        )}
      </motion.div>
    </div>
  )
}

/** Sign in or create an account with a verified phone number (one-time SMS code). */
function PhoneAuth() {
  const { adopt } = useAuth()
  const [step, setStep] = useState<'number' | 'code'>('number')
  const [purpose, setPurpose] = useState<'login' | 'register'>('login')
  const [f, setF] = useState({ country: '+91', phone: '', e164: '', code: '', name: '', password: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [devHint, setDevHint] = useState(false)
  const run = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      if (step === 'number') {
        const r = await mx.phoneStart(f.phone, purpose, f.country)
        setF({ ...f, e164: r.phone }); setDevHint(r.provider === 'dev'); setStep('code')
      } else if (purpose === 'login') {
        await adopt((await mx.phoneLogin(f.e164, f.code)).user)
      } else {
        await adopt((await mx.phoneRegister({ phone: f.e164, code: f.code, display_name: f.name, password: f.password })).user)
      }
    } catch (x) { setErr((x as Error).message) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={run} className="mt-8 space-y-6">
      <div className="flex justify-center gap-4 text-[12.5px]">
        {(['login', 'register'] as const).map((p) => <button type="button" key={p} onClick={() => { setPurpose(p); setStep('number') }} className={cx('border-b pb-1 transition', purpose === p ? 'border-ink text-ink' : 'border-transparent text-mute')}>{p === 'login' ? 'Sign in' : 'Create account'}</button>)}
      </div>
      {step === 'number' ? (
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-mute">Phone number</span>
          <div className="mt-1.5 flex gap-2 border-b border-line-2 pb-2 focus-within:border-ink">
            <select value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} className="bg-transparent text-[15px] text-ink-2 outline-none" aria-label="Country code">
              {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n.split(' ')[0]} {c}</option>)}
            </select>
            <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" autoFocus required placeholder="98765 43210" className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-faint" />
          </div>
        </label>
      ) : (
        <>
          <p className="text-center text-[13px] text-mute">Code sent to {f.e164}. <button type="button" className="text-violet" onClick={() => setStep('number')}>Change</button></p>
          {devHint && <p className="text-center text-[11.5px] text-mute">Dev mode: the code is in backend/data/dev_sms_outbox/ on the Aura Mac.</p>}
          <Field label="6-digit code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '').slice(0, 6) })} inputMode="numeric" autoFocus required />
          {purpose === 'register' && <>
            <Field label="Your name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
            <Field label="Password" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" required minLength={8} />
          </>}
        </>
      )}
      {err && <p className="text-[13px] text-rose">{err}</p>}
      <button disabled={busy} className="group flex w-full items-center justify-center gap-2 rounded-full bg-ink py-3.5 text-[14px] font-medium text-white shadow-[0_10px_30px_-10px_rgb(12_12_16/.6)] disabled:opacity-60">
        {busy ? 'One moment…' : step === 'number' ? 'Send code' : purpose === 'login' ? 'Sign in' : 'Create account'}
        <ArrowRight size={15} className="transition group-hover:translate-x-0.5" />
      </button>
    </form>
  )
}
