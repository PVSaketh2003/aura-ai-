/** Where the Aura API lives.
 *  - Local dev / Docker: '' → same origin (Vite or nginx proxies /api and /ws to the backend).
 *  - Production (Render): VITE_API_URL=https://api.aura.pvsairamsaketh.in → calls go straight to the API host with the
 *    session cookie (shared across *.pvsairamsaketh.in via COOKIE_DOMAIN on the backend).
 *  Media URLs rendered into the page (<img src="/api/…">, <audio>, links, new Audio()) are rewritten to the API host
 *  as well; aura.* and api.aura.* are the same site, so the browser sends the login cookie with them. */
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

  // src/href attributes set by React (<img>, <audio>, <video>, <a>, <source>)
  const setAttr = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if ((name === 'src' || name === 'href') && typeof value === 'string' && value.startsWith('/api')) value = apiUrl(value)
    return setAttr.call(this, name, value)
  }
  // .src assigned in code (new Audio(url), audio.src = url, img.src = url)
  for (const proto of [HTMLMediaElement.prototype, HTMLImageElement.prototype, HTMLSourceElement.prototype]) {
    const d = Object.getOwnPropertyDescriptor(proto, 'src')
    if (d?.set) Object.defineProperty(proto, 'src', { ...d, set(v: string) { d.set!.call(this, typeof v === 'string' && v.startsWith('/api') ? apiUrl(v) : v) } })
  }
  // new Audio(url) sets the source internally, without the setter above
  const NativeAudio = window.Audio
  window.Audio = function (src?: string) { return new NativeAudio(typeof src === 'string' ? apiUrl(src) : src) } as unknown as typeof Audio
  window.Audio.prototype = NativeAudio.prototype
  const anchor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'href')
  if (anchor?.set) Object.defineProperty(HTMLAnchorElement.prototype, 'href', { ...anchor, set(v: string) { anchor.set!.call(this, typeof v === 'string' && v.startsWith('/api') ? apiUrl(v) : v) } })
}
