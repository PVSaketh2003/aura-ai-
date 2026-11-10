import { Check, Copy } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import { highlight } from '../utils/highlight'

/** A code block: language label, copy button, syntax colours. Shown on screen only — never spoken. */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400) }).catch(() => {}) }
  return (
    <div className="code-card">
      <div className="code-head">
        <span className="flex items-center gap-1.5"><i className="dot bg-[#ff5f57]" /><i className="dot bg-[#febc2e]" /><i className="dot bg-[#28c840]" />
          <span className="ml-2 font-mono text-[11px] lowercase tracking-wide">{lang || 'code'}</span></span>
        <button onClick={copy} className="code-copy">{copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}</button>
      </div>
      <pre><code>{highlight(code, lang)}</code></pre>
    </div>
  )
}

/** Minimal, safe markdown renderer (no HTML injection): paragraphs, lists, headings, code, bold, italic. */
type Cite = ((id: string, key: number) => ReactNode) | undefined

function inline(text: string, cite?: Cite): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[DMWSC]\d+\])/g
  let last = 0, m: RegExpExecArray | null, k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('[')) out.push(cite ? cite(t.slice(1, -1), k++) : null)
    else if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>)
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>)
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text: raw, cite }: { text: string; cite?: Cite }) {
  // "[W1, W2]" → "[W1][W2]" so grouped citations render as chips (also while streaming)
  const text = raw.replace(/\[((?:[DMWSC]\d+\s*[,;]\s*)+[DMWSC]\d+)\]/g, (_, g: string) => g.split(/[,;]/).map((x) => `[${x.trim()}]`).join(''))
  const blocks: ReactNode[] = []
  const parts = text.split(/```/)
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const lang = (part.match(/^([\w+#-]*)\n/) ?? ['', ''])[1]
      blocks.push(<CodeBlock key={`c${i}`} code={part.replace(/^[\w+#-]*\n/, '').replace(/\n$/, '')} lang={lang} />)
      return
    }
    const lines = part.split('\n')
    let list: { ordered: boolean; items: string[] } | null = null
    let para: string[] = []
    let table: string[][] | null = null
    const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    const flushTable = () => {
      if (!table) return
      const [head, ...rows] = table
      blocks.push(
        <div key={`t${blocks.length}`} className="md-table"><table>
          <thead><tr>{head.map((h, j) => <th key={j}>{inline(h, cite)}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{inline(c, cite)}</td>)}</tr>)}</tbody>
        </table></div>)
      table = null
    }
    const flushPara = () => { if (para.length) { blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(' '), cite)}</p>); para = [] } }
    const flushList = () => {
      if (!list) return
      const items = list.items.map((it, j) => <li key={j}>{inline(it, cite)}</li>)
      blocks.push(list.ordered ? <ol key={`l${blocks.length}`}>{items}</ol> : <ul key={`l${blocks.length}`}>{items}</ul>)
      list = null
    }
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (/^\s*\|.*\|\s*$/.test(line)) {
        flushPara(); flushList()
        if (/^\s*\|?\s*:?-{2,}/.test(line)) continue  // separator row
        ;(table ??= []).push(cells(line))
        continue
      }
      flushTable()
      const ul = line.match(/^\s*[-*•]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/), h = line.match(/^#{1,4}\s+(.*)/)
      if (ul || ol) {
        flushPara()
        const ordered = !!ol
        if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] } }
        list.items.push((ul ?? ol)![1])
      } else if (h) { flushPara(); flushList(); blocks.push(<h3 key={`h${blocks.length}`}>{inline(h[1], cite)}</h3>) }
      else if (!line.trim()) { flushPara(); flushList() }
      else { flushList(); para.push(line) }
    }
    flushPara(); flushList(); flushTable()
  })
  return <div className="prose-aura">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>
}
