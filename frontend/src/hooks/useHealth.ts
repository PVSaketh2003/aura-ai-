import { useEffect, useState } from 'react'
import { api } from '../services/api'
import type { Health } from '../types'

export function useHealth(intervalMs = 15_000) {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const load = () => api.health().then((h) => { if (alive) { setHealth(h); setError('') } }).catch((e) => alive && setError(e.message))
    load()
    const t = setInterval(load, intervalMs)
    return () => { alive = false; clearInterval(t) }
  }, [intervalMs])
  return { health, error }
}

export function useNow(active: boolean, every = 100) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(t)
  }, [active, every])
  return now
}
