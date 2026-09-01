import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { parseGuide, LOCALES } from '../docs/guide-parser.mjs'
import type { GuideEntry } from '../docs/guide-parser.mjs'

/**
 * Serves the algorithm guide (docs/src/guide.<locale>.html — the same source the PDFs and the
 * GitHub Pages site are built from) to the app as `virtual:algo-guide/<locale>`, keyed by
 * className.
 *
 * The parsing lives in docs/guide-parser.mjs so the app, the site generator and the PDFs all
 * read the guide the same way. Nothing is generated onto disk here: one chunk per locale,
 * loaded on demand.
 */

const PREFIX = 'virtual:algo-guide/'

export type { GuideEntry }

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
