/**
 * Records docs/demo.gif — the three things the tool does, in one pass:
 *
 *   1. asking the assistant for an algorithm and watching it build one
 *   2. testing an algorithm against a real value
 *   3. syncing with a Delphix engine: importing one and sending one back
 *
 * Drives the running app in headless Chrome and encodes the frames as a GIF. No ffmpeg or
 * ImageMagick involved: Chrome decodes and rescales each screenshot on its own canvas, and
 * gifenc does the quantising.
 *
 * Requires the app running (`npm run dev`), Ollama up for scene 1, and a Delphix engine
 * configured for scene 3 — the scenes are skipped with a warning if their backing is missing.
 *
 *   node docs/record-demo.mjs [output.gif]
 */

import puppeteer from 'puppeteer-core'
import gifenc from 'gifenc'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { GIFEncoder, quantize, applyPalette } = gifenc

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP = process.env.DEMO_URL || 'http://localhost:5173'
const OUT = process.argv[2]
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo.gif')

// Captured at this size, written at SCALE of it: sharp enough to read, small enough for a README.
const VIEW = { width: 1180, height: 720 }
const SCALE = 0.66
const COLORS = 40

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const enc = GIFEncoder()
let frames = 0

/** Grabs the current screen as one GIF frame, shown for `delay` ms. */
async function shoot(page, delay = 90) {
  const png = Buffer.from(await page.screenshot({ type: 'png' })).toString('base64')
  const f = await page.evaluate(async (b64, scale) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale)
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, w, h)
    return { w, h, data: Array.from(ctx.getImageData(0, 0, w, h).data) }
  }, png, SCALE)
  const data = new Uint8ClampedArray(f.data)
  const palette = quantize(data, COLORS)
  enc.writeFrame(applyPalette(data, palette), f.w, f.h, { palette, delay })
  frames++
}

/**
 * Holds the current screen for a beat: the frame lasts `ms` on playback, and the recorder
 * really waits that long too — so the app has time to settle before the next step. Setting
 * only the frame duration would let the script race ahead of the UI.
 */
async function hold(page, ms) {
  await shoot(page, ms)
  await sleep(ms)
}

/** Types into a field the way a person does, capturing along the way. */
async function type(page, selector, text, { chunk = 3, delay = 60 } = {}) {
  await page.click(selector)
  for (let i = 0; i < text.length; i += chunk) {
    await page.type(selector, text.slice(i, i + chunk), { delay: 0 })
    await shoot(page, delay)
  }
}

/**
 * Waits for the page to reach a state, capturing while it waits. Fixed sleeps were guesswork:
 * listing a remote engine takes around eight seconds, and a shorter guess recorded an empty
 * dialog. The wait is shown time-lapsed, so the GIF does not sit on a spinner.
 */
async function waitFor(page, fn, { timeout = 40000, every = 700, delay = 70 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await page.evaluate(fn)) return true
    await sleep(every)
    await shoot(page, delay)
  }
  return false
}

/** Clicks the first element whose text matches. */
async function clickText(page, selector, re) {
  // Flags travel with the source: rebuilding the regex from `.source` alone dropped the `i`,
  // and a label like "Personal data" then failed to match /Personal Data/i.
  const handle = await page.evaluateHandle((sel, source, flags) => {
    const rx = new RegExp(source, flags)
    return [...document.querySelectorAll(sel)].find(e => rx.test(e.textContent || ''))
  }, selector, re.source, re.flags)
  const el = handle.asElement()
  if (!el) throw new Error(`no ${selector} matching ${re}`)
  await el.click()
  return el
}

// ── scenes ───────────────────────────────────────────────────────────────────

async function sceneAssistant(page) {
  console.log('  scene 1 — the assistant')
  await hold(page, 900)
  await type(page,
    'main textarea',
    'Mask a 15-char numeric column padded with leading zeros, keeping the padding.',
    { chunk: 4, delay: 55 })
  await hold(page, 500)
  await page.keyboard.press('Enter')

  // The local model takes about a minute; sample it and let the GIF play it back fast. The
  // finish line is the green "saved" card — the assistant not only answered, the configuration
  // it produced was run and accepted. Waiting on a bubble instead matched the user's own
  // message and ended the scene immediately.
  const built = await waitFor(page, () => Boolean(document.querySelector('main .bg-green-50')),
    { timeout: 180000, every: 2600, delay: 65 })
  if (!built) console.warn('     the assistant did not produce a saved algorithm in time')
  await hold(page, 3000)
}

