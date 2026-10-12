// Hooks: scripts Delphix runs at points of a dataset's life — before a refresh, after a VDB starts,
// after a snapshot. Data Control Tower keeps reusable ones as hook templates (name, description,
// shell, command, and the credentials it hands the script as environment variables).
//
// Here a hook is written, documented, saved, run on this machine against test values, downloaded
// to try on another server, and sent to DCT as a hook template — or brought down from it.
//
//   GET|POST /api/hooks          PUT|DELETE /api/hooks/:id
//   GET  /api/hooks/runtime      which interpreters this machine has
//   POST /api/hooks/run          runs a script now; server-sent events: out, exit, error
//   POST /api/delphix/hooks/export/:id   sends one hook to DCT as a hook template
//
// What a hook runs is the user's own script, on the user's own machine, started only by a click on
// Run: the same trust as typing it in a terminal. It gets this machine's environment minus the
// secrets the tool itself holds, plus the variables filled in on screen.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const SHELLS = ['bash', 'shell', 'expect', 'ps', 'psd'];
const POWERSHELL = new Set(['ps', 'psd']);
const MAX_OUTPUT = 1024 * 1024;
const RUN_TIMEOUT_DEFAULT = 300;
const RUN_TIMEOUT_MAX = 3600;

/** Whether a command is on PATH. */
function found(command) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The program and arguments that run a script file of this shell here, or null when none can. */
function interpreter(shell, file) {
  const win = process.platform === 'win32';
  if (POWERSHELL.has(shell)) {
    // Windows PowerShell 5.1 is what a Windows host runs hooks with; PowerShell 7 where it is not.
    if (win && found('powershell.exe')) return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]];
    if (found('pwsh')) return ['pwsh', ['-NoProfile', '-NonInteractive', '-File', file]];
    return null;
  }
  if (shell === 'expect') return found('expect') ? ['expect', ['-f', file]] : null;
  if (shell === 'shell') {
    if (!win && fs.existsSync('/bin/sh')) return ['/bin/sh', [file]];
    return found('sh') ? ['sh', [file]] : null;
  }
  return found('bash') ? ['bash', [file]] : null;
}

function runtime() {
  const out = { platform: process.platform, shells: {} };
  for (const shell of SHELLS) {
    const how = interpreter(shell, 'x');
    out.shells[shell] = how ? how[0] : null;
  }
  // What a run of a new hook defaults to: the scripts this system runs natively.
  out.native = process.platform === 'win32' ? 'ps' : 'bash';
  return out;
}

// The tool's own secrets never reach a hook run here.
const PRIVATE_ENV = /^(DLPX_ENGINE_PASSWORD|DLPX_DCT_API_KEY|DLPX_AI_.*)$/;

function hookRow(r) {
  if (!r) return r;
  let credentials = [];
  let variables = [];
  try { credentials = JSON.parse(r.credentials || '[]'); } catch { /* an old shape */ }
  try { variables = JSON.parse(r.variables || '[]'); } catch { /* an old shape */ }
  return { ...r, credentials, variables };
}

/** Variable names as a shell would accept them, deduplicated. */
const varName = (v) => String(v ?? '').trim();
const isVarName = (v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);

function cleanCredentials(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(varName).filter(isVarName))];
}

/** Test values kept with the hook — never a credential's, which is asked for again at each run. */
function cleanVariables(list) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const name = varName(v?.name);
    if (!isVarName(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value: String(v?.value ?? '') });
  }
  return out;
}

