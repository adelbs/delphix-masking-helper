#!/usr/bin/env node
/**
 * Builds the documentation PDFs of a pre-configured profile set.
 *
 *   node presets/_doc/build.mjs <preset-id> [locale…]
 *
 * Everything the set holds is listed from presets/<id>/preset.json itself, so the document cannot
 * drift from the set: classifiers are described from their configuration, algorithms from theirs,
 * files from their contents. What only a person can write comes from presets/<id>/doc/:
 *
 *   <locale>.json   context, the domain groups, and for every domain what it is and why it is
 *                   masked the way it is — every domain of the set must be there, once
 *   examples.json   values to show per domain; the running app masks them (DLPX_URL, default
 *                   http://localhost:3000)
 *
 * Chrome prints the PDF (CHROME to point at another build). Writes presets/<id>/doc.<locale>.pdf.
 */
import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TEXT } from './text.mjs'

const HERE = nodePath.dirname(fileURLToPath(import.meta.url))
const [id, ...requested] = process.argv.slice(2)
if (!id) {
  console.error('usage: node presets/_doc/build.mjs <preset-id> [locale…]')
  process.exit(2)
}
const DIR = nodePath.join(HERE, '..', id)
const read = (...parts) => fs.readFileSync(nodePath.join(...parts), 'utf8')
const API = process.env.DLPX_URL ?? 'http://localhost:3000'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CSS = read(HERE, 'doc.css')
const LOCALES = requested.length ? requested : Object.keys(TEXT)
for (const locale of LOCALES) if (!TEXT[locale]) fail(`no shared text for locale ${locale} in presets/_doc/text.mjs`)

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

// ── The set ─────────────────────────────────────────────────────────────────

const preset = JSON.parse(read(DIR, 'preset.json'))
const algorithms = new Map(preset.algorithms.map((a) => [a.name, a]))
const domainsByName = new Map(preset.domains.map((d) => [d.name, d]))
const fileName = (ref) => String(ref?.uri ?? ref ?? '').replace('preset-file://', '')
const fileLines = new Map(preset.files.map((f) => [f, read(DIR, 'files', f).split('\n').filter(Boolean)]))

