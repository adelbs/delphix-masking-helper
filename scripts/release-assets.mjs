// Builds the files attached to a release, from a tag, into release-assets/<tag>/:
//
//   delphix-masking-helper-<tag>.tar.gz   the app ready to run (macOS, Linux)
//   delphix-masking-helper-<tag>.zip      the same (Windows)
//   preset-<id>.zip                       what loading a preset needs: preset.json and files/
//   preset-<id>.doc.<locale>.pdf          its documentation, one file per language
//   <id>-v<N>.zip                         its package: loads it into Delphix without the Helper
//   SHA256SUMS                            the hash of each of the above
//
// The app archive is the tag's tracked files without the presets' folders and the site (docs/),
// plus the built frontend, the production node_modules and release.json — what it is and which
// files it brought, so an update can remove the ones a newer version dropped. The Delphix jars are
// never in it: they are licensed, and each install copies its own from the Devkit.
//
// Nothing here publishes: scripts/publish-release.sh attaches these files to the release with the
// maintainer's own gh login.
//
//   node scripts/release-assets.mjs [--tag vX.Y.Z] [--out DIR] [--head]
//
// --head builds from HEAD under the tag's name without the tag existing — to try it before tagging.
// --worktree builds from the files here as they are, committed or not — to try a change before
// committing it. Neither is for publishing.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const tag = opt('--tag') ?? `v${pkg.version}`
const fromTree = args.includes('--worktree')
const fromHead = fromTree || args.includes('--head')
const out = path.resolve(opt('--out') ?? path.join(ROOT, 'release-assets', tag))
const NAME = 'delphix-masking-helper'

const run = (cmd, argv, cwd = ROOT, extra = {}) => execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...extra })
const step = (text) => console.log(`\n▸ ${text}`)
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`${tag} is not a release tag (vMAJOR.MINOR.PATCH).`)
const ref = fromHead ? 'HEAD' : tag
let commit
try { commit = run('git', ['rev-parse', `${ref}^{commit}`]).trim() } catch { throw new Error(`No ${ref} here: tag it first, or pass --head to try from HEAD.`) }
const tagged = fromTree ? pkg.version : JSON.parse(run('git', ['show', `${ref}:package.json`])).version
if (`v${tagged}` !== tag) throw new Error(`${ref} has version ${tagged} in package.json, not ${tag.slice(1)}.`)

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dlpx-release-'))
const app = path.join(work, `${NAME}-${tag}`)
fs.mkdirSync(app)

step(`${tag} — ${commit.slice(0, 7)}${fromTree ? ' (working tree, not committed)' : fromHead ? ' (HEAD, not tagged)' : ''}`)
if (fromTree) {
  // What git would commit now: tracked files and new ones it does not ignore.
  for (const f of run('git', ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    const from = path.join(ROOT, f)
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue
    fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true })
    fs.copyFileSync(from, path.join(app, f))
    fs.chmodSync(path.join(app, f), fs.statSync(from).mode & 0o777)
  }
} else {
  // The tracked files of the tag, whatever this working tree has on top.
  execFileSync('sh', ['-c', `git archive --format=tar "${ref}" | tar -x -C "${app}"`], { cwd: ROOT, stdio: 'inherit' })
}

step('Catalog of presets')
run('node', ['preset-catalog.js', '--check'], app, { stdio: 'inherit' })

step('Presets')
const req = createRequire(path.join(app, 'server.js'))
const catalog = req('./preset-catalog.js')
const { presetBundle } = req('./preset-bundle.js')
const { zip } = req('./zip.js')
for (const entry of catalog.readCatalog().presets) {
  const dir = path.join(app, 'presets', entry.id)
  const data = entry.files.filter((f) => !f.path.startsWith('doc.'))
    .map((f) => ({ path: f.path, content: fs.readFileSync(path.join(dir, ...f.path.split('/'))) }))
  fs.writeFileSync(path.join(out, catalog.assetName.data(entry.id)), zip(data))
  for (const locale of entry.docs) {
    fs.copyFileSync(path.join(dir, `doc.${locale}.pdf`), path.join(out, catalog.assetName.doc(entry.id, locale)))
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'preset.json'), 'utf8'))
  const p = { ...catalog.manifestShape(entry.id, dir, manifest), docs: entry.docs }
  fs.writeFileSync(path.join(out, `${entry.id}-v${entry.version}.zip`), presetBundle(p, catalog.presetPack))
  console.log(`  ${entry.id} v${entry.version}`)
}

step('App: dependencies and frontend')
const quiet = ['--silent', '--no-audit', '--no-fund']
run('npm', ['ci', '--omit=dev', ...quiet], app, { stdio: 'inherit' })
run('npm', ['ci', ...quiet], path.join(app, 'frontend'), { stdio: 'inherit' })
run('npm', ['run', 'build', '--silent'], path.join(app, 'frontend'), { stdio: 'inherit' })
// What only building needs, and what the app reads from elsewhere.
for (const drop of ['frontend/node_modules', 'docs', '.github', 'node_modules/.bin']) fs.rmSync(path.join(app, drop), { recursive: true, force: true })
for (const e of fs.readdirSync(path.join(app, 'presets'), { withFileTypes: true })) {
  if (e.isDirectory() && !e.name.startsWith('_')) fs.rmSync(path.join(app, 'presets', e.name), { recursive: true, force: true })
}

/** Every file under a folder, relative, with / — symlinks left out (a zip cannot hold them). */
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isSymbolicLink()) return []
    if (e.isDirectory()) return walk(full, base)
    return [path.relative(base, full).split(path.sep).join('/')]
  }).sort()
}
const files = walk(app)
fs.writeFileSync(path.join(app, 'release.json'), `${JSON.stringify({
  name: NAME, tag, version: tagged, commit, builtAt: new Date().toISOString(), files: [...files, 'release.json'].sort(),
}, null, 2)}\n`)

step('App archives')
const tarball = path.join(out, `${NAME}-${tag}.tar.gz`)
// COPYFILE_DISABLE: macOS tar would add ._ files with the extended attributes.
execFileSync('tar', ['-czf', tarball, '-C', work, `${NAME}-${tag}`], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } })
const entries = walk(app).map((f) => {
  const full = path.join(app, ...f.split('/'))
  return { path: `${NAME}-${tag}/${f}`, content: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o777 }
})
fs.writeFileSync(path.join(out, `${NAME}-${tag}.zip`), zip(entries))

step('SHA256SUMS')
const assets = fs.readdirSync(out).filter((f) => f !== 'SHA256SUMS').sort()
fs.writeFileSync(path.join(out, 'SHA256SUMS'), assets.map((f) => `${sha256(path.join(out, f))}  ${f}\n`).join(''))
fs.rmSync(work, { recursive: true, force: true })

const size = (f) => fs.statSync(path.join(out, f)).size
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`
console.log(`\n${assets.length + 1} files in ${path.relative(process.cwd(), out) || out}:`)
console.log(`  app: ${mb(size(`${NAME}-${tag}.tar.gz`))} (tar.gz), ${mb(size(`${NAME}-${tag}.zip`))} (zip)`)
console.log(`  everything: ${mb(assets.reduce((n, f) => n + size(f), 0))}`)
