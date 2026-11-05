import type { HookShell, HookVariable } from '@/types'

/**
 * Writes hooks that drive Data Control Tower from a VDB: the masking connection, the rule set, the
 * discovery and masking jobs, the job collection, running them, refreshing the child VDBs.
 *
 * One plan, three languages. POSIX sh serves bash and sh alike (a Delphix host has curl, grep and
 * sed, rarely jq). PowerShell stays within Windows PowerShell 5.1. Expect has no HTTP or JSON of its
 * own, so an expect hook runs the sh script. Every object is looked up by name and created only when
 * it is missing, so the same hook can run at every refresh.
 *
 * DCT behaviour this relies on, measured against a DCT 3.30 lab on 2026-11-04:
 *
 * - A write answers {id?, job}; the job is followed at GET /jobs/{id}. A job collection's create
 *   answers no id: it is the job's target_id.
 * - POST /<objects>/search takes {filter_expression: "name eq '…' and …"} and answers
 *   {items, response_metadata: {total}}. Compliance jobs filter on type, the rest on dct_managed.
 * - A connector needs a job orchestrator; an Oracle one takes hostname + port + sid, or jdbc_url.
 * - POST /connectors/{id}/test answers {status: SUCCEEDED|FAILED, message} — the wait for the
 *   database to take connections. Adding tables to a rule set fails while the connection does not
 *   work ("This connector does not have a valid connection").
 * - fetch-table-names answers the names at once; a rule set's tables are read from
 *   /database-table-metadata/search; bulk-table-delta-update adds and deletes them.
 * - The VDB record carries what a connection needs: fqdn, jdbc_connection_string (port, Oracle
 *   service), database_name, instance_name. A child VDB has parent_id = the parent's id.
 */

export type DbKind = 'ORACLE' | 'MSSQL' | 'POSTGRES' | 'MYSQL' | 'MARIADB' | 'DB2' | 'SYBASE'
export const DB_KINDS: DbKind[] = ['ORACLE', 'MSSQL', 'POSTGRES', 'MYSQL', 'MARIADB', 'DB2', 'SYBASE']

/** A job or collection to run: the one the hook prepared, or another, by name or id. */
export interface RunTarget { on: boolean; use: 'created' | 'other'; ref: string }

export interface WizardSpec {
  kind: 'hook-wizard'
  version: 1
  shell: HookShell
  dct: {
    url: string
    insecure: boolean
    /** Base name of the credential whose password is the API key. */
    keyCredential: string
    timeoutMinutes: number
  }
  vdb: {
    db: DbKind
    /** env: from the variables Delphix sets for the hook; name or id: one VDB, fixed. */
    find: 'env' | 'name' | 'id'
    value: string
  }
  connector: {
    on: boolean
    name: string
    /** Base name of the credential with the database user and password. */
    credential: string
    host: string
    port: string
    database: string
    instance: string
    schema: string
    oracleMode: 'sid' | 'jdbc'
    sid: string
    /** A job orchestrator id; empty takes DCT's only one. */
    orchestrator: string
  }
  waitReady: { on: boolean; minutes: number }
  ruleSet: { on: boolean; name: string }
  discoveryJob: { on: boolean; name: string; policy: string }
  maskingJob: { on: boolean; name: string }
  collection: { on: boolean; name: string; failureHandling: 'CANCEL_ALL' | 'CANCEL_SUBSEQUENT' | 'IGNORE' }
  runDiscovery: RunTarget
  runMasking: RunTarget
  runCollection: RunTarget
  refreshChildren: { on: boolean; wait: boolean; snapshotFirst: boolean }
  log: { on: boolean; path: string }
}

export type StepId =
  | 'connector' | 'waitReady' | 'ruleSet' | 'discoveryJob' | 'maskingJob' | 'collection'
  | 'runDiscovery' | 'runMasking' | 'runCollection' | 'refreshChildren' | 'log'

export const STEP_IDS: StepId[] = [
  'connector', 'waitReady', 'ruleSet', 'discoveryJob', 'maskingJob', 'collection',
  'runDiscovery', 'runMasking', 'runCollection', 'refreshChildren', 'log',
]

/** What a step needs turned on before it. */
export const STEP_NEEDS: Partial<Record<StepId, StepId[]>> = {
  waitReady: ['connector'],
  ruleSet: ['connector'],
  discoveryJob: ['ruleSet'],
  maskingJob: ['ruleSet'],
}

/**
 * Names and fields take [TOKENS]: these come from the VDB as DCT describes it, TIMESTAMP from the
 * start of the run, and any other [NAME] is the environment variable NAME.
 */
export const VDB_TOKENS = [
  'VDB_NAME', 'VDB_ID', 'VDB_HOST', 'VDB_PORT', 'VDB_DATABASE', 'VDB_SERVICE', 'VDB_INSTANCE',
  'VDB_JDBC', 'VDB_GROUP', 'VDB_ENVIRONMENT', 'VDB_PARENT', 'ENGINE_NAME',
] as const
const TOKEN = /\[([A-Za-z_][A-Za-z0-9_]*)\]/g
const isVdbToken = (name: string) => (VDB_TOKENS as readonly string[]).includes(name)

export function defaultSpec(shell: HookShell, dct?: { url?: string; insecure?: boolean }): WizardSpec {
  return {
    kind: 'hook-wizard',
    version: 1,
    shell,
    dct: { url: dct?.url || 'https://dct.example.com', insecure: dct?.insecure ?? false, keyCredential: 'DCT_API_KEY', timeoutMinutes: 240 },
    vdb: { db: 'ORACLE', find: 'env', value: '' },
    connector: {
      on: true, name: '[VDB_NAME]', credential: 'MASKING_DB', host: '[VDB_HOST]', port: '[VDB_PORT]',
      database: '[VDB_DATABASE]', instance: '[VDB_INSTANCE]', schema: '', oracleMode: 'sid', sid: '[VDB_SERVICE]', orchestrator: '',
    },
    waitReady: { on: true, minutes: 15 },
    ruleSet: { on: true, name: '[VDB_NAME]' },
    discoveryJob: { on: true, name: 'Discovery - [VDB_NAME]', policy: '' },
    maskingJob: { on: true, name: 'Masking - [VDB_NAME]' },
    collection: { on: false, name: 'Collection - [VDB_NAME]', failureHandling: 'CANCEL_ALL' },
    runDiscovery: { on: true, use: 'created', ref: '' },
    runMasking: { on: true, use: 'created', ref: '' },
    runCollection: { on: false, use: 'created', ref: '' },
    refreshChildren: { on: false, wait: true, snapshotFirst: true },
    log: { on: true, path: '/tmp/delphix-hook-[TIMESTAMP].log' },
  }
}

/** The schema a connection usually starts from, for the field's placeholder. */
export const defaultSchema = (db: DbKind, credential: string) =>
  db === 'ORACLE' || db === 'DB2' ? `[${credential}_USER]` : db === 'MSSQL' || db === 'SYBASE' ? 'dbo' : db === 'POSTGRES' ? 'public' : ''

/** Reads a saved wizard plan back, or null when the hook was not made by the wizard. */
export function parseSpec(raw: string | null | undefined): WizardSpec | null {
  if (!raw) return null
  try {
    const spec = JSON.parse(raw)
    if (spec?.kind !== 'hook-wizard' || spec.version !== 1) return null
    // A plan saved by an older wizard gains the fields added since.
    const base = defaultSpec(spec.shell ?? 'bash')
    const out = { ...base, ...spec } as WizardSpec
    for (const key of Object.keys(base) as Array<keyof WizardSpec>) {
      if (typeof base[key] === 'object' && base[key] !== null) (out as unknown as Record<string, unknown>)[key] = { ...(base[key] as object), ...(spec[key] ?? {}) }
    }
    return out
  } catch {
    return null
  }
}

/** Steps whose prerequisites are off are off too, whatever the plan says. */
export function effective(spec: WizardSpec): WizardSpec {
  const s = structuredClone(spec)
  for (const id of STEP_IDS) {
    if ((STEP_NEEDS[id] ?? []).some(dep => !s[dep].on)) s[id].on = false
  }
  if (!s.discoveryJob.on && !s.maskingJob.on) s.collection.on = false
  if (s.runDiscovery.use === 'created' && !s.discoveryJob.on) s.runDiscovery.use = 'other'
  if (s.runMasking.use === 'created' && !s.maskingJob.on) s.runMasking.use = 'other'
  if (s.runCollection.use === 'created' && !s.collection.on) s.runCollection.use = 'other'
  return s
}

