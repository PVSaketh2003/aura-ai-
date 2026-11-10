import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../services/api'
import type { User } from '../types'

interface AuthValue {
  user: User | null; loading: boolean; setupRequired: boolean; error: string
  offline: boolean  // the Aura server (the Mac) can't be reached; the page keeps checking
  login: (u: string, p: string) => Promise<void>
  setup: (u: string, p: string, name: string, code?: string, email?: string, emailCode?: string) => Promise<void>
  setupCodeRequired: boolean
  setupVerification: 'email' | 'code' | 'none'
  logout: () => Promise<void>
  adopt: (u: User) => Promise<void>
}
const Ctx = createContext<AuthValue>(null!)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [setupRequired, setSetupRequired] = useState(false)
  const [setupCodeRequired, setSetupCodeRequired] = useState(false)
  const [setupVerification, setSetupVerification] = useState<'email' | 'code' | 'none'>('none')
  const [error, setError] = useState('')

  const [offline, setOffline] = useState(false)
  useEffect(() => {
    let timer: number | undefined
    const check = () => api.session()
      .then((s) => { setUser(s.user); setSetupRequired(s.setup_required); setSetupCodeRequired(!!s.setup_code_required); setSetupVerification(s.setup_verification ?? (s.setup_code_required ? 'code' : 'none')); setOffline(false); setError('') })
      .catch((e) => {
        const down = !(e instanceof ApiError) || e.status === 0 || e.status >= 500
        setOffline(down); setError(down ? '' : e.message)
        if (down) timer = window.setTimeout(check, 15_000)  // come back by itself as soon as the Mac is on again
      })
      .finally(() => setLoading(false))
    check()
    return () => window.clearTimeout(timer)
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    setUser((await api.login({ username, password })).user)
    await api.session() // rotate CSRF token after login
  }, [])
  const setup = useCallback(async (username: string, password: string, display_name: string, setup_code?: string, email?: string, email_code?: string) => {
    setUser((await api.setup({ username, password, display_name, setup_code, email, email_code })).user)
    setSetupRequired(false)
    await api.session()
  }, [])
  const adopt = useCallback(async (u: User) => { setUser(u); setSetupRequired(false); await api.session() }, [])
  const logout = useCallback(async () => { await api.logout(); setUser(null); await api.session() }, [])

  return <Ctx.Provider value={{ user, loading, setupRequired, setupCodeRequired, setupVerification, error, offline, login, setup, logout, adopt }}>{children}</Ctx.Provider>
}
export const useAuth = () => useContext(Ctx)
