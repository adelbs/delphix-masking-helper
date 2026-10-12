// Syntax highlighting for the hook script editor: a small tokenizer per language, enough to tell
// comments, strings, variables, keywords and commands apart. It never fails on what it does not
// understand — anything else is plain text — so a half-typed script still highlights.

export type ScriptLanguage = 'bash' | 'expect' | 'powershell'
export type TokenKind = 'comment' | 'string' | 'variable' | 'keyword' | 'command' | 'number' | 'operator' | 'parameter' | 'plain'
export interface Token { kind: TokenKind; text: string }

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'in',
  'function', 'time', 'return', 'exit', 'break', 'continue', 'local', 'export', 'readonly', 'declare', 'typeset',
  'set', 'unset', 'shift', 'source', 'trap', 'eval', 'exec',
])
const BASH_COMMANDS = new Set([
  'echo', 'printf', 'read', 'cd', 'test', 'curl', 'jq', 'grep', 'sed', 'awk', 'cat', 'sleep', 'date', 'mkdir', 'rm',
  'cp', 'mv', 'ls', 'chmod', 'touch', 'tee', 'head', 'tail', 'cut', 'tr', 'sort', 'uniq', 'wc', 'xargs', 'find',
  'basename', 'dirname', 'true', 'false', 'wait', 'kill', 'sqlplus', 'sqlcmd', 'psql', 'mysql', 'ssh', 'scp',
])
const EXPECT_KEYWORDS = new Set([
  'spawn', 'expect', 'send', 'interact', 'set', 'if', 'else', 'elseif', 'while', 'for', 'foreach', 'proc', 'return',
  'exit', 'puts', 'timeout', 'eof', 'exp_continue', 'expr', 'incr', 'catch', 'close', 'wait', 'log_user', 'switch',
])
const PS_KEYWORDS = new Set([
  'if', 'elseif', 'else', 'switch', 'foreach', 'for', 'while', 'do', 'until', 'break', 'continue', 'return', 'exit',
  'function', 'filter', 'param', 'begin', 'process', 'end', 'try', 'catch', 'finally', 'throw', 'trap', 'in',
])
const PS_OPERATORS = /^-(eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join|and|or|not|xor|is|isnot|as|f|band|bor)\b/i

const isWord = (c: string) => /[A-Za-z0-9_]/.test(c)

/** The end of a quoted string that starts at `i` (exclusive), honouring the escape character. */
function quoted(src: string, i: number, quote: string, escape: string | null): number {
  let j = i + 1
  while (j < src.length) {
    if (escape && src[j] === escape && quote !== "'") { j += 2; continue }
    if (src[j] === quote) {
      // PowerShell doubles a quote to escape it.
      if (escape === '`' && src[j + 1] === quote) { j += 2; continue }
      return j + 1
    }
    j++
  }
  return j
}

