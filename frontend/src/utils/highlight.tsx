import type { ReactNode } from 'react'

/** Tiny, dependency-free syntax highlighter for the languages Aura usually writes (Python, JS/TS, SQL, shell, JSON,
 *  Java/C-like). Tokens: comment, string, number, keyword, builtin, function call, decorator. Output is React nodes,
 *  never HTML strings, so model output can't inject markup. */
const KW: Record<string, string[]> = {
  python: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda None nonlocal not or pass raise return True False try while with yield match case'.split(' '),
  js: 'async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield interface type enum implements readonly public private protected'.split(' '),
  sql: 'select from where and or not insert into values update set delete create table drop alter join left right inner outer on group by order having limit as distinct union all null is in like between case when then else end primary key foreign references index'.split(' '),
  sh: 'if then else fi for in do done while case esac function return export local echo cd ls pip python npm git brew sudo'.split(' '),
  c: 'int float double char void long short unsigned signed bool boolean if else for while do return switch case break continue class public private protected static final new this null true false import package struct const using namespace include try catch throw'.split(' '),
}
const BUILTIN = new Set('print len range list dict set tuple str int float bool open enumerate zip map filter sorted sum min max abs np pd plt sklearn torch console Math JSON Object Array Promise fetch self'.split(' '))
const ALIAS: Record<string, string> = { py: 'python', python: 'python', js: 'js', javascript: 'js', ts: 'js', typescript: 'js', tsx: 'js', jsx: 'js',
  json: 'js', sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', java: 'c', c: 'c', cpp: 'c', 'c++': 'c', go: 'c', rust: 'c', kotlin: 'c', swift: 'c' }

export function guessLang(code: string, hint: string): string {
  const h = ALIAS[hint.toLowerCase()]
  if (h) return h
  if (/^\s*(def |import |from \S+ import|class \w+:)/m.test(code)) return 'python'
  if (/\b(const|let|function|=>)\b/.test(code)) return 'js'
  if (/\bselect\b[\s\S]*\bfrom\b/i.test(code)) return 'sql'
  return 'python'
}

export function highlight(code: string, hint = ''): ReactNode[] {
  const lang = guessLang(code, hint)
  const kws = new Set(KW[lang] ?? KW.python)
  const comment = lang === 'python' || lang === 'sh' ? '#[^\\n]*' : lang === 'sql' ? '--[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'
  const re = new RegExp(`(${comment})|("""[\\s\\S]*?"""|'''[\\s\\S]*?'''|"(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(@[\\w.]+)|(\\b\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?\\b)|([A-Za-z_]\\w*)(?=\\s*\\()|([A-Za-z_]\\w*)`, 'g')
  const out: ReactNode[] = []
  let last = 0, m: RegExpExecArray | null, k = 0
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index))
    const [t, com, str, dec, num, fn, word] = m
    const cls = com ? 'tk-com' : str ? 'tk-str' : dec ? 'tk-dec' : num ? 'tk-num'
      : fn ? (kws.has(fn) || kws.has(fn.toLowerCase()) ? 'tk-kw' : 'tk-fn')
      : word && (kws.has(word) || (lang === 'sql' && kws.has(word.toLowerCase()))) ? 'tk-kw' : word && BUILTIN.has(word) ? 'tk-bi' : ''
    out.push(cls ? <span key={k++} className={cls}>{t}</span> : t)
    last = m.index + t.length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}