/** The text fields that can name tokens, for knowing whether the VDB must be looked up. */
function templates(s: WizardSpec): string[] {
  const out: string[] = []
  if (s.connector.on) out.push(s.connector.name, s.connector.host, s.connector.port, s.connector.database, s.connector.instance, s.connector.schema, s.connector.sid)
  if (s.ruleSet.on) out.push(s.ruleSet.name)
  if (s.discoveryJob.on) out.push(s.discoveryJob.name, s.discoveryJob.policy)
  if (s.maskingJob.on) out.push(s.maskingJob.name)
  if (s.collection.on) out.push(s.collection.name)
  for (const run of [s.runDiscovery, s.runMasking, s.runCollection]) if (run.on && run.use === 'other') out.push(run.ref)
  if (s.log.on) out.push(s.log.path)
  return out
}

export function needsVdb(spec: WizardSpec): boolean {
  const s = effective(spec)
  return s.connector.on || s.refreshChildren.on
    || templates(s).some(text => [...text.matchAll(TOKEN)].some(m => isVdbToken(m[1])))
}

/** The environment variables the script reads, for the test variables and the summary. */
export function envNames(spec: WizardSpec): string[] {
  const s = effective(spec)
  const names = new Set<string>(['DCT_URL', 'DCT_INSECURE', 'DCT_TIMEOUT_MINUTES'])
  if (needsVdb(s) && s.vdb.find === 'env') for (const n of vdbVariables(s.vdb.db)) names.add(n)
  for (const text of templates(s)) for (const m of text.matchAll(TOKEN)) if (!isVdbToken(m[1]) && m[1] !== 'TIMESTAMP') names.add(m[1])
  return [...names]
}

/**
 * What a run on this machine needs to try the hook: the variables Delphix would set (DCT_* have
 * their defaults in the script), and the parts of the credentials it reads — the API key taken
 * from the integration when it has one.
 */
export function testVariables(spec: WizardSpec, settingsKey: boolean): HookVariable[] {
  const s = effective(spec)
  const out: HookVariable[] = envNames(spec).filter(n => !n.startsWith('DCT_')).map(name => ({ name, value: '' }))
  out.push({ name: `${s.dct.keyCredential}_PASSWORD`, value: '', secret: true, ...(settingsKey ? { fromSettings: true } : {}) })
  if (s.connector.on) {
    out.push({ name: `${s.connector.credential}_USER`, value: '' }, { name: `${s.connector.credential}_PASSWORD`, value: '', secret: true })
  }
  return out
}

/** The credential base names the hook template must have. */
export function credentialNames(spec: WizardSpec): string[] {
  const s = effective(spec)
  return [...new Set([s.dct.keyCredential, ...(s.connector.on ? [s.connector.credential] : [])])]
}

/** The variables Delphix sets for a hook on a VDB of this kind, used to find it in DCT. */
export function vdbVariables(db: DbKind): string[] {
  return db === 'ORACLE' ? ['DELPHIX_DATABASE_NAME', 'ORACLE_SID'] : db === 'MSSQL' ? ['VDB_DATABASE_NAME'] : ['DLPX_DATA_DIRECTORY']
}

// ── Languages ────────────────────────────────────────────────────────────────

type Lang = 'sh' | 'ps'
const langOf = (shell: HookShell): Lang => (shell === 'ps' || shell === 'psd' ? 'ps' : 'sh')
const D = '$'

/**
 * A text with [TOKENS] as a double-quoted string of the language. `early` is for a value read
 * before the VDB is looked up — the log file — where a VDB token is still empty.
 */
function expr(lang: Lang, text: string, early = false): string {
  let out = ''
  let at = 0
  for (const m of text.matchAll(TOKEN)) {
    out += lit(lang, text.slice(at, m.index))
    const name = m[1]
    if (lang === 'sh') out += name === 'TIMESTAMP' ? `${D}{RUN_TS}` : isVdbToken(name) && !early ? `${D}{${name}}` : `${D}{${name}:-}`
    else out += name === 'TIMESTAMP' ? `${D}(${D}RunTs)` : isVdbToken(name) ? `${D}(${D}${name})` : `${D}(${D}env:${name})`
    at = (m.index ?? 0) + m[0].length
  }
  out += lit(lang, text.slice(at))
  return `"${out}"`
}

