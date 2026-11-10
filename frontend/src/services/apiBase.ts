/** Where the Aura API lives.
 *  - Local dev / Docker: '' → same origin (Vite or nginx proxies /api and /ws to the backend).
 *  - Production (Vercel): VITE_API_URL=https://api.aura.pvsairamsaketh.in → calls go straight to the API host with the
 *    session cookie (shared across *.pvsairamsaketh.in via COOKIE_DOMAIN on the backend).
 *  Media URLs rendered into the page (<img src="/api/…">) are proxied by the Vercel rewrite in vercel.json. */
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

export const apiUrl = (path: string) => (API_BASE && path.startsWith('/api') ? API_BASE + path : path)

export function wsUrl(path: string) {
  if (API_BASE) return API_BASE.replace(/^http/, 'ws') + path
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`
}

/** Route every fetch/XHR to /api through API_BASE with credentials, without touching each call site. */
export function installApiBridge() {
  if (!API_BASE) return
  const f = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api')) return f(apiUrl(input), { ...init, credentials: 'include' })
    return f(input, init)
  }
  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    if (typeof url === 'string' && url.startsWith('/api')) { url = apiUrl(url); this.withCredentials = true }
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest)
  } as typeof XMLHttpRequest.prototype.open
}
