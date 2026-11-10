export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export function ms(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v < 1000) return `${v}ms`
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)}s`
  return `${Math.floor(v / 60_000)}m ${Math.round((v % 60_000) / 1000)}s`
}

export function bytes(n: number | null | undefined): string {
  if (!n) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`
}

export function relative(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000
  if (d < 45) return 'just now'
  if (d < 3600) return `${Math.round(d / 60)}m ago`
  if (d < 86400) return `${Math.round(d / 3600)}h ago`
  if (d < 86400 * 7) return `${Math.round(d / 86400)}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}
