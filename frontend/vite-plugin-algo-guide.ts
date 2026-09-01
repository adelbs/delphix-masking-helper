import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

/**
 * Serves the algorithm guide (docs/src/guide.<locale>.html — the same source the PDFs are
 * built from) to the app as `virtual:algo-guide/<locale>`, keyed by className.
 *
 * The guide stays the single source of truth: nothing is generated onto disk, so the
 * Documentation tab and the PDFs cannot drift apart. One chunk per locale, loaded on demand.
 */

const LOCALES = ['en', 'pt-BR', 'es'] as const
const PREFIX = 'virtual:algo-guide/'

export interface GuideEntry {
  /** Section number as printed in the guide, e.g. "1.1". */
  number: string
  title: string
  className: string
  tags: { label: string; kind: string }[]
  /** Inner HTML of .algo-body, with print-only inline styles stripped. */
  body: string
}

/**
 * Given the index of a `<div …>` opening tag, returns the span of its matching `</div>`.
 * Both the outer .algo block and the inner .algo-body are found this way — using
 * lastIndexOf('</div>') instead would leave the body with one unbalanced closing tag.
 */
function matchDiv(html: string, openIdx: number): { inner: [number, number]; end: number } | null {
  const tag = /<div\b[^>]*>|<\/div>/g
  tag.lastIndex = openIdx
  let depth = 0
  let afterOpen = openIdx
  let t: RegExpExecArray | null
  while ((t = tag.exec(html))) {
    if (t[0] === '</div>') {
      depth--
      if (depth === 0) return { inner: [afterOpen, t.index], end: t.index + t[0].length }
    } else {
      if (depth === 0) afterOpen = t.index + t[0].length
      depth++
    }
  }
  return null
}

/** Extracts the balanced <div class="algo">…</div> blocks. */
function extractBlocks(html: string): string[] {
  const blocks: string[] = []
  const open = /<div class="algo">/g
  let m: RegExpExecArray | null
  while ((m = open.exec(html))) {
    const span = matchDiv(html, m.index)
    if (!span) break
    blocks.push(html.slice(m.index, span.end))
    open.lastIndex = span.end
  }
  return blocks
}

const pick = (re: RegExp, s: string) => (re.exec(s)?.[1] ?? '').trim()

function parseGuide(html: string): Record<string, GuideEntry> {
  const out: Record<string, GuideEntry> = {}
  for (const block of extractBlocks(html)) {
    const className = pick(/class="algo-cls">([^<]*)</, block)
    if (!className) continue

    const tags = [...block.matchAll(/<span class="tag (tag-[a-z]+)">([^<]*)<\/span>/g)]
      .map(t => ({ kind: t[1], label: t[2].trim() }))

    // The body is everything inside .algo-body; inline styles there are print sizes in pt.
    const bodyStart = block.indexOf('<div class="algo-body">')
    const bodySpan = bodyStart === -1 ? null : matchDiv(block, bodyStart)
    const body = bodySpan
      ? block.slice(bodySpan.inner[0], bodySpan.inner[1]).replace(/\sstyle="[^"]*"/g, '').trim()
      : ''

    out[className] = {
      number: pick(/class="algo-n">([^<]*)</, block),
      title: pick(/<h3>([^<]*)<\/h3>/, block),
      className,
      tags,
      body,
    }
  }
  return out
}

export function algoGuide(docsDir: string): Plugin {
  const fileFor = (locale: string) => path.join(docsDir, `guide.${locale}.html`)

  const load = (locale: string) => {
    const file = fileFor(locale)
    if (!existsSync(file)) {
      // A missing guide must not break the build — the tab just reports it is unavailable.
      return {}
    }
    return parseGuide(readFileSync(file, 'utf8'))
  }

  return {
    name: 'algo-guide',
    resolveId(id) {
      if (id.startsWith(PREFIX)) return '\0' + id
    },
    load(id) {
      if (!id.startsWith('\0' + PREFIX)) return
      const locale = id.slice(('\0' + PREFIX).length)
      if (!LOCALES.includes(locale as typeof LOCALES[number])) return
      return `export default ${JSON.stringify(load(locale))}`
    },
    configureServer(server) {
      // Editing a guide should refresh the open Documentation tab.
      server.watcher.add(LOCALES.map(fileFor))
    },
    handleHotUpdate({ file, server }) {
      const locale = LOCALES.find(l => file === fileFor(l))
      if (!locale) return
      const mod = server.moduleGraph.getModuleById('\0' + PREFIX + locale)
      return mod ? [mod] : undefined
    },
  }
}