async function sceneTest(page) {
  console.log('  scene 2 — testing an algorithm')
  await clickText(page, 'aside nav button', /Personal Data|Dados Pessoais/i)
  await sleep(400); await shoot(page, 250)
  await clickText(page, 'aside nav button', /^Phone$/)
  await sleep(1600); await hold(page, 900)

  await clickText(page, 'main button', /Example|Exemplo/i)
  await sleep(1200); await hold(page, 1100)

  await clickText(page, 'main button', /^\s*(Mask|Mascarar)\s*$/i)
  for (let i = 0; i < 8; i++) { await sleep(280); await shoot(page, 90) }
  await hold(page, 2400)
}

async function sceneSync(page) {
  console.log('  scene 3 — syncing with the engine')
  await clickText(page, 'aside button', /Saved Tests|Testes\/Algoritmos/i)
  await sleep(900); await hold(page, 800)

  await clickText(page, 'main button', /Import from Delphix|Importar do Delphix/i)
  const listed = await waitFor(page, () =>
    [...document.querySelectorAll('label')].some(l => {
      const i = l.querySelector('input[type=checkbox]'); return i && !i.disabled
    }), { every: 600, delay: 80 })
  if (!listed) throw new Error('the engine listing never arrived')
  await hold(page, 1700)

  // pick one the tool can actually run
  const picked = await page.evaluate(() => {
    const l = [...document.querySelectorAll('label')]
      .find(x => x.querySelector('input[type=checkbox]') && !x.querySelector('input').disabled)
    if (!l) return null
    l.querySelector('input').click()
    return l.textContent.trim().split('\n')[0]
  })
  console.log(`     importing ${picked}`)
  await sleep(400); await hold(page, 1200)

  await clickText(page, 'button', /Import \d+|Importar \d+/)
  await waitFor(page, () => !document.querySelector('h3')?.textContent?.match(/Import from|Importar de/),
    { every: 500, delay: 90 })
  await hold(page, 1900)

  // and push one back
  await clickText(page, 'main button', /Send to Delphix|Enviar ao Delphix/i)
  await waitFor(page, () => document.querySelectorAll('[data-sonner-toast]').length > 0,
    { every: 450, delay: 90 })
  await hold(page, 2800)
}

// ── run ──────────────────────────────────────────────────────────────────────

// The interface language is a stored setting, so it wins over the browser's. The GIF ships in
// all three READMEs and on the site, so it is recorded in English and the previous choice is
// put back afterwards.
const API = process.env.DEMO_API || 'http://localhost:3000'
const cfgBefore = await fetch(`${API}/api/config`).then(r => r.json()).catch(() => null)
const localeBefore = cfgBefore?.locale
const setLocale = (v) => fetch(`${API}/api/config`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ locale: v }),
}).catch(() => {})
if (localeBefore && localeBefore !== 'en') await setLocale('en')

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--lang=en-US'],
})
const page = await browser.newPage()
// The UI follows the browser language; the GIF ships in all three READMEs, so it is recorded
// in English, the site's default.
await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en' })
await page.setViewport(VIEW)
await page.goto(APP, { waitUntil: 'networkidle2' })
await sleep(2000)

try {
  await sceneAssistant(page)
  await sceneTest(page)
  await sceneSync(page)
} catch (err) {
  console.error(`  stopped: ${err.message}`)
}

enc.finish()
writeFileSync(OUT, Buffer.from(enc.bytes()))
await browser.close()
if (localeBefore && localeBefore !== 'en') await setLocale(localeBefore)
const kb = (Buffer.from(enc.bytes()).length / 1024).toFixed(0)
console.log(`${frames} frames -> ${OUT} (${kb} KB)`)
