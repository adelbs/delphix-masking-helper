/**
 * Records docs/demo.gif — what the tool does, in one pass:
 *
 *   1. testing an algorithm against a real value
 *   2. testing a classifier against a column described on screen
 *   3. the profile sets that ship with the tool
 *   4. syncing with a Delphix engine: the integration, then an algorithm that came from it
 *
 * Drives the running app in headless Chrome and encodes the frames as a GIF. No ffmpeg or
 * ImageMagick involved: Chrome decodes and rescales each screenshot on its own canvas, and
 * gifenc does the quantising.
 *
 * Requires the app running (`npm run dev`), the Chile profile set loaded (scene 2 opens one of
 * its classifiers), and a Delphix engine connected under Settings → Delphix for scene 4. There is
 * no assistant scene: with the default local provider the assistant advises and does not build,
 * so recording one would need a hosted provider.
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

/** The classifier scene 2 tests, and the engine algorithm scene 4 sends back. */
const CLASSIFIER = 'CL_L1_RUT - Regex'
const ENGINE_ALGORITHM = process.env.DEMO_ALGORITHM || 'ACCOUNT_NUMBER'

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

/** Types into an element the way a person does, capturing along the way. */
async function typeInto(page, handle, text, { chunk = 3, delay = 60 } = {}) {
  await handle.click()
  for (let i = 0; i < text.length; i += chunk) {
    await handle.type(text.slice(i, i + chunk), { delay: 0 })
    await shoot(page, delay)
  }
}

/**
 * Waits for the page to reach a state, capturing while it waits. Fixed sleeps were guesswork:
 * a call to a remote engine takes seconds, and a shorter guess recorded an empty screen. The
 * wait is shown time-lapsed, so the GIF does not sit on a spinner.
 */
async function waitFor(page, fn, { timeout = 40000, every = 700, delay = 70 } = {}, ...args) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await page.evaluate(fn, ...args)) return true
    await sleep(every)
    await shoot(page, delay)
  }
  return false
}

/**
 * The first visible element whose text matches. Visible matters: the page also renders the
 * sidebar's mobile overlay, hidden at this width, and its buttons come first in the document —
 * Puppeteer refuses to click those.
 */
async function byText(page, selector, re) {
  // Flags travel with the source: rebuilding the regex from `.source` alone dropped the `i`,
  // and a label like "Personal data" then failed to match /Personal Data/i.
  const handle = await page.evaluateHandle((sel, source, flags) => {
    const rx = new RegExp(source, flags)
    // The overlay is translated off screen, not hidden, so it still has boxes: check the viewport.
    const onScreen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > 0 && r.left < innerWidth }
    return [...document.querySelectorAll(sel)].find(e => onScreen(e) && rx.test(e.textContent || ''))
  }, selector, re.source, re.flags)
  const el = handle.asElement()
  if (!el) throw new Error(`no ${selector} matching ${re}`)
  return el
}

async function clickText(page, selector, re) {
  const el = await byText(page, selector, re)
  await el.click()
  return el
}

/** Clicks a sidebar result once the filter has produced it — a long list renders a beat later. */
async function clickSidebarItem(page, re) {
  const shown = await waitFor(page, (source, flags) => {
    const rx = new RegExp(source, flags)
    return [...document.querySelectorAll('aside nav button')].some(e => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.right > 0 && r.left < innerWidth && rx.test(e.textContent || '')
    })
  }, { timeout: 8000, every: 250, delay: 60 }, re.source, re.flags)
  if (!shown) throw new Error(`the sidebar never listed ${re}`)
  return clickText(page, 'aside nav button', re)
}

/** Replaces what the sidebar filter holds. Results come out flat, so the hit is one click away. */
async function filterSidebar(page, text) {
  const box = (await page.evaluateHandle(() =>
    [...document.querySelectorAll('aside input[type=text]')]
      .find(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > 0 && r.left < innerWidth }))).asElement()
  await clearField(box)
  if (text) await typeInto(page, box, text, { chunk: 4, delay: 55 })
  await sleep(300)
}

/**
 * Empties a React-controlled field. A triple click does not select an input's whole value in
 * headless Chrome, so the next text was appended to the old one; setting the value through the
 * native setter and firing `input` is what React listens to.
 */