function lit(lang: Lang, text: string): string {
  return lang === 'sh' ? text.replace(/[\\$`"]/g, c => `\\${c}`) : text.replace(/[`$"]/g, c => `\`${c}`)
}

/** A plain single-quoted string. */
const quote = (lang: Lang, text: string) => (lang === 'sh' ? `'${text.replace(/'/g, `'\\''`)}'` : `'${text.replace(/'/g, "''")}'`)

const indent = (code: string, by = '  ') => code.split('\n').map(l => (l ? by + l : l)).join('\n')

export const HELPERS_MARK = '---- DCT helpers'

// ── POSIX sh ─────────────────────────────────────────────────────────────────

function shSettings(s: WizardSpec): string {
  const key = `${s.dct.keyCredential}_PASSWORD`
  return String.raw`# ---- Data Control Tower ------------------------------------------------------
# Each value can be overridden by a variable of the same name on the hook.
DCT_URL="${D}{DCT_URL:-${lit('sh', s.dct.url)}}"
DCT_INSECURE="${D}{DCT_INSECURE:-${s.dct.insecure ? 'true' : 'false'}}"
DCT_TIMEOUT_MINUTES="${D}{DCT_TIMEOUT_MINUTES:-${s.dct.timeoutMinutes}}"
DCT_KEY="${D}{${key}:-}"
[ -n "$DCT_KEY" ] || { echo "Add a credential named ${s.dct.keyCredential} to the hook, with a DCT API key as its password." >&2; exit 2; }
`
}

const SH_HELPERS = String.raw`# ${HELPERS_MARK} -------------------------------------------------------------
API="${D}{DCT_URL%/}"
case "$API" in http://*|https://*) ;; *) API="https://$API" ;; esac
case "$API" in */dct/v3) ;; *) API="$API/dct/v3" ;; esac
DCT_KEY="${D}{DCT_KEY#apk }"
CURL_K=""
[ "$DCT_INSECURE" = true ] && CURL_K="-k"
RUN_TS=$(date '+%Y%m%d-%H%M%S')

say() { echo "$(date '+%H:%M:%S') $*"; }
die() { echo "$(date '+%H:%M:%S') ERROR: $*" >&2; exit 1; }

# JSON without jq — enough for DCT's compact answers: the first value of a key.
jstr() { grep -o "\"$1\" *: *\"[^\"]*\"" | head -n 1 | sed 's/^[^:]*: *"//; s/"$//'; }
jnum() { grep -o "\"$1\" *: *[0-9][0-9]*" | head -n 1 | sed 's/^.*: *//'; }
# A text made safe inside a JSON string.
jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# api METHOD PATH [BODY]: DCT's answer in $RESP, the HTTP status in $STATUS (000: unreachable).
_curl() {
  curl -sS $CURL_K --max-time 120 -H "Authorization: apk $DCT_KEY" -H 'Accept: application/json' \
    -H 'Content-Type: application/json' -w '\n%{http_code}' "$@"
}
api() {
  if [ $# -ge 3 ]; then _out=$(_curl -X "$1" -d "$3" "$API$2"); else _out=$(_curl -X "$1" "$API$2"); fi
  if [ $? -ne 0 ]; then STATUS=000; RESP=""; return 0; fi
  STATUS=$(printf '%s\n' "$_out" | tail -n 1)
  RESP=$(printf '%s\n' "$_out" | sed '$d')
}
# The same, stopping the hook when DCT cannot be reached or refuses.
api_ok() {
  api "$@"
  case "$STATUS" in
    2??) ;;
    000) die "could not reach $API" ;;
    *) _msg=$(printf '%s' "$RESP" | jstr error_description)
       [ -n "$_msg" ] || _msg=$(printf '%s' "$RESP" | cut -c1-400)
       die "DCT refused $1 $2 (HTTP $STATUS): $_msg" ;;
  esac
}

# The DCT job a write started.
job_id() { printf '%s' "$RESP" | sed 's/^.*"job" *: *.//' | jstr id; }

# Follows a DCT job to its end: returns when it completed, stops the hook when it did not.
wait_job() {
  [ -n "$1" ] || return 0
  _deadline=$(( $(date +%s) + DCT_TIMEOUT_MINUTES * 60 )); _last=""
  while :; do
    api GET "/jobs/$1"
    if [ "$STATUS" = 200 ]; then
      _state=$(printf '%s' "$RESP" | jstr status)
      _pct=$(printf '%s' "$RESP" | jnum percent_complete)
      if [ "$_state" != "$_last" ]; then say "  $2: $_state${D}{_pct:+ ($_pct%)}"; _last=$_state; fi
      case "$_state" in
        COMPLETED) return 0 ;;
        FAILED|CANCELED|TIMEDOUT|ABANDONED|SUSPENDED) die "$2 ended as $_state: $(printf '%s' "$RESP" | jstr error_details)" ;;
      esac
    fi
    [ "$(date +%s)" -ge "$_deadline" ] && die "$2 still running after $DCT_TIMEOUT_MINUTES minutes (it goes on in DCT)"
    sleep 10
  done
}

# find_named PATH NAME [FILTER]: the first match by name in $FOUND, its id in $FOUND_ID ("" if none).
find_named() {
  api_ok POST "$1/search?limit=10" "{\"filter_expression\":\"name eq '$(jesc "$2")'${D}{3:+ and $3}\"}"
  FOUND=$(printf '%s' "$RESP" | sed 's/^[^[]*\[//')
  case "$FOUND" in "]"*) FOUND_ID="" ;; *) FOUND_ID=$(printf '%s' "$FOUND" | jstr id) ;; esac
}

# resolve PATH REF [FILTER]: the id of an object named, or with the id, REF; stops when there is none.
resolve() {
  [ -n "$2" ] || die "nothing given to look for at $1"
  case "$2" in *" "*) STATUS=404 ;; *) api GET "$1/$2" ;; esac
  if [ "$STATUS" = 200 ]; then RESOLVED=$(printf '%s' "$RESP" | jstr id); return 0; fi
  find_named "$1" "$2" "${D}{3:-}"
  [ -n "$FOUND_ID" ] || die "DCT has nothing at $1 named, or with the id, \"$2\""
  RESOLVED=$FOUND_ID
}

# Reads what the steps need from a VDB as DCT describes it.
read_vdb() {
  VDB_ID=$(printf '%s' "$1" | jstr id)
  VDB_NAME=$(printf '%s' "$1" | jstr name)
  VDB_DATABASE=$(printf '%s' "$1" | jstr database_name)
  VDB_INSTANCE=$(printf '%s' "$1" | jstr instance_name)
  VDB_JDBC=$(printf '%s' "$1" | jstr jdbc_connection_string | sed 's/\\\\/\\/g')
  VDB_HOST=$(printf '%s' "$1" | jstr fqdn)
  [ -n "$VDB_HOST" ] || VDB_HOST=$(printf '%s' "$1" | jstr ip_address)
  VDB_PORT=$(printf '%s' "$VDB_JDBC" | sed -n 's/.*PORT=\([0-9][0-9]*\).*/\1/p')
  [ -n "$VDB_PORT" ] || VDB_PORT=$(printf '%s' "$VDB_JDBC" | sed -n 's/^.*:\([0-9][0-9]*\)\([/;?].*\)\{0,1\}$/\1/p')
  VDB_SERVICE=$(printf '%s' "$VDB_JDBC" | sed -n 's/.*SERVICE_NAME=\([^)]*\).*/\1/p')
  [ -n "$VDB_SERVICE" ] || VDB_SERVICE=$VDB_DATABASE
  VDB_GROUP=$(printf '%s' "$1" | jstr group_name)
  VDB_ENVIRONMENT=$(printf '%s' "$1" | jstr environment_name)
  VDB_PARENT=$(printf '%s' "$1" | jstr parent_name)
  ENGINE_NAME=$(printf '%s' "$1" | jstr engine_name)
}

# rs_tables RULE_SET_ID: its tables in $TABLES, as JSON objects {"table_name": …} joined by commas.
rs_tables() {
  TABLES=""; _cursor=""
  while :; do
    api_ok POST "/database-table-metadata/search?limit=1000${D}{_cursor:+&cursor=$_cursor}" "{\"filter_expression\":\"rule_set_id eq '$1'\"}"
    _page=$(printf '%s' "$RESP" | grep -o '"table_name" *: *"[^"]*"' | sed 's/^[^:]*: *\(.*\)$/{"table_name":\1}/' | paste -s -d, -)
    [ -n "$_page" ] && TABLES="${D}{TABLES:+$TABLES,}$_page"
    _cursor=$(printf '%s' "$RESP" | jstr next_cursor)
    [ -n "$_cursor" ] || break
  done
}

# find_job REF TYPE: a compliance job by id or name in $JOB_ID; an id DCT does not list as one is
# kept as it is — a masking job of an engine DCT runs through /masking-jobs.
find_job() {
  [ -n "$1" ] || die "no $2 job given"
  case "$1" in *" "*) STATUS=404 ;; *) api GET "/compliance-jobs/$1" ;; esac
  if [ "$STATUS" = 200 ]; then JOB_ID=$1; return 0; fi
  find_named /compliance-jobs "$1" "type eq '$2'"
  if [ -n "$FOUND_ID" ]; then JOB_ID=$FOUND_ID; return 0; fi
  case "$1" in *" "*) die "DCT has no $2 job named \"$1\"" ;; esac
  JOB_ID=$1
}

# run_job ID LABEL: runs a compliance job — or an engine's masking job — and waits for it.
run_job() {
  api POST "/compliance-jobs/$1/execute" '{}'
  [ "$STATUS" = 404 ] && api POST "/masking-jobs/$1/execute" '{}'
  case "$STATUS" in
    2??) ;;
    000) die "could not reach $API" ;;
    *) die "DCT refused to run the $2 (HTTP $STATUS): $(printf '%s' "$RESP" | jstr error_description)" ;;
  esac
  wait_job "$(job_id)" "$2"
}
`

/** The connection fields of one database kind, as the body of a DCT connector. */
function shConnectorFields(s: WizardSpec): string {
  const c = s.connector
  const lines: string[] = []
  const str = (key: string, value: string) => `\\"${key}\\":\\"$(jesc "${value}")\\"`
  if (s.vdb.db === 'ORACLE' && c.oracleMode === 'jdbc') {
    lines.push(str('jdbc_url', '$CONN_JDBC'))
  } else {
    lines.push(str('hostname', '$CONN_HOST'), `\\"port\\":$CONN_PORT`)
    if (s.vdb.db === 'ORACLE') lines.push(str('sid', '$CONN_SID'))
    else lines.push(str('database_name', '$CONN_DATABASE'))
    if (s.vdb.db === 'MSSQL' && c.instance.trim()) lines.push(str('instance_name', '$CONN_INSTANCE'))
  }
  lines.push(str('schema_name', '$CONN_SCHEMA'), str('username', '$DB_USER'))
  return lines.join(',')
}

function shSections(spec: WizardSpec): Record<string, string> {
  const s = effective(spec)
  const c = s.connector
  const db = s.vdb.db
  const out: Record<string, string> = {}
  const L = (text: string) => expr('sh', text)

  // The VDB
  if (s.vdb.find === 'id') {
    out.findVdb = String.raw`# ---- The VDB this hook runs for, as DCT knows it
VDB_KEY=${L(s.vdb.value)}
[ -n "$VDB_KEY" ] || die "no VDB id given"
api_ok GET "/vdbs/$VDB_KEY"
read_vdb "$RESP"
say "VDB $VDB_NAME ($VDB_ID)"
`
  } else {
    let lookup: string
    let filter: string
    if (s.vdb.find === 'name') {
      lookup = `VDB_KEY=${L(s.vdb.value)}`
      filter = `name eq '$(jesc "$VDB_KEY")'`
    } else if (db === 'ORACLE') {
      lookup = `VDB_KEY="${D}{DELPHIX_DATABASE_NAME:-${D}{ORACLE_SID:-}}"`
      filter = `database_name eq '$(jesc "$VDB_KEY")'`
    } else if (db === 'MSSQL') {
      lookup = `VDB_KEY="${D}{VDB_DATABASE_NAME:-}"`
      filter = `database_name eq '$(jesc "$VDB_KEY")' or name eq '$(jesc "$VDB_KEY")'`
    } else {
      lookup = `VDB_KEY="${D}{DLPX_DATA_DIRECTORY:-}"`
      filter = `database_name CONTAINS '$(jesc "$VDB_KEY")'`
    }
    const missing = s.vdb.find === 'env'
      ? `the variables Delphix sets for a hook are missing (${vdbVariables(db).join(', ')}): is this running as a VDB hook?`
      : 'no VDB name given'
    out.findVdb = String.raw`# ---- The VDB this hook runs for, as DCT knows it
${lookup}
[ -n "$VDB_KEY" ] || die "${missing}"
api_ok POST "/vdbs/search?limit=10" "{\"filter_expression\":\"${filter}\"}"
case "$(printf '%s' "$RESP" | jnum total)" in
  1) ;;
  0) die "DCT has no VDB for \"$VDB_KEY\"" ;;
  *) die "several VDBs match \"$VDB_KEY\": name the VDB in the hook" ;;
esac
read_vdb "$(printf '%s' "$RESP" | sed 's/^[^[]*\[//')"
say "VDB $VDB_NAME ($VDB_ID)"
`
  }

  if (c.on) {
    const schema = c.schema.trim() || defaultSchema(db, c.credential)
    const values: string[] = []
    if (db === 'ORACLE' && c.oracleMode === 'jdbc') {
      values.push('CONN_JDBC="$VDB_JDBC"')
    } else {
      values.push(`CONN_HOST=${L(c.host)}`, `CONN_PORT=${L(c.port)}`)
      if (db === 'ORACLE') values.push(`CONN_SID=${L(c.sid)}`)
      else values.push(`CONN_DATABASE=${L(c.database)}`)
      if (db === 'MSSQL' && c.instance.trim()) values.push(`CONN_INSTANCE=${L(c.instance)}`)
    }
    values.push(`CONN_SCHEMA=${L(schema)}`)
    const portCheck = db === 'ORACLE' && c.oracleMode === 'jdbc'
      ? '[ -n "$CONN_JDBC" ] || die "DCT gives no JDBC URL for the VDB"'
      : `case "$CONN_PORT" in ''|*[!0-9]*) die "no port for the connection (got \\"$CONN_PORT\\"): set it in the hook" ;; esac`
    out.connector = String.raw`# ---- Masking connection: updated to point at this VDB, or created
CONN_NAME=${L(c.name)}
DB_USER="${D}{${c.credential}_USER:-}"
DB_PASSWORD="${D}{${c.credential}_PASSWORD:-}"
[ -n "$DB_USER" ] || die "add a credential named ${c.credential} to the hook: the database user and password masking connects with"
${values.join('\n')}
${portCheck}
CONN_FIELDS="${shConnectorFields(s)}"
[ -n "$DB_PASSWORD" ] && CONN_FIELDS="$CONN_FIELDS,\"password\":\"$(jesc "$DB_PASSWORD")\""
say "Masking connection \"$CONN_NAME\""
find_named /connectors "$CONN_NAME" "dct_managed eq true"
if [ -n "$FOUND_ID" ]; then
  CONN_TYPE=$(printf '%s' "$FOUND" | jstr database_type)
  [ "$CONN_TYPE" = ${db} ] || die "connection \"$CONN_NAME\" exists for $CONN_TYPE, and this VDB is ${db}"
  CONN_ID=$FOUND_ID
  api_ok PATCH "/connectors/$CONN_ID" "{$CONN_FIELDS}"
  wait_job "$(job_id)" "updating the connection"
else
  [ -n "$DB_PASSWORD" ] || die "credential ${c.credential} has no password, and a new connection needs one"
  ${c.orchestrator.trim()
    ? `ORCH_ID=${quote('sh', c.orchestrator.trim())}`
    : String.raw`api_ok GET "/job-orchestrators?limit=2"
  [ "$(printf '%s' "$RESP" | jnum total)" = 1 ] || die "DCT has several job orchestrators: pick one in the hook"
  ORCH_ID=$(printf '%s' "$RESP" | sed 's/^[^[]*\[//' | jstr id)`}
  api_ok POST /connectors "{\"name\":\"$(jesc "$CONN_NAME")\",\"type\":\"DATABASE\",\"database_type\":\"${db}\",\"job_orchestrator_id\":\"$ORCH_ID\",$CONN_FIELDS}"
  CONN_ID=$(printf '%s' "$RESP" | jstr id)
  wait_job "$(job_id)" "creating the connection"
fi
`
  }

  if (s.waitReady.on) {
    out.waitReady = String.raw`# ---- Waits for the database to take connections: a VDB just started may still be opening
say "Waiting for the database to accept connections"
_until=$(( $(date +%s) + ${s.waitReady.minutes} * 60 )); _seen=""
while :; do
  api POST "/connectors/$CONN_ID/test" '{}'
  _state=$(printf '%s' "$RESP" | jstr status)
  [ "$_state" = SUCCEEDED ] && { say "  connected"; break; }
  _msg=$(printf '%s' "$RESP" | jstr message | sed 's/\\n$//')
  # A refused login will not get better by waiting.
  case "$_msg" in *ORA-01017*|*"Login failed"*|*"password authentication failed"*|*"Access denied"*) die "the database refused the login: $_msg" ;; esac
  [ "$_msg" != "$_seen" ] && { say "  not yet: ${D}{_msg:-HTTP $STATUS}"; _seen=$_msg; }
  [ "$(date +%s)" -ge "$_until" ] && die "the database did not accept connections in ${s.waitReady.minutes} minutes: $_msg"
  sleep 15
done
`
  }

  if (s.ruleSet.on) {
    out.ruleSet = String.raw`# ---- Rule set: every table the connection sees, added again from scratch
RS_NAME=${L(s.ruleSet.name)}
say "Rule set \"$RS_NAME\""
find_named /rule-sets "$RS_NAME" "dct_managed eq true"
if [ -n "$FOUND_ID" ]; then
  RS_ID=$FOUND_ID
  [ "$(printf '%s' "$FOUND" | jstr connector_id)" = "$CONN_ID" ] || die "rule set \"$RS_NAME\" exists on another connection ($(printf '%s' "$FOUND" | jstr connector_name))"
  rs_tables "$RS_ID"
  if [ -n "$TABLES" ]; then
    api_ok POST "/rule-sets/$RS_ID/bulk-table-delta-update" "{\"delete\":[$TABLES]}"
    wait_job "$(job_id)" "removing the tables"
  fi
else
  api_ok POST /rule-sets "{\"name\":\"$(jesc "$RS_NAME")\",\"connector_id\":\"$CONN_ID\"}"
  RS_ID=$(printf '%s' "$RESP" | jstr id)
  wait_job "$(job_id)" "creating the rule set"
fi
api_ok POST "/connectors/$CONN_ID/fetch-table-names" '{}'
TABLES=$(printf '%s' "$RESP" | sed -n 's/^.*"items" *: *\[\([^]]*\)\].*$/\1/p' | sed 's/"\([^"]*\)"/{"table_name":"\1"}/g')
[ -n "$TABLES" ] || die "the connection sees no tables (user $DB_USER, schema $CONN_SCHEMA)"
say "  $(printf '%s' "$TABLES" | grep -o table_name | wc -l | tr -d ' ') tables"
api_ok POST "/rule-sets/$RS_ID/bulk-table-delta-update" "{\"add\":[$TABLES]}"
wait_job "$(job_id)" "adding the tables"
`
  }

  const job = (key: 'discoveryJob' | 'maskingJob', type: 'DISCOVERY' | 'MASKING', varName: string, label: string) => {
    const policy = type === 'DISCOVERY'
    const fields = policy
      ? `\\"rule_set_id\\":\\"$RS_ID\\",\\"discovery_policy_id\\":\\"$POLICY_ID\\",\\"reset_profiling_assignments\\":true`
      : `\\"rule_set_id\\":\\"$RS_ID\\"`
    return String.raw`# ---- ${label}${policy ? ' (clears the previous automatic data class assignments)' : ''}
${varName}_NAME=${L(s[key].name)}
say "${label} \"$${varName}_NAME\""
${policy ? `resolve /discovery-policies ${L((s.discoveryJob.policy || '').trim())}\nPOLICY_ID=$RESOLVED\n` : ''}find_named /compliance-jobs "$${varName}_NAME" "type eq '${type}'"
if [ -n "$FOUND_ID" ]; then
  ${varName}_ID=$FOUND_ID
  api_ok PATCH "/compliance-jobs/$${varName}_ID" "{${fields}}"
  wait_job "$(job_id)" "updating the ${label.toLowerCase()}"
else
  api_ok POST /compliance-jobs "{\"name\":\"$(jesc "$${varName}_NAME")\",\"type\":\"${type}\",${fields}}"
  ${varName}_ID=$(printf '%s' "$RESP" | jstr id)
  wait_job "$(job_id)" "creating the ${label.toLowerCase()}"
fi
`
  }
  if (s.discoveryJob.on) out.discoveryJob = job('discoveryJob', 'DISCOVERY', 'DJ', 'Discovery job')
  if (s.maskingJob.on) out.maskingJob = job('maskingJob', 'MASKING', 'MJ', 'Masking job')

  if (s.collection.on) {
    const members = [
      ...(s.discoveryJob.on ? ['DJ'] : []),
      ...(s.maskingJob.on ? ['MJ'] : []),
    ].map((v, i) => `{\\"sequence\\":${i + 1},\\"compliance_job_id\\":\\"$${v}_ID\\"}`).join(',')
    out.collection = String.raw`# ---- Job collection: exactly the jobs above, in order
COL_NAME=${L(s.collection.name)}
say "Job collection \"$COL_NAME\""
find_named /compliance-job-collections "$COL_NAME"
if [ -n "$FOUND_ID" ]; then
  COL_ID=$FOUND_ID
  api_ok PATCH "/compliance-job-collections/$COL_ID" "{\"failure_handling\":\"${s.collection.failureHandling}\",\"members\":[${members}]}"
  wait_job "$(job_id)" "updating the collection"
else
  api_ok POST /compliance-job-collections "{\"name\":\"$(jesc "$COL_NAME")\",\"failure_handling\":\"${s.collection.failureHandling}\",\"members\":[${members}]}"
  COL_ID=$(printf '%s' "$RESP" | sed 's/^.*"job" *: *.//' | jstr target_id)
  wait_job "$(job_id)" "creating the collection"
fi
`
  }

  const run = (key: 'runDiscovery' | 'runMasking', type: 'DISCOVERY' | 'MASKING', varName: string, label: string) => {
    const r = s[key]
    const pick = r.use === 'created' ? `JOB_ID=$${varName}_ID` : `find_job ${L(r.ref.trim())} ${type}`
    return String.raw`# ---- Runs the ${label} and waits for it
${pick}
say "Running the ${label} $JOB_ID"
run_job "$JOB_ID" "${label}"
`
  }
  if (s.runDiscovery.on) out.runDiscovery = run('runDiscovery', 'DISCOVERY', 'DJ', 'discovery job')
  if (s.runMasking.on) out.runMasking = run('runMasking', 'MASKING', 'MJ', 'masking job')
  if (s.runCollection.on) {
    const pick = s.runCollection.use === 'created' ? 'RUN_COL_ID=$COL_ID' : `resolve /compliance-job-collections ${L(s.runCollection.ref.trim())}\nRUN_COL_ID=$RESOLVED`
    out.runCollection = String.raw`# ---- Runs the job collection and waits for it
${pick}
say "Running the job collection $RUN_COL_ID"
api_ok POST "/compliance-job-collections/$RUN_COL_ID/execute" '{}'
wait_job "$(job_id)" "job collection"
`
  }

  if (s.refreshChildren.on) {
    out.refreshChildren = String.raw`# ---- Refreshes every VDB provisioned from this one${s.refreshChildren.snapshotFirst ? ', from a snapshot taken now' : ''}
say "Child VDBs of $VDB_NAME"
api_ok POST "/vdbs/search?limit=1000" "{\"filter_expression\":\"parent_id eq '$VDB_ID'\"}"
# A VDB's own id is the one right before its database_type.
CHILDREN=$(printf '%s' "$RESP" | grep -o '"id" *: *"[^"]*" *, *"database_type"' | sed 's/^"id" *: *"\([^"]*\)".*/\1/')
if [ -z "$CHILDREN" ]; then
  say "  none"
else
${s.refreshChildren.snapshotFirst ? String.raw`  # The children get what this VDB holds now — masked — not its last snapshot before the hook.
  api_ok POST "/vdbs/$VDB_ID/snapshots" '{}'
  wait_job "$(job_id)" "snapshot of $VDB_NAME"
` : ''}  REFRESHES=""
  for _child in $CHILDREN; do
    api_ok GET "/vdbs/$_child"
    _name=$(printf '%s' "$RESP" | jstr name)
    api_ok POST "/vdbs/$_child/refresh_by_timestamp" '{}'
    REFRESHES="$REFRESHES $(job_id):$_child"
    say "  refresh of ${D}{_name:-$_child} ($_child) started"
  done
${s.refreshChildren.wait
    ? String.raw`  for _r in $REFRESHES; do wait_job "${D}{_r%%:*}" "refresh of ${D}{_r#*:}"; done`
    : '  say "  not waiting: the refreshes go on in DCT"'}
fi
`
  }
  return out
}

function shScript(spec: WizardSpec, title: string): string {
  const s = effective(spec)
  const sections = shSections(s)
  const body = (['findVdb', ...STEP_IDS] as const)
    .filter(id => id !== 'log' && sections[id] && (id !== 'findVdb' || needsVdb(s)))
    .map(id => sections[id]).join('\n')
  const head = `${s.shell === 'bash' ? '#!/usr/bin/env bash' : '#!/bin/sh'}
# ${title}
# Made by the hook wizard of Delphix Masking Helper: POSIX sh, curl, grep and sed — nothing else.
${summaryLines(s).map(l => `# ${l}`).join('\n')}
set -u

`
  const main = `main() {
${indent(body.trimEnd())}
  say "Done"
}

`
  const tail = s.log.on
    ? String.raw`# ---- Log: everything the hook prints, also kept in a file
LOG_FILE=${expr('sh', s.log.path, true)}
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null
_rc_file=$(mktemp 2>/dev/null || echo "/tmp/delphix-hook-rc.$$")
{ ( main ); echo $? > "$_rc_file"; } 2>&1 | tee -a "$LOG_FILE"
_rc=$(cat "$_rc_file" 2>/dev/null); rm -f "$_rc_file"
echo "Log: $LOG_FILE"
exit "${D}{_rc:-1}"
`
    : 'main\n'
  return head + shSettings(s) + '\n' + SH_HELPERS + '\n' + main + tail
}

function summaryLines(s: WizardSpec): string[] {
  const lines = [`Credentials on the hook: ${credentialNames(s).join(', ')}.`]
  const extra = envNames(s).filter(n => !n.startsWith('DCT_'))
  if (extra.length) lines.push(`Reads: ${extra.join(', ')}.`)
  return lines
}

// ── PowerShell ───────────────────────────────────────────────────────────────

function psSettings(s: WizardSpec): string {
  return String.raw`# ---- Data Control Tower ------------------------------------------------------
# Each value can be overridden by a variable of the same name on the hook.
$DctUrl = if ($env:DCT_URL) { $env:DCT_URL } else { ${quote('ps', s.dct.url)} }
$DctInsecure = if ($env:DCT_INSECURE) { $env:DCT_INSECURE -eq 'true' } else { $${s.dct.insecure ? 'true' : 'false'} }
$TimeoutMinutes = if ($env:DCT_TIMEOUT_MINUTES) { [int]$env:DCT_TIMEOUT_MINUTES } else { ${s.dct.timeoutMinutes} }
$DctKey = $env:${s.dct.keyCredential}_PASSWORD
if (-not $DctKey) { [Console]::Error.WriteLine('Add a credential named ${s.dct.keyCredential} to the hook, with a DCT API key as its password.'); exit 2 }
`
}

const PS_HELPERS = String.raw`# ${HELPERS_MARK} -------------------------------------------------------------
$Api = $DctUrl.TrimEnd('/')
if ($Api -notmatch '^https?://') { $Api = "https://$Api" }
if ($Api -notmatch '/dct/v3$') { $Api += '/dct/v3' }
$DctHeaders = @{ Authorization = "apk $($DctKey -replace '^apk\s+', '')"; Accept = 'application/json' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$DctExtra = @{}
if ($DctInsecure) {
  # PowerShell 6 and later take a parameter; Windows PowerShell 5.1 a process-wide callback.
  if ($PSVersionTable.PSVersion.Major -ge 6) { $DctExtra['SkipCertificateCheck'] = $true }
  else { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } }
}
$RunTs = Get-Date -Format 'yyyyMMdd-HHmmss'

function Say([string]$Text) { Write-Host ('{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $Text) }

# Calls DCT and returns its answer, or throws with DCT's own explanation. -Soft gives $null on a 404.
function Invoke-Dct([string]$Method, [string]$Path, $Body = $null, [switch]$Soft) {
  $p = @{ Method = $Method; Uri = "$Api$Path"; Headers = $DctHeaders; ContentType = 'application/json; charset=utf-8'; UseBasicParsing = $true }
  if ($null -ne $Body) { $p['Body'] = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Body -Depth 10 -Compress)) }
  try { return Invoke-RestMethod @p @DctExtra }
  catch {
    $err = $_
    $code = 0
    if ($err.Exception.Response) { $code = [int]$err.Exception.Response.StatusCode }
    if ($Soft -and $code -eq 404) { return $null }
    $detail = $err.Exception.Message
    if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
      $detail = $err.ErrorDetails.Message
      try {
        $e = $err.ErrorDetails.Message | ConvertFrom-Json
        if ($e.error_description) { $detail = $e.error_description } elseif ($e.detail) { $detail = $e.detail }
      } catch { }
    }
    throw "DCT refused $Method $Path (HTTP $code): $detail"
  }
}

# Follows a DCT job to its end: returns when it completed, throws when it did not.
function Wait-DctJob($JobId, [string]$What) {
  if (-not $JobId) { return }
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  $last = ''
  while ($true) {
    $job = $null
    try { $job = Invoke-Dct 'GET' "/jobs/$JobId" } catch { }
    if ($job) {
      if ($job.status -ne $last) {
        $pct = ''; if ($null -ne $job.percent_complete) { $pct = " ($($job.percent_complete)%)" }
        Say "  $($What): $($job.status)$pct"
        $last = $job.status
      }
      if ($job.status -eq 'COMPLETED') { return }
      if (@('FAILED', 'CANCELED', 'TIMEDOUT', 'ABANDONED', 'SUSPENDED') -contains $job.status) { throw "$What ended as $($job.status): $($job.error_details)" }
    }
    if ((Get-Date) -gt $deadline) { throw "$What still running after $TimeoutMinutes minutes (it goes on in DCT)" }
    Start-Sleep -Seconds 10
  }
}

# The first object at Path with this name, or $null.
function Find-Named([string]$Path, [string]$Name, [string]$Filter = '') {
  $expr = "name eq '$Name'"
  if ($Filter) { $expr += " and $Filter" }
  $r = Invoke-Dct 'POST' "$Path/search?limit=10" @{ filter_expression = $expr }
  return @($r.items)[0]
}

# The id of the object named, or with the id, Ref; throws when there is none.
function Resolve-Dct([string]$Path, [string]$Ref, [string]$Filter = '') {
  if (-not $Ref) { throw "Nothing given to look for at $Path" }
  if ($Ref -notmatch '\s') {
    try { $o = Invoke-Dct 'GET' "$Path/$Ref" -Soft; if ($o -and $o.id) { return $o.id } } catch { }
  }
  $o = Find-Named $Path $Ref $Filter
  if (-not $o) { throw "DCT has nothing at $Path named, or with the id, '$Ref'" }
  return $o.id
}

# Reads what the steps need from a VDB as DCT describes it.
function Read-Vdb($v) {
  $script:VDB_ID = $v.id; $script:VDB_NAME = $v.name; $script:VDB_DATABASE = $v.database_name
  $script:VDB_INSTANCE = $v.instance_name; $script:VDB_JDBC = $v.jdbc_connection_string
  $script:VDB_HOST = if ($v.fqdn) { $v.fqdn } else { $v.ip_address }
  $script:VDB_PORT = ''
  if ($v.jdbc_connection_string -match 'PORT=(\d+)') { $script:VDB_PORT = $Matches[1] }
  elseif ($v.jdbc_connection_string -match ':(\d+)([/;?].*)?$') { $script:VDB_PORT = $Matches[1] }
  $script:VDB_SERVICE = $v.database_name
  if ($v.jdbc_connection_string -match 'SERVICE_NAME=([^)]+)') { $script:VDB_SERVICE = $Matches[1] }
  $script:VDB_GROUP = $v.group_name; $script:VDB_ENVIRONMENT = $v.environment_name
  $script:VDB_PARENT = $v.parent_name; $script:ENGINE_NAME = $v.engine_name
}

# A rule set's tables, by name.
function Get-RuleSetTables([string]$RuleSetId) {
  $names = @(); $cursor = ''
  do {
    $q = '/database-table-metadata/search?limit=1000'
    if ($cursor) { $q += "&cursor=$([uri]::EscapeDataString($cursor))" }
    $r = Invoke-Dct 'POST' $q @{ filter_expression = "rule_set_id eq '$RuleSetId'" }
    $names += @($r.items | ForEach-Object { $_.table_name })
    $cursor = $r.response_metadata.next_cursor
  } while ($cursor)
  return ,$names
}

# A compliance job by id or name; an id DCT does not list as one is kept as it is — a masking job
# of an engine, which DCT runs through /masking-jobs.
function Find-Job([string]$Ref, [string]$Type) {
  if (-not $Ref) { throw "No $Type job given" }
  if ($Ref -notmatch '\s') {
    try { $o = Invoke-Dct 'GET' "/compliance-jobs/$Ref" -Soft; if ($o -and $o.id) { return $o.id } } catch { }
  }
  $o = Find-Named '/compliance-jobs' $Ref "type eq '$Type'"
  if ($o) { return $o.id }
  if ($Ref -match '\s') { throw "DCT has no $Type job named '$Ref'" }
  return $Ref
}

# Runs a compliance job — or an engine's masking job — and waits for it.
function Invoke-DctJob([string]$Id, [string]$What) {
  $r = Invoke-Dct 'POST' "/compliance-jobs/$Id/execute" @{} -Soft
  if (-not $r) { $r = Invoke-Dct 'POST' "/masking-jobs/$Id/execute" @{} }
  Wait-DctJob $r.job.id $What
}
`

function psSections(spec: WizardSpec): Record<string, string> {
  const s = effective(spec)
  const c = s.connector
  const db = s.vdb.db
  const out: Record<string, string> = {}
  const L = (text: string) => expr('ps', text)

  if (s.vdb.find === 'id') {
    out.findVdb = String.raw`# ---- The VDB this hook runs for, as DCT knows it
Read-Vdb (Invoke-Dct 'GET' "/vdbs/$(${L(s.vdb.value)})")
Say "VDB $VDB_NAME ($VDB_ID)"
`
  } else {
    let key: string
    let filter: string
    if (s.vdb.find === 'name') { key = L(s.vdb.value); filter = `"name eq '$VdbKey'"` }
    else if (db === 'ORACLE') { key = 'if ($env:DELPHIX_DATABASE_NAME) { $env:DELPHIX_DATABASE_NAME } else { $env:ORACLE_SID }'; filter = `"database_name eq '$VdbKey'"` }
    else if (db === 'MSSQL') { key = '$env:VDB_DATABASE_NAME'; filter = `"database_name eq '$VdbKey' or name eq '$VdbKey'"` }
    else { key = '$env:DLPX_DATA_DIRECTORY'; filter = `"database_name CONTAINS '$VdbKey'"` }
    const missing = s.vdb.find === 'env'
      ? `The variables Delphix sets for a hook are missing (${vdbVariables(db).join(', ')}): is this running as a VDB hook?`
      : 'No VDB name given'
    out.findVdb = String.raw`# ---- The VDB this hook runs for, as DCT knows it
$VdbKey = ${key}
if (-not $VdbKey) { throw '${missing}' }
$found = Invoke-Dct 'POST' '/vdbs/search?limit=10' @{ filter_expression = ${filter} }
if ($found.response_metadata.total -eq 0) { throw "DCT has no VDB for '$VdbKey'" }
if ($found.response_metadata.total -gt 1) { throw "Several VDBs match '$VdbKey': name the VDB in the hook" }
Read-Vdb @($found.items)[0]
Say "VDB $VDB_NAME ($VDB_ID)"
`
  }

  if (c.on) {
    const schema = c.schema.trim() || defaultSchema(db, c.credential)
    const fields: string[] = []
    if (db === 'ORACLE' && c.oracleMode === 'jdbc') {
      fields.push('jdbc_url = $VDB_JDBC')
    } else {
      fields.push(`hostname = ${L(c.host)}`, `port = [int](${L(c.port)})`)
      if (db === 'ORACLE') fields.push(`sid = ${L(c.sid)}`)
      else fields.push(`database_name = ${L(c.database)}`)
      if (db === 'MSSQL' && c.instance.trim()) fields.push(`instance_name = ${L(c.instance)}`)
    }
    fields.push(`schema_name = ${L(schema)}`, `username = $env:${c.credential}_USER`)
    const orch = c.orchestrator.trim()
      ? `$orch = ${quote('ps', c.orchestrator.trim())}`
      : String.raw`$orchs = Invoke-Dct 'GET' '/job-orchestrators?limit=2'
  if ($orchs.response_metadata.total -ne 1) { throw 'DCT has several job orchestrators: pick one in the hook' }
  $orch = @($orchs.items)[0].id`
    out.connector = String.raw`# ---- Masking connection: updated to point at this VDB, or created
$ConnName = ${L(c.name)}
if (-not $env:${c.credential}_USER) { throw 'Add a credential named ${c.credential} to the hook: the database user and password masking connects with' }
$connFields = @{
${fields.map(f => `  ${f}`).join('\n')}
}
if ($env:${c.credential}_PASSWORD) { $connFields['password'] = $env:${c.credential}_PASSWORD }
${db === 'ORACLE' && c.oracleMode === 'jdbc' ? "if (-not $VDB_JDBC) { throw 'DCT gives no JDBC URL for the VDB' }" : "if (-not $connFields.port) { throw 'No port for the connection: set it in the hook' }"}
Say "Masking connection '$ConnName'"
$conn = Find-Named '/connectors' $ConnName 'dct_managed eq true'
if ($conn) {
  if ($conn.database_type -ne '${db}') { throw "Connection '$ConnName' exists for $($conn.database_type), and this VDB is ${db}" }
  $ConnId = $conn.id
  $r = Invoke-Dct 'PATCH' "/connectors/$ConnId" $connFields
  Wait-DctJob $r.job.id 'updating the connection'
} else {
  if (-not $env:${c.credential}_PASSWORD) { throw 'Credential ${c.credential} has no password, and a new connection needs one' }
  ${orch}
  $body = $connFields.Clone()
  $body['name'] = $ConnName; $body['type'] = 'DATABASE'; $body['database_type'] = '${db}'; $body['job_orchestrator_id'] = $orch
  $r = Invoke-Dct 'POST' '/connectors' $body
  $ConnId = $r.id
  Wait-DctJob $r.job.id 'creating the connection'
}
`
  }

  if (s.waitReady.on) {
    out.waitReady = String.raw`# ---- Waits for the database to take connections: a VDB just started may still be opening
Say 'Waiting for the database to accept connections'
$until = (Get-Date).AddMinutes(${s.waitReady.minutes}); $seen = ''
while ($true) {
  $t = $null
  try { $t = Invoke-Dct 'POST' "/connectors/$ConnId/test" @{} } catch { $t = @{ status = 'FAILED'; message = $_.Exception.Message } }
  if ($t.status -eq 'SUCCEEDED') { Say '  connected'; break }
  # A refused login will not get better by waiting.
  if ($t.message -match 'ORA-01017|Login failed|password authentication failed|Access denied') { throw "The database refused the login: $($t.message)" }
  if ($t.message -ne $seen) { Say "  not yet: $($t.message)"; $seen = $t.message }
  if ((Get-Date) -gt $until) { throw "The database did not accept connections in ${s.waitReady.minutes} minutes: $($t.message)" }
  Start-Sleep -Seconds 15
}
`
  }

  if (s.ruleSet.on) {
    out.ruleSet = String.raw`# ---- Rule set: every table the connection sees, added again from scratch
$RsName = ${L(s.ruleSet.name)}
Say "Rule set '$RsName'"
$rs = Find-Named '/rule-sets' $RsName 'dct_managed eq true'
if ($rs) {
  if ($rs.connector_id -ne $ConnId) { throw "Rule set '$RsName' exists on another connection ($($rs.connector_name))" }
  $RsId = $rs.id
  $old = Get-RuleSetTables $RsId
  if ($old.Count) {
    $r = Invoke-Dct 'POST' "/rule-sets/$RsId/bulk-table-delta-update" @{ delete = @($old | ForEach-Object { @{ table_name = $_ } }) }
    Wait-DctJob $r.job.id 'removing the tables'
  }
} else {
  $r = Invoke-Dct 'POST' '/rule-sets' @{ name = $RsName; connector_id = $ConnId }
  $RsId = $r.id
  Wait-DctJob $r.job.id 'creating the rule set'
}
$tables = @((Invoke-Dct 'POST' "/connectors/$ConnId/fetch-table-names" @{}).items)
if (-not $tables.Count) { throw "The connection sees no tables (user $($env:${c.credential}_USER))" }
Say "  $($tables.Count) tables"
$r = Invoke-Dct 'POST' "/rule-sets/$RsId/bulk-table-delta-update" @{ add = @($tables | ForEach-Object { @{ table_name = $_ } }) }
Wait-DctJob $r.job.id 'adding the tables'
`
  }

  const job = (key: 'discoveryJob' | 'maskingJob', type: 'DISCOVERY' | 'MASKING', v: string, label: string) => {
    const policy = type === 'DISCOVERY'
    const fields = policy
      ? `rule_set_id = $RsId; discovery_policy_id = $PolicyId; reset_profiling_assignments = $true`
      : `rule_set_id = $RsId`
    return String.raw`# ---- ${label}${policy ? ' (clears the previous automatic data class assignments)' : ''}
$${v}Name = ${L(s[key].name)}
Say "${label} '$${v}Name'"
${policy ? `$PolicyId = Resolve-Dct '/discovery-policies' ${L((s.discoveryJob.policy || '').trim())}\n` : ''}$j = Find-Named '/compliance-jobs' $${v}Name "type eq '${type}'"
if ($j) {
  $${v}Id = $j.id
  $r = Invoke-Dct 'PATCH' "/compliance-jobs/$${v}Id" @{ ${fields} }
  Wait-DctJob $r.job.id 'updating the ${label.toLowerCase()}'
} else {
  $r = Invoke-Dct 'POST' '/compliance-jobs' @{ name = $${v}Name; type = '${type}'; ${fields} }
  $${v}Id = $r.id
  Wait-DctJob $r.job.id 'creating the ${label.toLowerCase()}'
}
`
  }
  if (s.discoveryJob.on) out.discoveryJob = job('discoveryJob', 'DISCOVERY', 'Dj', 'Discovery job')
  if (s.maskingJob.on) out.maskingJob = job('maskingJob', 'MASKING', 'Mj', 'Masking job')

  if (s.collection.on) {
    const members = [...(s.discoveryJob.on ? ['$DjId'] : []), ...(s.maskingJob.on ? ['$MjId'] : [])]
      .map((v, i) => `@{ sequence = ${i + 1}; compliance_job_id = ${v} }`).join(', ')
    out.collection = String.raw`# ---- Job collection: exactly the jobs above, in order
$ColName = ${L(s.collection.name)}
Say "Job collection '$ColName'"
$members = @(${members})
$col = Find-Named '/compliance-job-collections' $ColName
if ($col) {
  $ColId = $col.id
  $r = Invoke-Dct 'PATCH' "/compliance-job-collections/$ColId" @{ failure_handling = '${s.collection.failureHandling}'; members = $members }
  Wait-DctJob $r.job.id 'updating the collection'
} else {
  $r = Invoke-Dct 'POST' '/compliance-job-collections' @{ name = $ColName; failure_handling = '${s.collection.failureHandling}'; members = $members }
  $ColId = $r.job.target_id
  Wait-DctJob $r.job.id 'creating the collection'
}
`
  }

  const run = (key: 'runDiscovery' | 'runMasking', type: 'DISCOVERY' | 'MASKING', v: string, label: string) => {
    const r = s[key]
    const pick = r.use === 'created' ? `$JobId = $${v}Id` : `$JobId = Find-Job ${L(r.ref.trim())} '${type}'`
    return String.raw`# ---- Runs the ${label} and waits for it
${pick}
Say "Running the ${label} $JobId"
Invoke-DctJob $JobId '${label}'
`
  }
  if (s.runDiscovery.on) out.runDiscovery = run('runDiscovery', 'DISCOVERY', 'Dj', 'discovery job')
  if (s.runMasking.on) out.runMasking = run('runMasking', 'MASKING', 'Mj', 'masking job')
  if (s.runCollection.on) {
    const pick = s.runCollection.use === 'created' ? '$RunColId = $ColId' : `$RunColId = Resolve-Dct '/compliance-job-collections' ${L(s.runCollection.ref.trim())}`
    out.runCollection = String.raw`# ---- Runs the job collection and waits for it
${pick}
Say "Running the job collection $RunColId"
$r = Invoke-Dct 'POST' "/compliance-job-collections/$RunColId/execute" @{}
Wait-DctJob $r.job.id 'job collection'
`
  }

  if (s.refreshChildren.on) {
    out.refreshChildren = String.raw`# ---- Refreshes every VDB provisioned from this one${s.refreshChildren.snapshotFirst ? ', from a snapshot taken now' : ''}
Say "Child VDBs of $VDB_NAME"
$children = @((Invoke-Dct 'POST' '/vdbs/search?limit=1000' @{ filter_expression = "parent_id eq '$VDB_ID'" }).items)
if (-not $children.Count) { Say '  none' }
else {
${s.refreshChildren.snapshotFirst ? String.raw`  # The children get what this VDB holds now — masked — not its last snapshot before the hook.
  $r = Invoke-Dct 'POST' "/vdbs/$VDB_ID/snapshots" @{}
  Wait-DctJob $r.job.id "snapshot of $VDB_NAME"
` : ''}  $refreshes = @()
  foreach ($child in $children) {
    $r = Invoke-Dct 'POST' "/vdbs/$($child.id)/refresh_by_timestamp" @{}
    $refreshes += @{ job = $r.job.id; name = $child.name }
    Say "  refresh of $($child.name) started"
  }
${s.refreshChildren.wait
    ? "  foreach ($x in $refreshes) { Wait-DctJob $x.job \"refresh of $($x.name)\" }"
    : "  Say '  not waiting: the refreshes go on in DCT'"}
}
`
  }
  return out
}

function psScript(spec: WizardSpec, title: string): string {
  const s = effective(spec)
  const sections = psSections(s)
  const body = (['findVdb', ...STEP_IDS] as const)
    .filter(id => id !== 'log' && sections[id] && (id !== 'findVdb' || needsVdb(s)))
    .map(id => sections[id]).join('\n')
  const head = `# ${title}
# Made by the hook wizard of Delphix Masking Helper, for Windows PowerShell 5.1 and later.
${summaryLines(s).map(l => `# ${l}`).join('\n')}
$ErrorActionPreference = 'Stop'

`
  const log = s.log.on
  const run = String.raw`${log ? `# ---- Log: everything the hook prints, also kept in a file
$LogFile = ${expr('ps', s.log.path, true)}
$logDir = Split-Path -Parent $LogFile
if ($logDir -and -not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
Start-Transcript -Path $LogFile -Append | Out-Null
` : ''}$rc = 0
$failure = $null
try {
${indent(body.trimEnd())}
  Say 'Done'
} catch {
  $failure = '{0} ERROR: {1}' -f (Get-Date -Format 'HH:mm:ss'), $_.Exception.Message
  [Console]::Error.WriteLine($failure)
  $rc = 1
}${log ? String.raw` finally {
  Stop-Transcript | Out-Null
  if ($failure) { Add-Content -Path $LogFile -Value $failure }
  Write-Host "Log: $LogFile"
}` : ''}
exit $rc
`
  return head + psSettings(s) + '\n' + PS_HELPERS + '\n' + run
}

// ── Expect ───────────────────────────────────────────────────────────────────

/** An expect hook running the sh script: expect has no HTTP or JSON of its own. */
function expectScript(spec: WizardSpec, title: string): string {
  const sh = shScript({ ...spec, shell: 'shell' }, title)
  const head = `#!/usr/bin/expect -f
# ${title}
# Made by the hook wizard of Delphix Masking Helper. Expect has no HTTP or JSON of its own, so
# this runs the steps below with /bin/sh, which gets the hook's variables as it is spawned.
`
  const tail = String.raw`
set timeout -1
spawn -noecho /bin/sh -c $script
expect eof
lassign [wait] pid spawnid os_error status
exit $status
`
  if (bracesBalance(sh)) return `${head}set script {\n${sh}}\n${tail}`
  // Tcl braces must balance; when the script's do not (a name with a brace), it travels in
  // base64, decoded by the host's base64 — Tcl 8.5, still common, has no decoder of its own.
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(sh)))
  return `${head}set script [exec sh -c {base64 -d 2>/dev/null || base64 -D} << ${b64}]\n${tail}`
}

function bracesBalance(text: string): boolean {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') { i++; continue }
    if (ch === '{') depth++
    else if (ch === '}' && --depth < 0) return false
  }
  return depth === 0
}

// ── Public ───────────────────────────────────────────────────────────────────

export function buildScript(spec: WizardSpec, title: string): string {
  if (spec.shell === 'expect') return expectScript(spec, title)
  return langOf(spec.shell) === 'ps' ? psScript(spec, title) : shScript(spec, title)
}

export type SnippetId = 'helpers' | 'findVdb' | Exclude<StepId, 'log'> | 'log'
export const SNIPPET_IDS: SnippetId[] = ['helpers', 'findVdb', ...STEP_IDS]

/**
 * One piece of a wizard hook, with the plan's defaults, to insert into a script by hand. Every
 * piece but the helpers uses them, and reads what the pieces before it set ($CONN_ID, $RS_ID…).
 */
/** The plan the snippets are cut from: every step on, with the wizard's defaults. */
function snippetSpec(shell: HookShell, dct?: { url?: string; insecure?: boolean }): WizardSpec {
  const spec = defaultSpec(shell === 'expect' ? 'shell' : shell, dct)
  spec.collection.on = true
  spec.runCollection.on = true
  spec.refreshChildren.on = true
  return spec
}

/**
 * What a run here needs for a piece of script inserted from the snippets: the test variables it
 * reads, and the credentials of the hook template those come from.
 */
export function snippetNeeds(text: string, shell: HookShell, settingsKey: boolean): { variables: HookVariable[]; credentials: string[] } {
  const spec = snippetSpec(shell)
  const reads = (name: string) => new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(text)
  const all = testVariables(spec, settingsKey)
  // A credential the piece reads at all comes whole: DCT sets its user and password together.
  const credentials = credentialNames(spec).filter(base => all.some(v => v.name.startsWith(`${base}_`) && reads(v.name)))
  const variables = all.filter(v => reads(v.name) || credentials.some(base => v.name.startsWith(`${base}_`)))
  return { variables, credentials }
}

export function snippet(id: SnippetId, shell: HookShell, dct?: { url?: string; insecure?: boolean }): string {
  const spec = snippetSpec(shell, dct)
  const lang = langOf(spec.shell)
  if (id === 'helpers') return lang === 'ps' ? psSettings(spec) + '\n' + PS_HELPERS : shSettings(spec) + '\n' + SH_HELPERS
  if (id === 'log') {
    return lang === 'ps'
      ? String.raw`# ---- Log: everything printed from here on, also kept in a file
$LogFile = "C:\Temp\delphix-hook-$RunTs.log"
Start-Transcript -Path $LogFile -Append | Out-Null
# … the steps …
Stop-Transcript | Out-Null
`
      : String.raw`# ---- Log: everything printed from here on, also kept in a file (the rest of the script runs in main)
LOG_FILE="/tmp/delphix-hook-$RUN_TS.log"
{ ( main ); echo $? > "$LOG_FILE.rc"; } 2>&1 | tee -a "$LOG_FILE"
_rc=$(cat "$LOG_FILE.rc" 2>/dev/null); rm -f "$LOG_FILE.rc"
exit "${D}{_rc:-1}"
`
  }
  const sections = lang === 'ps' ? psSections(spec) : shSections(spec)
  return sections[id] ?? ''
}

/** Whether a script already has the helpers the snippets call. */
export const hasHelpers = (command: string) => command.includes(HELPERS_MARK)
