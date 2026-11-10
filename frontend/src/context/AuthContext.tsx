import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../services/api'
import type { User } from '../types'

interface AuthValue {
  user: User | null; loading: boolean; setupRequired: boolean; error: string
  login: (u: string, p: string) => Promise<void>
  setup: (u: string, p: string, name: string) => Promise<void>
  logout: () => Promise<void>
  adopt: (u: User) => Promise<void>
}
const Ctx = createContext<AuthValue>(null!)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [setupRequired, setSetupRequired] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.session()
      .then((s) => { setUser(s.user); setSetupRequired(s.setup_required) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    setUser((await api.login({ username, password })).user)
    await api.session() // rotate CSRF token after login
  }, [])
  const setup = useCallback(async (username: string, password: string, display_name: string) => {
    setUser((await api.setup({ username, password, display_name })).user)
    setSetupRequired(false)
    await api.session()
  }, [])
  const adopt = useCallback(async (u: User) => { setUser(u); setSetupRequired(false); await api.session() }, [])
  const logout = useCallback(async () => { await api.logout(); setUser(null); await api.session() }, [])

  return <Ctx.Provider value={{ user, loading, setupRequired, error, login, setup, logout, adopt }}>{children}</Ctx.Provider>
}
export const useAuth = () => useContext(Ctx)
