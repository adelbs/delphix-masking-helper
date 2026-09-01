/**
 * Parses the algorithm reference guide (docs/src/guide.<locale>.html) into per-algorithm
 * blocks keyed by className.
 *
 * Two consumers share this: the app's Documentation tab (via
 * frontend/vite-plugin-algo-guide.ts) and the GitHub Pages generator (docs/build-site.mjs).
 * The guide stays the single source for all three surfaces — app, site and PDFs.
 */

export const LOCALES = ['en', 'pt-BR', 'es']

/**
 * Given the index of a `<div …>` opening tag, returns the span of its matching `</div>`.
 * Both the outer .algo block and the inner .algo-body are found this way — using
 * lastIndexOf('</div>') instead would leave the body with one unbalanced closing tag.
 */
function matchDiv(html, openIdx) {
  const tag = /<div\b[^>]*>|<\/div>/g
  tag.lastIndex = openIdx
  let depth = 0
  let afterOpen = openIdx
  let t
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
function extractBlocks(html) {
  const blocks = []
  const open = /<div class="algo">/g
  let m
  while ((m = open.exec(html))) {
    const span = matchDiv(html, m.index)
    if (!span) break
    blocks.push(html.slice(m.index, span.end))
    open.lastIndex = span.end
  }
  return blocks
}

const pick = (re, s) => (re.exec(s)?.[1] ?? '').trim()

/** @returns {Record<string, {number:string,title:string,className:string,tags:{label:string,kind:string}[],body:string}>} */
export function parseGuide(html) {
  const out = {}
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

/**
 * The `<div class="part">` headings that group the algorithms, in document order.
 * Balanced matching matters here too: `.part` wraps `.part-n`, so stopping at the first
 * `</div>` would cut the block before its `<h2>` and lede.
 */
export function parseParts(html) {
  const parts = []
  const open = /<div class="part">/g
  let m
  while ((m = open.exec(html))) {
    const span = matchDiv(html, m.index)
    if (!span) break
    const chunk = html.slice(m.index, span.end)
    parts.push({
      label: pick(/class="part-n">([^<]*)</, chunk),
      title: pick(/<h2>([^<]*)<\/h2>/, chunk),
      lede: pick(/class="part-lede">([\s\S]*?)<\/p>/, chunk),
      at: m.index,
    })
    open.lastIndex = span.end
  }
  return parts
}

/** Algorithms in document order, each tagged with the part it belongs to. */
export function parseOutline(html) {
  const parts = parseParts(html)
  const out = []
  const open = /<div class="algo">/g
  let m
  while ((m = open.exec(html))) {
    const span = matchDiv(html, m.index)
    if (!span) break
    const className = pick(/class="algo-cls">([^<]*)</, html.slice(m.index, span.end))
    let part = null
    for (const p of parts) if (p.at < m.index) part = p
    if (className) out.push({ className, part: part ? part.title : '' })
    open.lastIndex = span.end
  }
  return out
}