async function setField(handle, value) {
  await handle.evaluate((el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}
const clearField = (handle) => setField(handle, '')

/** Scrolls the main pane so `selector` reaches the top, in steps the GIF can follow. */
async function scrollMainTo(page, selector, re, { steps = 8, offset = 12 } = {}) {
  for (let i = 1; i <= steps; i++) {
    await page.evaluate((sel, source, flags, part, off) => {
      const rx = new RegExp(source, flags)
      const el = [...document.querySelectorAll(sel)].find(e => rx.test(e.textContent || ''))
      let pane = el?.parentElement
      while (pane && !(pane.scrollHeight > pane.clientHeight && getComputedStyle(pane).overflowY !== 'visible')) pane = pane.parentElement
      if (!el || !pane) return
      const target = pane.scrollTop + el.getBoundingClientRect().top - pane.getBoundingClientRect().top - off
      pane.scrollTop = pane.scrollTop + (target - pane.scrollTop) * part
    }, selector, re.source, re.flags, i / steps, offset)
    await shoot(page, 60)
  }
}

// ── scenes ───────────────────────────────────────────────────────────────────

async function sceneTest(page) {
  console.log('  scene 1 — testing an algorithm')
  // With no stored layout the sidebar opens on Frameworks, categories closed.
  // Nothing is captured before the framework opens: the home screen carries the local-model
  // notices, which are not what this scene is about.
  await clickText(page, 'aside nav button', /Personal Data/i)
  await sleep(400)
  await clickText(page, 'aside nav button', /^Phone$/)
  await sleep(1600); await hold(page, 900)

  await clickText(page, 'main button', /Example/i)
  await sleep(1200); await hold(page, 1100)

  await clickText(page, 'main button', /^\s*Mask\s*$/i)
  for (let i = 0; i < 8; i++) { await sleep(280); await shoot(page, 90) }
  await hold(page, 2200)
}

async function sceneClassifier(page) {
  console.log('  scene 2 — testing a classifier')
  await filterSidebar(page, 'RUT - Regex')
  await clickSidebarItem(page, new RegExp(CLASSIFIER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await sleep(1400); await hold(page, 1400)

  await scrollMainTo(page, 'main h3', /^Test$/)
  await hold(page, 500)

  // The test card's own fields, found from its heading so no placeholder text is relied on.
  const card = await page.evaluateHandle(() => {
    const h = [...document.querySelectorAll('main h3')].find(e => e.textContent.trim() === 'Test')
    return h.parentElement.parentElement
  })
  const [fieldName] = await card.$$('input[type=text]')
  await typeInto(page, fieldName, 'RUT_CLIENTE', { chunk: 3, delay: 55 })
  const values = await card.$('textarea')
  await scrollMainTo(page, 'main label', /Sample values/i, { steps: 5, offset: 60 })
  await typeInto(page, values, '12.345.678-5\n9.876.543-K\n15.222.333-1', { chunk: 5, delay: 55 })
  const numbers = await card.$$('input[type=number]')
  const threshold = numbers[numbers.length - 1]
  // Set, not typed: emptying a number field makes it 0 at once, and the digits land beside it.
  await setField(threshold, '60')
  await shoot(page, 300)
  await hold(page, 500)

  await clickText(page, 'main button', /Run test/i)
  const ran = await waitFor(page, () => /This classifier/i.test(document.querySelector('main')?.textContent || ''),
    { every: 400, delay: 80 })
  if (!ran) console.warn('     the classifier test did not answer in time')
  await scrollMainTo(page, 'main h4', /This classifier/i, { steps: 10, offset: 90 })
  await hold(page, 3400)
}

async function scenePresets(page) {
  console.log('  scene 3 — pre-configured profile sets')
  await filterSidebar(page, '')
  await clickText(page, 'aside button', /^\s*Settings\s*$/)
  await sleep(700)
  await clickText(page, 'main button', /^\s*Profile Sets\s*$/)
  const listed = await waitFor(page, () => /Version \d+/.test(document.querySelector('main')?.textContent || ''),
    { every: 400, delay: 80 })
  if (!listed) console.warn('     the profile set list did not load')
  await hold(page, 2600)
  await scrollMainTo(page, 'main h3, main h4, main p', /Panama/i, { steps: 10, offset: 40 })
  await hold(page, 2200)
}

async function sceneSync(page) {
  console.log('  scene 4 — syncing with the engine')
  await clickText(page, 'main button', /^\s*Delphix\s*$/)
  await sleep(900); await hold(page, 2600)

  // An algorithm the engine sent down, open in the tester with its own Send to Delphix. The
  // scene stops short of pressing it: recording must not depend on, or change, the engine.
  await filterSidebar(page, ENGINE_ALGORITHM)
  await clickSidebarItem(page, new RegExp(`^${ENGINE_ALGORITHM}`))
  await sleep(1600); await hold(page, 3200)
  await filterSidebar(page, '')
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
await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en' })
await page.setViewport(VIEW)
// A stored layout from an earlier visit would change what the first clicks open.
await page.evaluateOnNewDocument(() => {
  try { localStorage.removeItem('dlpx.sidebar.open'); localStorage.removeItem('dlpx.sidebar.groupBy') } catch {}
})
await page.goto(APP, { waitUntil: 'networkidle2' })
await sleep(2000)

try {
  await sceneTest(page)
  await sceneClassifier(page)
  await scenePresets(page)
  await sceneSync(page)
} catch (err) {
  // The screen the scene gave up on says more than the message does.
  const shot = OUT.replace(/\.gif$/, '') + '.stopped.png'
  await page.screenshot({ path: shot }).catch(() => {})
  console.error(`  stopped: ${err.message} (screen saved to ${shot})`)
}

enc.finish()
writeFileSync(OUT, Buffer.from(enc.bytes()))
await browser.close()
if (localeBefore && localeBefore !== 'en') await setLocale(localeBefore)
const kb = (Buffer.from(enc.bytes()).length / 1024).toFixed(0)
console.log(`${frames} frames -> ${OUT} (${kb} KB)`)