/** A $variable at `i`: $NAME, ${NAME}, $1, $?, $env:NAME, $(…) is just the dollar. */
function variable(src: string, i: number, powershell: boolean): number {
  let j = i + 1
  if (src[j] === '{') {
    const close = src.indexOf('}', j)
    return close < 0 ? src.length : close + 1
  }
  if (!powershell && /[0-9?#@*$!-]/.test(src[j] ?? '')) return j + 1
  const start = j
  while (j < src.length && (isWord(src[j]) || (powershell && src[j] === ':' && isWord(src[j + 1] ?? '')))) j++
  return j > start ? j : i + 1
}

export function tokenize(src: string, language: ScriptLanguage): Token[] {
  const powershell = language === 'powershell'
  const keywords = powershell ? PS_KEYWORDS : language === 'expect' ? EXPECT_KEYWORDS : BASH_KEYWORDS
  const escape = powershell ? '`' : '\\'
  const tokens: Token[] = []
  const push = (kind: TokenKind, text: string) => {
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind && kind === 'plain') last.text += text
    else tokens.push({ kind, text })
  }
  // Whether the current word starts a command: the first word of a line or after ; | && { (.
  let commandPosition = true
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const rest = src.slice(i)

    // Comments: # to the end of the line (a shebang too); PowerShell block comments <# … #>.
    if (powershell && rest.startsWith('<#')) {
      const end = src.indexOf('#>', i + 2)
      const stop = end < 0 ? src.length : end + 2
      push('comment', src.slice(i, stop)); i = stop; continue
    }
    if (c === '#' && (i === 0 || /[\s;]/.test(src[i - 1]))) {
      const end = src.indexOf('\n', i)
      const stop = end < 0 ? src.length : end
      push('comment', src.slice(i, stop)); i = stop; continue
    }

    // PowerShell here-strings: @" … "@ and @' … '@, closing at the start of a line.
    if (powershell && (rest.startsWith('@"') || rest.startsWith("@'"))) {
      const close = `\n${rest[1]}@`
      const end = src.indexOf(close, i + 2)
      const stop = end < 0 ? src.length : end + close.length
      push('string', src.slice(i, stop)); i = stop; commandPosition = false; continue
    }
    // Bash here-documents: <<EOF … EOF (also <<-'EOF').
    if (!powershell && rest.startsWith('<<') && !rest.startsWith('<<<')) {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(rest)
      if (m) {
        const lineEnd = src.indexOf('\n', i)
        if (lineEnd >= 0) {
          push('operator', m[0])
          push('plain', src.slice(i + m[0].length, lineEnd + 1))
          const body = new RegExp(`^[\\t ]*${m[2]}[\\t ]*$`, 'm')
          const after = src.slice(lineEnd + 1)
          const found = body.exec(after)
          const stop = found ? lineEnd + 1 + found.index : src.length
          push('string', src.slice(lineEnd + 1, stop))
          i = stop
          if (found) { push('operator', found[0]); i += found[0].length }
          continue
        }
      }
    }

    if (c === '"' || c === "'") {
      const stop = quoted(src, i, c, escape)
      push('string', src.slice(i, stop)); i = stop; commandPosition = false; continue
    }
    if (language === 'expect' && c === '{' ) {
      push('operator', c); i++; commandPosition = true; continue
    }
    if (c === '$') {
      const stop = variable(src, i, powershell)
      push(stop > i + 1 ? 'variable' : 'operator', src.slice(i, stop)); i = stop; commandPosition = false; continue
    }
    if (c === escape && i + 1 < src.length) {
      push('plain', src.slice(i, i + 2)); i += 2; continue
    }
    if (/[0-9]/.test(c) && (i === 0 || !isWord(src[i - 1]))) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      if (j >= src.length || !isWord(src[j])) { push('number', src.slice(i, j)); i = j; commandPosition = false; continue }
    }
    if (c === '-' && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      if (powershell) {
        const op = PS_OPERATORS.exec(rest)
        if (op) { push('operator', op[0]); i += op[0].length; continue }
      }
      const m = /^--?[A-Za-z][\w-]*/.exec(rest)
      if (m) { push('parameter', m[0]); i += m[0].length; continue }
    }
    if (isWord(c) || (powershell && c === '-' && isWord(src[i + 1] ?? ''))) {
      let j = i
      while (j < src.length && (isWord(src[j]) || src[j] === '-' || (powershell && src[j] === '.'))) j++
      const word = src.slice(i, j)
      const lower = word.toLowerCase()
      const kind: TokenKind = keywords.has(powershell ? lower : word) ? 'keyword'
        : powershell && /^[A-Za-z]+-[A-Za-z]+$/.test(word) ? 'command'
          : commandPosition && (BASH_COMMANDS.has(word) || (!powershell && language !== 'expect')) ? 'command'
            : 'plain'
      // An assignment (NAME=value) is not a command.
      push(src[j] === '=' && !powershell ? 'variable' : kind, word)
      i = j
      commandPosition = kind === 'keyword'
      continue
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '{' || c === '(') {
      commandPosition = true
      push(c === '\n' ? 'plain' : 'operator', c); i++; continue
    }
    if (/[<>=!}\])]/.test(c)) { push('operator', c); i++; continue }
    if (!/\s/.test(c)) commandPosition = false
    push('plain', c)
    i++
  }
  return tokens
}

/** Tailwind classes per token kind, in the colours of a light editor theme. */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  comment: 'text-slate-400 italic',
  string: 'text-emerald-700',
  variable: 'text-violet-700',
  keyword: 'text-blue-700 font-semibold',
  command: 'text-sky-700',
  number: 'text-amber-700',
  operator: 'text-slate-500',
  parameter: 'text-orange-700',
  plain: 'text-slate-800',
}