module.exports = function mountHooks(app, { db, delphix, delphixCfg }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hooks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      -- What the hook is for and what it does. DCT keeps a description on a hook template too.
      description TEXT NOT NULL DEFAULT '',
      -- As DCT names them: bash, shell (sh), expect, ps (PowerShell), psd (delegated PowerShell).
      shell       TEXT NOT NULL DEFAULT 'bash',
      command     TEXT NOT NULL DEFAULT '',
      -- Base names of the credential variables DCT sets (<BASE>_USER, <BASE>_PASSWORD…), as JSON.
      -- Only the names: the values are configured in DCT, and typed again for each run here.
      credentials TEXT NOT NULL DEFAULT '[]',
      -- Test values for a run on this machine, as JSON [{name, value}].
      variables   TEXT NOT NULL DEFAULT '[]',
      -- The template this hook came from in the list of ready-made ones, if any.
      template    TEXT,
      delphix_id     TEXT,
      delphix_origin TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const get = (id) => hookRow(db.prepare('SELECT * FROM hooks WHERE id = ?').get(id));

  function validate(body, exceptId = null) {
    const name = String(body.name ?? '').trim();
    if (!name) return { code: 'name-required', error: 'A name is required.' };
    if (name.length > 256) return { code: 'name-too-long', error: 'DCT caps a hook template name at 256 characters.' };
    const clash = db.prepare('SELECT id FROM hooks WHERE name = ?').get(name);
    if (clash && clash.id !== exceptId) return { code: 'name-taken', error: `"${name}" already exists.`, status: 409 };
    if (body.shell !== undefined && !SHELLS.includes(body.shell)) return { code: 'shell-invalid', error: `shell must be one of ${SHELLS.join(', ')}.` };
    if (body.command !== undefined && String(body.command).length > 131072) {
      return { code: 'command-too-long', error: 'DCT caps a hook command at 131,072 characters.' };
    }
    return null;
  }

  app.get('/api/hooks', (req, res) => {
    res.json(db.prepare('SELECT * FROM hooks ORDER BY name COLLATE NOCASE').all().map(hookRow));
  });

  app.get('/api/hooks/runtime', (req, res) => res.json(runtime()));

  app.post('/api/hooks', (req, res) => {
    const problem = validate(req.body);
    if (problem) return res.status(problem.status ?? 400).json(problem);
    const info = db.prepare(`
      INSERT INTO hooks (name, description, shell, command, credentials, variables, template)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(req.body.name).trim(), String(req.body.description ?? ''), req.body.shell ?? 'bash',
      String(req.body.command ?? ''), JSON.stringify(cleanCredentials(req.body.credentials)),
      JSON.stringify(cleanVariables(req.body.variables)), req.body.template ? String(req.body.template) : null,
    );
    res.status(201).json(get(info.lastInsertRowid));
  });

  app.put('/api/hooks/:id', (req, res) => {
    const current = get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Hook not found' });
    const merged = { ...current, ...req.body };
    const problem = validate(merged, current.id);
    if (problem) return res.status(problem.status ?? 400).json(problem);
    db.prepare(`
      UPDATE hooks SET name = ?, description = ?, shell = ?, command = ?, credentials = ?, variables = ?,
             updated_at = datetime('now')
      WHERE id = ?
    `).run(
      String(merged.name).trim(), String(merged.description ?? ''), merged.shell, String(merged.command ?? ''),
      JSON.stringify(cleanCredentials(merged.credentials)), JSON.stringify(cleanVariables(merged.variables)), current.id,
    );
    res.json(get(current.id));
  });

  app.delete('/api/hooks/:id', (req, res) => {
    db.prepare('DELETE FROM hooks WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  /**
   * Runs a script on this machine and streams what it prints. The script is the one on screen —
   * saved or not — written to a temporary file and run by the shell it names. Leaving the page
   * stops it, and so does the time limit.
   */
  app.post('/api/hooks/run', (req, res) => {
    const shell = SHELLS.includes(req.body?.shell) ? req.body.shell : 'bash';
    const command = String(req.body?.command ?? '');
    const timeoutSec = Math.min(RUN_TIMEOUT_MAX, Math.max(1, Number(req.body?.timeoutSec) || RUN_TIMEOUT_DEFAULT));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlpx-hook-'));
    const file = path.join(dir, POWERSHELL.has(shell) ? 'hook.ps1' : shell === 'expect' ? 'hook.exp' : 'hook.sh');
    // Windows PowerShell 5.1 reads a file without a byte order mark in the ANSI code page.
    fs.writeFileSync(file, POWERSHELL.has(shell) ? `\uFEFF${command.replace(/\r?\n/g, '\r\n')}` : command.replace(/\r\n/g, '\n'));
    const how = interpreter(shell, file);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });

    if (!how) {
      send('error', { code: 'no-interpreter', shell });
      cleanup();
      return res.end();
    }

    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !PRIVATE_ENV.test(k)));
    for (const v of Array.isArray(req.body?.env) ? req.body.env : []) {
      const name = varName(v?.name);
      if (isVarName(name)) env[name] = String(v?.value ?? '');
    }

    const started = Date.now();
    const child = spawn(how[0], how[1], {
      cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so stopping it stops what it started too.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    send('start', { interpreter: how[0], pid: child.pid });

    let size = 0;
    let truncated = false;
    let timedOut = false;
    let ended = false;
    const relay = (stream) => (chunk) => {
      if (truncated) return;
      size += chunk.length;
      if (size > MAX_OUTPUT) { truncated = true; send('out', { stream: 'stderr', text: '\n[output truncated]\n' }); return; }
      send('out', { stream, text: chunk.toString('utf8') });
    };
    child.stdout.on('data', relay('stdout'));
    child.stderr.on('data', relay('stderr'));

    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGTERM');
      } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutSec * 1000);

    child.on('error', (err) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      send('error', { code: 'spawn-failed', message: err.message });
      cleanup();
      res.end();
    });
    child.on('close', (code, signal) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      send('exit', { code, signal, ms: Date.now() - started, timedOut, truncated });
      cleanup();
      res.end();
    });
    // The page went away: nobody is watching, so the run stops.
    res.on('close', () => { if (!ended) stop(); });
  });

  // ── Data Control Tower ──────────────────────────────────────────────────────

  /**
   * Sends one hook to DCT as a hook template. Credentials are never sent: the template keeps the
   * credential variables configured there, and a new one gets them added in DCT.
   */
  async function pushHook(cfg, row) {
    const out = await delphix.saveHookTemplate(cfg, {
      name: row.name, description: row.description, shell: row.shell, command: row.command,
      existingId: row.delphix_origin === delphix.origin(cfg) ? row.delphix_id : null,
    });
    db.prepare(`UPDATE hooks SET delphix_id = ?, delphix_origin = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(out.id, delphix.origin(cfg), row.id);
    return out;
  }

  app.post('/api/delphix/hooks/export/:id', async (req, res) => {
    const cfg = delphixCfg();
    if (!delphix.isConfigured(cfg)) return res.status(400).json({ code: 'not-configured', error: 'No Delphix integration configured yet.' });
    if (cfg.target !== 'dct') return res.status(400).json({ code: 'not-dct', error: 'Hook templates live in Data Control Tower; the integration points at an engine.' });
    const row = get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Hook not found' });
    try {
      const out = await pushHook(cfg, row);
      res.json({ mode: out.mode, name: out.name, id: out.id });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  /**
   * Brings DCT's hook templates down: the ones DCT manages and the ones it imported from connected
   * engines, which are as much hook templates there. Matched by DCT id first, then by name.
   */
  async function importHooks(cfg) {
    const origin = delphix.origin(cfg);
    const names = [];
    for (const h of await delphix.listHookTemplates(cfg)) {
      const shell = SHELLS.includes(h.shell) ? h.shell : 'bash';
      const existing = db.prepare('SELECT id FROM hooks WHERE delphix_id = ? AND delphix_origin = ?').get(h.id, origin)
        ?? db.prepare('SELECT id FROM hooks WHERE name = ?').get(h.name);
      const credentials = JSON.stringify(cleanCredentials((h.credentials ?? []).map((c) => c.base_var_name)));
      try {
        if (existing) {
          db.prepare(`
            UPDATE hooks SET name = ?, description = ?, shell = ?, command = ?, credentials = ?,
                   delphix_id = ?, delphix_origin = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(h.name, h.description, shell, h.command, credentials, h.id, origin, existing.id);
        } else {
          db.prepare(`
            INSERT INTO hooks (name, description, shell, command, credentials, delphix_id, delphix_origin)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(h.name, h.description, shell, h.command, credentials, h.id, origin);
        }
        names.push(h.name);
      } catch { /* a name another local hook holds */ }
    }
    return names;
  }

  /** Sends every hook saved here. */
  async function exportHooks(cfg) {
    const names = [];
    for (const row of db.prepare('SELECT * FROM hooks ORDER BY name COLLATE NOCASE').all().map(hookRow)) {
      names.push((await pushHook(cfg, row)).name);
    }
    return names;
  }

  /** Forgets the link of every hook tied to an instance, and deletes the ones that came from it. */
  function dropIntegration(origin) {
    return db.prepare('DELETE FROM hooks WHERE delphix_origin = ?').run(origin).changes;
  }

  return { importHooks, exportHooks, dropIntegration };
};
