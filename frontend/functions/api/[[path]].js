// Cloudflare Pages Function: same-origin /api/* on aura.pvsairamsaketh.in → the Aura backend on the Mac
// (api.aura.pvsairamsaketh.in, through Cloudflare Tunnel). The SPA calls the API host directly; this covers /api links
// rendered into the page (images, voice notes, shared files), which must stay same-origin. Cookies pass through.
const API = 'https://api.aura.pvsairamsaketh.in'

export async function onRequest({ request }) {
  const url = new URL(request.url)
  const upstream = new Request(API + url.pathname + url.search, request)
  upstream.headers.set('X-Forwarded-Host', url.host)
  try {
    return await fetch(upstream, { redirect: 'manual' })
  } catch {
    return new Response(JSON.stringify({ detail: 'Aura is offline right now.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
  }
}