/** Algorithms a configuration references, in order of appearance. */
function refsOf(config) {
  const out = []
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (!v || typeof v !== 'object') return
    if (typeof v.name === 'string' && algorithms.has(v.name) && Object.keys(v).every((k) => k === 'name' || k === 'algorithmMetadata')) {
      out.push(v.name)
      return
    }
    Object.values(v).forEach(walk)
  }
  walk(config)
  return [...new Set(out)]
}
const filesOf = (config) => [...new Set([...JSON.stringify(config).matchAll(/preset-file:\/\/([^"]+)/g)].map((m) => m[1]))]

const usedBy = new Map(preset.algorithms.map((a) => [a.name, []]))
for (const d of preset.domains) usedBy.get(d.algorithm)?.push(d.name)
for (const a of preset.algorithms) for (const r of refsOf(a.config)) usedBy.get(r).push(a.name)
const fileUsers = new Map(preset.files.map((f) => [f, []]))
for (const item of [...preset.algorithms, ...preset.classifiers]) {
  for (const f of filesOf(item.config)) fileUsers.get(f)?.push(item.name)
}
const classifiersOf = (domain) => {
  const order = { PATH: 0, TYPE: 1, REGEX: 2, LIST: 3 }
  return preset.classifiers.filter((c) => c.domain === domain).sort((a, b) => order[a.framework] - order[b.framework])
}

/**
 * What each pack loads, cut the way the app cuts it: the essential pack is its domains, the
 * classifiers that vote for them, the algorithms those domains reach and the files all of that
 * reads. The extended pack is everything.
 */
const essential = new Set(preset.packs?.essential?.domains ?? [])
function packCounts(domainNames) {
  const domains = preset.domains.filter((d) => domainNames.has(d.name))
  const classifiers = preset.classifiers.filter((c) => domainNames.has(c.domain))
  const reached = new Set()
  const reach = (name) => {
    if (!algorithms.has(name) || reached.has(name)) return
    reached.add(name)
    refsOf(algorithms.get(name).config).forEach(reach)
  }
  for (const d of domains) { reach(d.algorithm); reach(d.tokenization) }
  const files = new Set([...classifiers, ...[...reached].map((name) => algorithms.get(name))].flatMap((item) => filesOf(item.config)))
  return [domains.length, classifiers.length, reached.size, files.size]
}

// ── What people wrote ───────────────────────────────────────────────────────

const paragraphs = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])

function loadContent(locale) {
  let content
  try {
    content = JSON.parse(read(DIR, 'doc', `${locale}.json`))
  } catch (err) {
    fail(`presets/${id}/doc/${locale}.json: ${err.message}`)
  }
  const problems = []
  const grouped = (content.groups ?? []).flatMap((g) => g.domains)
  for (const d of preset.domains) {
    const times = grouped.filter((name) => name === d.name).length
    if (times !== 1) problems.push(`${d.name} is in ${times} groups`)
    const text = content.domains?.[d.name]
    if (!text?.title || !paragraphs(text.what).length || !paragraphs(text.masking).length) problems.push(`${d.name} needs title, what and masking`)
  }
  for (const name of grouped) if (!domainsByName.has(name)) problems.push(`group lists ${name}, which the set does not have`)
  for (const name of Object.keys(content.domains ?? {})) if (!domainsByName.has(name)) problems.push(`text for ${name}, which the set does not have`)
  if (!content.title) problems.push('title is missing')
  const helper = HELPER_TERMS.exec(JSON.stringify(content))
  if (helper) problems.push(`mentions "${helper[0]}": the document is for any Masking Engine user, and names nothing of this tool`)
  if (problems.length) fail(`presets/${id}/doc/${locale}.json:\n  ${problems.join('\n  ')}`)
  return content
}

/**
 * Words that belong to this tool rather than to Delphix. The document is read by people who run a
 * Masking Engine without it, so it describes the set in the engine's terms — profile set,
 * classifiers, domains, algorithms, profiling and masking jobs — and never the tool's screens,
 * scripts or buttons. Checked in the preset's text and in the shared text of text.mjs.
 */
const HELPER_TERMS = /\bHelper\b|Settings →|Configurações →|Configuración →|build\.mjs|verify\.mjs|preset\.json|preset-file:|this tool|esta ferramenta|esta herramienta|\btester\b|running app|app em execução|aplicación en ejecución|app en ejecución/i
for (const locale of LOCALES) {
  const shared = Object.values(TEXT[locale]).map((v) => (typeof v === 'function' ? String(v) : JSON.stringify(v))).join('\n')
  const helper = HELPER_TERMS.exec(shared)
  if (helper) fail(`presets/_doc/text.mjs (${locale}) mentions "${helper[0]}": the document names nothing of this tool`)
}

function loadExamples() {
  let examples
  try {
    examples = JSON.parse(read(DIR, 'doc', 'examples.json'))
  } catch (err) {
    fail(`presets/${id}/doc/examples.json: ${err.message}`)
  }
  const missing = preset.domains.filter((d) => !Array.isArray(examples[d.name]) || !examples[d.name].length).map((d) => d.name)
  if (missing.length) fail(`presets/${id}/doc/examples.json has no examples for: ${missing.join(', ')}`)
  return examples
}

// ── The app: framework names and masked examples ────────────────────────────

async function api(path, body) {
  try {
    const res = await fetch(`${API}${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    return await res.json()
  } catch (err) {
    return fail(`the app is not answering at ${API} (${err.message}). Start it, or set DLPX_URL.`)
  }
}

async function maskExamples(examples) {
  const filesUrl = `${pathToFileURL(nodePath.join(DIR, 'files')).href}/`
  const resolve = (config) => JSON.parse(JSON.stringify(config).replaceAll('preset-file://', filesUrl))
  // Each request carries only what its algorithm reaches, as the tester does: a whole set can be
  // larger than the app takes in one request body.
  const reach = (name, seen = new Set()) => {
    if (seen.has(name)) return seen
    seen.add(name)
    for (const ref of refsOf(algorithms.get(name).config)) reach(ref, seen)
    return seen
  }
  const closures = new Map()
  const additionalFor = (name) => {
    if (!closures.has(name)) closures.set(name, [...reach(name)].map((n) => algorithms.get(n)).map((a) => ({ name: a.name, className: a.framework, config: resolve(a.config) })))
    return closures.get(name)
  }
  const jobs = preset.domains.flatMap((d) => examples[d.name].map((input) => ({ domain: d, input })))
  const masked = new Map()
  const problems = []
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const { domain, input } = jobs[next++]
      const algorithm = algorithms.get(domain.algorithm)
      const out = await api('/api/mask', { framework: algorithm.framework, config: resolve(algorithm.config), input, additionalAlgorithms: additionalFor(domain.algorithm) })
      if (typeof out.output !== 'string') problems.push(`${domain.name} ${JSON.stringify(input)}: ${out.error}`)
      masked.set(`${domain.name} ${input}`, out.output)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  if (problems.length) fail(`examples that do not mask:\n  ${problems.join('\n  ')}`)
  return masked
}

// ── HTML ────────────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `code`, **bold** and *italic*, with code taken out first so a regex keeps its asterisks. */
function inline(text) {
  const spans = []
  const held = esc(text).replace(/`([^`]+)`/g, (_, c) => ` ${spans.push(c) - 1} `)
  return held
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\s][^*]*)\*/g, '<i>$1</i>')
    .replace(/ (\d+) /g, (_, i) => `<code>${spans[Number(i)]}</code>`)
}

function blocks(list) {
  return paragraphs(list).map((b) => {
    if (typeof b === 'string') return `<p>${inline(b)}</p>`
    if (b.list) return `<ul>${b.list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`
    if (b.note) return `<div class="note">${inline(b.note)}</div>`
    if (b.tip) return `<div class="note tip">${inline(b.tip)}</div>`
    if (b.table) {
      return `<table class="tbl"><thead><tr>${b.table.head.map((x) => `<th>${inline(x)}</th>`).join('')}</tr></thead>`
        + `<tbody>${b.table.rows.map((r) => `<tr>${r.map((x) => `<td>${inline(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    }
    return ''
  }).join('\n')
}

/** Splits a regex on its top-level alternation. */
function splitTop(source) {
  const out = []
  let depth = 0
  let current = ''
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') { current += ch + (source[i + 1] ?? ''); i++; continue }
    if (inClass) { current += ch; if (ch === ']') inClass = false; continue }
    if (ch === '[') { inClass = true; current += ch; continue }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === '|' && depth === 0) { out.push(current); current = ''; continue }
    current += ch
  }
  out.push(current)
  return out
}

/**
 * Takes the negative lookarounds out of an alternative: what it matches, what may not follow
 * (`(?!…)`) and what may not come before it (`(?<!…)`).
 */
function withoutLookaheads(alternative) {
  let text = ''
  const excluded = []
  const excludedBefore = []
  for (let i = 0; i < alternative.length; i++) {
    const behind = alternative.startsWith('(?<!', i)
    if (!behind && !alternative.startsWith('(?!', i)) { text += alternative[i]; continue }
    let depth = 0
    let j = i
    for (; j < alternative.length; j++) {
      if (alternative[j] === '\\') { j++; continue }
      if (alternative[j] === '(') depth++
      else if (alternative[j] === ')' && --depth === 0) break
    }
    let inner = behind ? alternative.slice(i + 4, j).replace(/_\?$/, '') : alternative.slice(i + 3, j).replace(/^_\?/, '')
    if (inner.startsWith('(') && inner.endsWith(')')) inner = inner.slice(inner.startsWith('(?:') ? 3 : 1, -1)
    ;(behind ? excludedBefore : excluded).push(splitTop(inner))
    i = j
  }
  return { text, excluded, excludedBefore }
}

const COLUMN_NAME_RULE = /^\(\?i\)\(\?<!\[a-z\]\)\(\?:([\s\S]*)\)\(\?!\[a-z\]\)$/

function render(locale, content, examples, masked, displayNames) {
  const t = TEXT[locale]
  const number = new Intl.NumberFormat(locale)
  // The version date is a plain day: read it as UTC so it is not printed as the day before.
  const day = (value) => new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, { dateStyle: 'long', timeZone: 'UTC' })
  const pct = (strength) => `${Math.round(strength * 100)}%`
  const code = (s) => `<code>${esc(s)}</code>`
  const joinOr = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${t.or} ${items.at(-1)}`)
  const display = (framework) => displayNames.get(framework) ?? framework.split('.').pop()
  const h = {
    code,
    num: (n) => number.format(n),
    file: (ref) => code(fileName(ref)),
    lines: (ref) => fileLines.get(fileName(ref))?.length ?? 0,
    ref: (ref) => (ref?.name ? `<a href="#a-${esc(ref.name)}">${code(ref.name)}</a>` : '—'),
    unit: (unit) => t.units[unit] ?? unit,
  }
  const describe = (a) => {
    const describer = t.describe[a.framework.split('.').pop()]
    return describer ? describer(a.config, h) : t.describe.default(esc(display(a.framework)))
  }
  const text = (name) => content.domains[name]
  const essentialTag = (name) => (essential.has(name) ? `<span class="tag tag-essential">${esc(t.essentialTag)}</span>` : '')

  // Long exclusion lists are printed once, in an appendix, and referred to by id.
  const exclusions = new Map()
  const exclusion = (words) => {
    if (words.length <= 6) return words.map(code).join(', ')
    const key = words.join('|')
    if (!exclusions.has(key)) exclusions.set(key, `E${exclusions.size + 1}`)
    return `<a href="#exclusions">${t.exclusionList(exclusions.get(key))}</a>`
  }

  // ── classifiers ──
  function pathClassifier(c) {
    return c.config.paths.map((rule) => {
      const wrapped = rule.matchType === 'REGEX' ? COLUMN_NAME_RULE.exec(rule.fieldValue) : null
      const alternatives = wrapped ? splitTop(wrapped[1]) : [rule.fieldValue]
      const chips = alternatives.map((alternative) => {
        const { text: matched, excluded, excludedBefore } = withoutLookaheads(alternative)
        const notes = [
          ...excludedBefore.map((words) => `${t.exceptBefore} ${exclusion(words)}`),
          ...excluded.map((words) => `${t.except} ${exclusion(words)}`),
        ]
        return `<span class="chip">${code(matched)}${notes.length ? ` <span class="chip-note">(${notes.join('; ')})</span>` : ''}</span>`
      })
      return `<div class="rule"><span class="strength">${pct(rule.matchStrength)}</span><div class="chips">${chips.join(' ')}</div></div>`
    }).join('')
  }

  function typeClassifier(c) {
    const accepted = c.config.allowedTypes.map((entry) => {
      const name = entry.typeName === 'JavaSqlType' ? (t.sqlTypes[entry.sqlType] ?? `SQL ${entry.sqlType}`) : t.typeNames[entry.typeName] ?? entry.typeName
      const min = entry.minimumLength || 0
      const max = entry.maximumLength || 0
      const length = min && max ? t.lengthRange(min, max) : min ? t.lengthMin(min) : max ? t.lengthMax(max) : ''
      return length ? `${name} (${length})` : name
    })
    return `<p class="cls-text">${t.typeAccepts(joinOr(accepted))}</p>`
  }

  function rejectLine(strength) {
    return `<p class="cls-text">${strength > 0 ? t.reject(pct(strength)) : t.noReject}</p>`
  }

  function regexClassifier(c) {
    const rows = c.config.dataPatterns.map((p) => {
      const notes = [
        p.checksumType && p.checksumType !== 'NONE' ? t.checksum(p.checksumType) : null,
        p.allowPartialMatch ? t.partial : null,
        p.dataCleanRegex ? t.cleaned(code(p.dataCleanRegex)) : null,
      ].filter(Boolean)
      return `<tr><td>${code(p.regex)}</td><td class="num">${pct(p.matchStrength)}</td><td class="muted">${notes.join('; ')}</td></tr>`
    })
    return `<table class="tbl"><thead><tr>${t.regexHead.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>${rejectLine(c.config.rejectStrength ?? 1)}`
  }

  function listClassifier(c) {
    const rows = c.config.valueLists.map((l) => {
      const lines = fileLines.get(fileName(l.file)) ?? []
      return `<tr><td>${h.file(l.file)}</td><td class="num">${h.num(lines.length)}</td><td class="num">${pct(l.matchStrength)}</td><td class="muted">${esc(lines.slice(0, 6).join(', '))}</td></tr>`
    })
    return `<table class="tbl"><thead><tr>${t.listHead.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
      + `${c.config.tokenizeInput ? `<p class="cls-text">${t.tokenized}</p>` : ''}${rejectLine(c.config.rejectStrength ?? 0.5)}`
  }

  const CLASSIFIER = { PATH: pathClassifier, TYPE: typeClassifier, REGEX: regexClassifier, LIST: listClassifier }
  const classifier = (c) => `<div class="cls"><div class="cls-head"><span class="tag k-${c.framework}">${t.kinds[c.framework]}</span><code class="cls-name">${esc(c.name)}</code></div>${CLASSIFIER[c.framework](c)}</div>`

  // ── algorithms ──
  const below = (name, found = new Set()) => {
    for (const child of refsOf(algorithms.get(name).config)) if (!found.has(child)) { found.add(child); below(child, found) }
    return found
  }
  /**
   * Each algorithm appears once per tree: a building block used again is already described above, and its parent's text names it.
   * A node made of many steps named after it (Mexico's check digit tables, MX_CURP_DV_1…) is shown closed: the steps
   * repeat one another, and every one of them is in Appendix A.
   */
  function tree(name, seen) {
    seen.add(name)
    const a = algorithms.get(name)
    const children = refsOf(a.config)
    const steps = below(name)
    const closed = steps.size > 10 && children.every((child) => child.startsWith(`${name}_`))
    if (closed) steps.forEach((step) => seen.add(step))
    const items = closed ? '' : children.map((child) => (seen.has(child) ? '' : tree(child, seen))).join('')
    return `<li><a href="#a-${esc(name)}">${code(name)}</a><span class="fw">${esc(display(a.framework))}</span>`
      + `<div class="tree-desc">${describe(a)}${closed ? ` ${t.closedSteps(steps.size)}` : ''}</div>${items ? `<ul>${items}</ul>` : ''}</li>`
  }

  function flatten(value, path, rows, skip) {
    if (value === null || value === undefined) return
    if (Array.isArray(value)) {
      if (value.every((v) => typeof v !== 'object')) rows.push([path, value.map(code).join(' ')])
      else value.forEach((v, i) => flatten(v, `${path}[${i + 1}]`, rows, skip))
      return
    }
    if (typeof value === 'object') {
      if (typeof value.uri === 'string') return rows.push([path, h.file(value)])
      if (typeof value.name === 'string' && algorithms.has(value.name)) return rows.push([path, h.ref(value)])
      for (const [key, v] of Object.entries(value)) if (!skip.includes(key)) flatten(v, path ? `${path}.${key}` : key, rows, skip)
      return
    }
    rows.push([path, typeof value === 'boolean' ? (value ? t.yes : t.no) : code(value)])
  }

  function algorithmEntry(a) {
    const users = usedBy.get(a.name).map((user) => (domainsByName.has(user) ? `<a href="#d-${esc(user)}">${code(user)}</a>` : h.ref({ name: user })))
    const framework = a.framework.split('.').pop()
    let extra = ''
    if (framework === 'RegexDecompose') {
      const rows = a.config.maskPatterns.map((p) => `<tr><td>${code(p.regex)}</td><td>${p.actions.map((x) => t.action(x, h)).join(' · ')}</td></tr>`)
      rows.push(`<tr><td class="muted">${t.otherwise}</td><td>${t.action(a.config.fallbackAction ?? { type: 'PRESERVE' }, h)}</td></tr>`)
      extra = `<div class="label">${t.patterns}</div><table class="params"><tbody>${rows.join('')}</tbody></table>`
    }
    if (framework === 'FreeTextRedaction') {
      extra = `<div class="label">${t.patterns}</div><table class="params"><tbody>${(a.config.regularExpressions ?? []).map((r) => `<tr><td colspan="2">${code(r.patternString)}</td></tr>`).join('')}</tbody></table>`
    }
    const rows = []
    flatten(a.config, '', rows, ['maskPatterns', 'fallbackAction', 'regularExpressions'])
    const params = rows.length
      ? `<div class="label">${t.parameters}</div><table class="params"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</tbody></table>`
      : ''
    return `<div class="algo" id="a-${esc(a.name)}"><div class="algo-head">${code(a.name)}<span class="fw">${esc(display(a.framework))}</span></div>`
      + `<p>${describe(a)}</p><div class="usedby">${t.usedBy}: ${users.length ? users.join(', ') : t.none}</div>${extra}${params}</div>`
  }

  // ── assembly ──
  const toc = []
  const body = []
  let n = 0

  const sectionHtml = (num, title, inner, sectionId, chapter = false) => (
    `<section class="${chapter ? 'chapter' : 'section'}" id="${sectionId}"><div class="section-head"><div class="section-n">${num}</div><h2>${esc(title)}</h2></div>${inner}</section>`)

  const front = []
  for (const s of content.sections ?? []) {
    n++
    toc.push({ row: [n, s.title], href: `s-${n}` })
    front.push(sectionHtml(n, s.title, blocks(s.body), `s-${n}`))
  }
  n++
  toc.push({ row: [n, t.discoveryTitle], href: `s-${n}` })
  front.push(sectionHtml(n, t.discoveryTitle, blocks(t.discovery(preset.profileSet.threshold)), `s-${n}`))
  n++
  toc.push({ row: [n, t.maskingTitle], href: `s-${n}` })
  front.push(sectionHtml(n, t.maskingTitle, blocks(t.masking), `s-${n}`))
  if (essential.size) {
    n++
    toc.push({ row: [n, t.packsTitle], href: `s-${n}` })
    const table = { table: { head: t.packsHead, rows: [
      [t.packNames.essential, ...packCounts(essential)],
      [t.packNames.extended, preset.domains.length, preset.classifiers.length, preset.algorithms.length, preset.files.length],
    ].map((row) => row.map((cell) => (typeof cell === 'number' ? number.format(cell) : `**${cell}**`))) } }
    const list = { list: preset.domains.filter((d) => essential.has(d.name)).map((d) => `${text(d.name).title} — \`${d.name}\``) }
    front.push(sectionHtml(n, t.packsTitle, blocks(t.packs(table, list)), `s-${n}`))
  }
  body.push(`<div class="chapter">${front.join('\n')}</div>`)

  n++
  toc.push({ row: [n, t.overviewTitle], href: 'overview' })
  const overviewRows = content.groups.flatMap((g) => [
    `<tr class="group-row"><td colspan="3">${esc(g.title)}</td></tr>`,
    ...g.domains.map((name) => {
      const kinds = [...new Set(classifiersOf(name).map((c) => c.framework))].map((k) => `<span class="tag k-${k}">${t.kinds[k]}</span>`).join('')
      return `<tr><td><a href="#d-${esc(name)}"><b>${esc(text(name).title)}</b></a> ${essentialTag(name)}<br>${code(name)}</td><td>${kinds}</td><td>${h.ref({ name: domainsByName.get(name).algorithm })}</td></tr>`
    }),
  ])
  body.push(sectionHtml(n, t.overviewTitle, `<p>${t.overviewLede}</p><table class="tbl"><thead><tr>${t.overviewHead.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${overviewRows.join('')}</tbody></table>`, 'overview', true))

  for (const group of content.groups) {
    n++
    toc.push({ part: `${t.part} ${n} · ${group.title}` })
    const domainsHtml = group.domains.map((name, i) => {
      const num = `${n}.${i + 1}`
      const d = domainsByName.get(name)
      const own = classifiersOf(name)
      toc.push({ row: [num, text(name).title, name], href: `d-${name}` })
      const tags = [...new Set(own.map((c) => c.framework))].map((k) => `<span class="tag k-${k}">${t.kinds[k]}</span>`).join('')
      const rows = examples[name].map((input) => `<tr><td class="c-in">${esc(input)}</td><td class="c-ar">→</td><td class="c-out">${esc(masked.get(`${name} ${input}`))}</td></tr>`)
      return `<article class="domain" id="d-${esc(name)}">`
        + `<div class="domain-head"><span class="domain-n">${num}</span><h3>${esc(text(name).title)}</h3><code class="domain-code">${esc(name)}</code></div>`
        + `<div class="domain-tags">${essentialTag(name)}${tags}<span class="tag tag-algo">${esc(display(algorithms.get(d.algorithm).framework))}</span></div>`
        + '<div class="domain-body">'
        + `<div class="label">${t.what}</div>${blocks(text(name).what)}`
        + `<div class="label">${t.found}</div>${own.map(classifier).join('')}`
        + `<div class="label">${t.masked}</div>${blocks(text(name).masking)}<ul class="tree">${tree(d.algorithm, new Set())}</ul>`
        + `<div class="label">${t.examples}</div><table class="xf"><thead><tr><th>${t.input}</th><th></th><th>${t.output}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
        + '</div></article>'
    }).join('\n')
    body.push(`<section class="chapter" id="g-${esc(group.id)}"><div class="chapter-head"><div class="part-n">${t.part} ${n}</div><h2>${esc(group.title)}</h2><div class="part-lede">${blocks(group.intro)}</div></div>${domainsHtml}</section>`)
  }

  const closing = []
  for (const s of content.closing ?? []) {
    n++
    toc.push({ row: [n, s.title], href: `s-${n}` })
    closing.push(sectionHtml(n, s.title, blocks(s.body), `s-${n}`))
  }
  if (closing.length) body.push(`<div class="chapter">${closing.join('\n')}</div>`)

  // Appendices. The exclusion lists are only known once every Path classifier was rendered.
  const appendices = []
  const letter = (i) => String.fromCharCode(65 + i)
  const addAppendix = (title, sectionId, inner) => {
    const num = `${t.appendix} ${letter(appendices.length)}`
    toc.push({ row: [letter(appendices.length), title], href: sectionId })
    appendices.push(sectionHtml(num, title, inner, sectionId, true))
  }
  addAppendix(t.appendixAlgorithms, 'algorithms',
    `<p>${t.appendixAlgorithmsLede}</p>${[...algorithms.values()].sort((a, b) => a.name.localeCompare(b.name)).map(algorithmEntry).join('')}`)
  addAppendix(t.appendixFiles, 'files',
    `<p>${t.appendixFilesLede}</p><table class="tbl"><thead><tr>${t.filesHead.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${
      preset.files.map((f) => `<tr><td>${code(f)}</td><td class="num">${h.num(fileLines.get(f).length)}</td><td>${fileUsers.get(f).map(code).join(' ')}</td><td class="muted">${esc(fileLines.get(f).slice(0, 4).join(' · '))}</td></tr>`).join('')
    }</tbody></table>`)
  if (exclusions.size) {
    addAppendix(t.appendixExclusions, 'exclusions',
      `<p>${inline(t.appendixExclusionsLede)}</p><table class="tbl"><tbody>${
        [...exclusions].map(([words, eid]) => `<tr><td><b>${eid}</b></td><td class="words">${words.split('|').map(code).join(' ')}</td></tr>`).join('')
      }</tbody></table>`)
  }
  addAppendix(t.appendixClassifiers, 'classifiers',
    `<p>${t.appendixClassifiersLede(code(preset.profileSet.name), preset.profileSet.threshold, preset.classifiers.length)}</p>${preset.profileSet.description ? `<p>${esc(preset.profileSet.description)}</p>` : ''}`
    + `<table class="tbl"><thead><tr>${t.classifiersHead.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${
      preset.classifiers.map((c) => `<tr><td>${code(c.name)}</td><td><span class="tag k-${c.framework}">${t.kinds[c.framework]}</span></td><td><a href="#d-${esc(c.domain)}">${code(c.domain)}</a></td></tr>`).join('')
    }</tbody></table>`)
  body.push(...appendices)

  const tocHtml = toc.map((entry) => (entry.part
    ? `<div class="toc-part">${esc(entry.part)}</div>`
    : `<a class="toc-row" href="#${esc(entry.href)}"><span class="toc-num">${esc(entry.row[0])}</span><span class="toc-name">${esc(entry.row[1])}</span>${entry.row[2] ? `<span class="toc-right">${esc(entry.row[2])}</span>` : ''}</a>`)).join('')

  const cover = `<div class="cover"><div class="cover-rule"></div><div class="cover-eyebrow">${esc(t.eyebrow)}</div>`
    + `<h1>${esc(content.title)}</h1><div class="cover-sub">${inline(content.subtitle ?? '')}</div><div class="cover-spacer"></div>`
    + '<div class="cover-facts">'
    + `<div><span class="cover-fact-n">${preset.domains.length}</span><span class="cover-fact-l">${t.facts.domains}</span></div>`
    + `<div><span class="cover-fact-n">${preset.classifiers.length}</span><span class="cover-fact-l">${t.facts.classifiers}</span></div>`
    + `<div><span class="cover-fact-n">${preset.algorithms.length}</span><span class="cover-fact-l">${t.facts.algorithms}</span></div>`
    + '</div>'
    + `<div class="cover-meta"><span>Profile set ${code(preset.profileSet.name)}</span><span>${
      preset.versionDate ? t.versionOf(preset.version, day(preset.versionDate)) : `${t.version} ${esc(preset.version)}`
    } · ${t.threshold} ${preset.profileSet.threshold}%</span></div></div>`

  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${esc(content.title)}</title><style>${CSS}</style></head><body>`
    + cover
    + `<div class="toc"><h1 class="doc-title">${t.contents}</h1><p class="doc-lede">${esc(t.contentsLede)}</p>${tocHtml}</div>`
    + body.join('\n')
    + '</body></html>'
}

// ── Build ───────────────────────────────────────────────────────────────────

const contents = Object.fromEntries(LOCALES.map((locale) => [locale, loadContent(locale)]))
const examples = loadExamples()
if (!fs.existsSync(CHROME)) fail(`Chrome not found at ${CHROME}; set CHROME.`)
const frameworks = await api('/api/frameworks')
if (!Array.isArray(frameworks)) fail(`the app did not list the frameworks: ${frameworks?.error ?? 'no answer'}`)
const displayNames = new Map(frameworks.map((f) => [f.className, f.displayName]))
const masked = await maskExamples(examples)

for (const locale of LOCALES) {
  const html = nodePath.join(os.tmpdir(), `preset-doc-${id}.${locale}.html`)
  const pdf = nodePath.join(DIR, `doc.${locale}.pdf`)
  fs.writeFileSync(html, render(locale, contents[locale], examples, masked, displayNames))
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
    '--virtual-time-budget=15000', `--print-to-pdf=${pdf}`, pathToFileURL(html).href,
  ], { stdio: 'ignore' })
  console.log(`${nodePath.relative(process.cwd(), pdf)} (${Math.round(fs.statSync(pdf).size / 1024)} KB)`)
}
