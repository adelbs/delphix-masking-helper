import type { HookShell, Locale } from '@/types'

/**
 * What a hook can read, and the hooks that come ready to use.
 *
 * The context variables are the ones Delphix documents for its hook operations — set by the
 * engine on the host where the hook runs, which depends on the data source (Oracle and SQL Server
 * document theirs; AppData and DB2 hooks get the data directory). Credential variables come from
 * the hook template itself: each base name configured there becomes <BASE>_USER, <BASE>_PASSWORD,
 * <BASE>_PUBKEY and <BASE>_PRIVKEY, set only when the credential has that part.
 */

type Text = Record<Locale, string>

export interface ContextVariable {
  name: string
  /** Where Delphix sets it. */
  scope: 'oracle' | 'oracleVdb' | 'sqlserver' | 'appdata' | 'credential'
  text: Text
}

export const CONTEXT_VARIABLES: ContextVariable[] = [
  { name: 'ORACLE_SID', scope: 'oracle', text: { en: 'Oracle system identifier of the dSource or VDB.', 'pt-BR': 'Identificador de sistema Oracle do dSource ou da VDB.', es: 'Identificador de sistema Oracle del dSource o de la VDB.' } },
  { name: 'ORACLE_BASE', scope: 'oracle', text: { en: 'Base directory of the Oracle software.', 'pt-BR': 'Diretório base do software Oracle.', es: 'Directorio base del software Oracle.' } },
  { name: 'ORACLE_HOME', scope: 'oracle', text: { en: 'Oracle home; its bin is on PATH and its lib on LD_LIBRARY_PATH.', 'pt-BR': 'Oracle home; o bin dele está no PATH e o lib no LD_LIBRARY_PATH.', es: 'Oracle home; su bin está en el PATH y su lib en LD_LIBRARY_PATH.' } },
  { name: 'CRS_HOME', scope: 'oracle', text: { en: 'Cluster services home — RAC only.', 'pt-BR': 'Home dos serviços de cluster — só em RAC.', es: 'Home de los servicios de clúster — solo en RAC.' } },
  { name: 'ORAENV_ASK', scope: 'oracle', text: { en: 'Always NO.', 'pt-BR': 'Sempre NO.', es: 'Siempre NO.' } },
  { name: 'DELPHIX_DATABASE_NAME', scope: 'oracle', text: { en: 'Database name as Oracle reports it.', 'pt-BR': 'Nome do banco como o Oracle o informa.', es: 'Nombre de la base como lo informa Oracle.' } },
  { name: 'DELPHIX_DATABASE_UNIQUE_NAME', scope: 'oracle', text: { en: 'Database unique name as Oracle reports it.', 'pt-BR': 'Nome único do banco como o Oracle o informa.', es: 'Nombre único de la base como lo informa Oracle.' } },
  { name: 'DELPHIX_PDB_NAME', scope: 'oracle', text: { en: 'PDB name — pluggable databases only.', 'pt-BR': 'Nome da PDB — só em pluggable databases.', es: 'Nombre de la PDB — solo en pluggable databases.' } },
  { name: 'DELPHIX_MOUNT_PATH', scope: 'oracleVdb', text: { en: 'Root of the NFS mount holding the VDB data.', 'pt-BR': 'Raiz do mount NFS com os dados da VDB.', es: 'Raíz del montaje NFS con los datos de la VDB.' } },
  { name: 'MASKING_CONNECTOR_HOST', scope: 'oracleVdb', text: { en: 'Host the masking connector uses — masked provisioning only.', 'pt-BR': 'Host que o conector de mascaramento usa — só no provisionamento mascarado.', es: 'Host que usa el conector de enmascaramiento — solo en el aprovisionamiento enmascarado.' } },
  { name: 'MASKING_CONNECTOR_PORT', scope: 'oracleVdb', text: { en: 'Port the masking connector uses — masked provisioning only.', 'pt-BR': 'Porta que o conector de mascaramento usa — só no provisionamento mascarado.', es: 'Puerto que usa el conector de enmascaramiento — solo en el aprovisionamiento enmascarado.' } },
  { name: 'VDB_DATABASE_NAME', scope: 'sqlserver', text: { en: 'The VDB\'s database (Delphix documents it both as the VDB name and as the SQL Server database name — check on your engine).', 'pt-BR': 'O banco da VDB (a Delphix o documenta como nome da VDB e como nome do banco SQL Server — confira no seu engine).', es: 'La base de la VDB (Delphix la documenta como nombre de la VDB y como nombre de la base SQL Server — compruébalo en tu engine).' } },
  { name: 'VDB_INSTANCE_NAME', scope: 'sqlserver', text: { en: 'SQL Server instance name.', 'pt-BR': 'Nome da instância SQL Server.', es: 'Nombre de la instancia SQL Server.' } },
  { name: 'VDB_INSTANCE_HOST', scope: 'sqlserver', text: { en: 'Windows host running the instance.', 'pt-BR': 'Host Windows que roda a instância.', es: 'Host Windows que ejecuta la instancia.' } },
  { name: 'VDB_INSTANCE_PORT', scope: 'sqlserver', text: { en: 'SQL Server instance port.', 'pt-BR': 'Porta da instância SQL Server.', es: 'Puerto de la instancia SQL Server.' } },
  { name: 'DLPX_DATA_DIRECTORY', scope: 'appdata', text: { en: 'Where the dataset is mounted: the VDB, or the staging copy for a dSource (AppData, unstructured files, DB2).', 'pt-BR': 'Onde o dataset está montado: a VDB, ou a cópia de staging de um dSource (AppData, arquivos, DB2).', es: 'Dónde está montado el dataset: la VDB, o la copia de staging de un dSource (AppData, archivos, DB2).' } },
  { name: '<BASE>_USER', scope: 'credential', text: { en: 'User of a credential configured on the hook template.', 'pt-BR': 'Usuário de uma credencial configurada no hook template.', es: 'Usuario de una credencial configurada en el hook template.' } },
  { name: '<BASE>_PASSWORD', scope: 'credential', text: { en: 'Password (or key) of that credential.', 'pt-BR': 'Senha (ou chave) dessa credencial.', es: 'Contraseña (o clave) de esa credencial.' } },
  { name: '<BASE>_PUBKEY', scope: 'credential', text: { en: 'Public key, for an SSH-key credential.', 'pt-BR': 'Chave pública, numa credencial de chave SSH.', es: 'Clave pública, en una credencial de clave SSH.' } },
  { name: '<BASE>_PRIVKEY', scope: 'credential', text: { en: 'Private key, for an SSH-key credential.', 'pt-BR': 'Chave privada, numa credencial de chave SSH.', es: 'Clave privada, en una credencial de clave SSH.' } },
]

/** Where a hook can be attached, as Delphix lists its hook operations. */
export const HOOK_POINTS = {
  dsource: ['Pre-sync', 'Post-sync'],
  vdb: ['Configure clone', 'Pre-refresh', 'Post-refresh', 'Pre-rollback', 'Post-rollback', 'Pre-snapshot', 'Post-snapshot', 'Pre-start', 'Post-start', 'Pre-stop', 'Post-stop'],
}

/** How a script reads a variable, for the insert buttons. */
export const variableSyntax = (shell: HookShell, name: string) =>
  shell === 'ps' || shell === 'psd' ? `$env:${name}` : shell === 'expect' ? `$env(${name})` : `"$${name}"`

export interface HookTemplate {
  id: string
  name: Text
  description: Text
  /** Test variables it asks for, with an example value. */
  variables: Array<{ name: string; value: string }>
  /** Credential base names it reads. */
  credentials: string[]
  scripts: { bash: string; ps: string }
}

// ── Ready-made hooks ──────────────────────────────────────────────────────────
//
// Both call Data Control Tower and wait: a VDB should not be handed over before its masking has
// finished. Both scripts parse JSON without jq (the bash one) and stay within Windows PowerShell
// 5.1 (the PowerShell one), since that is what a Delphix host is likely to have.

const BASH_COMMON = String.raw`set -u
: "${'$'}{DCT_URL:?Set DCT_URL, e.g. https://dct.example.com}"
: "${'$'}{DCT_API_KEY_PASSWORD:?Add a credential variable named DCT_API_KEY whose password is a DCT API key}"
API="${'$'}{DCT_URL%/}"
case "$API" in */dct/v3) ;; *) API="$API/dct/v3" ;; esac
KEY="${'$'}{DCT_API_KEY_PASSWORD#apk }"
TIMEOUT_MINUTES="${'$'}{DCT_TIMEOUT_MINUTES:-240}"
CURL=(curl -sS --max-time 120 -H "Authorization: apk $KEY" -H 'Accept: application/json' -H 'Content-Type: application/json')
[ "${'$'}{DCT_INSECURE:-false}" = true ] && CURL+=(-k)

# The first value of a field in a JSON answer — enough for DCT's flat answers, with no jq needed.
field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

# POST $1: the body goes to $BODY and the HTTP status to $STATUS.
post() {
  local out
  out=$("${'$'}{CURL[@]}" -X POST -d '{}' -w '\n%{http_code}' "$API$1") || { echo "Could not reach $API" >&2; exit 2; }
  STATUS=$(printf '%s' "$out" | tail -n 1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

# Follows a DCT job until it ends; exits 0 when it completed, 1 when it did not.
wait_job() {
  local job=$1 deadline=$(( $(date +%s) + TIMEOUT_MINUTES * 60 )) last="" body state pct
  echo "DCT job $job"
  while :; do
    body=$("${'$'}{CURL[@]}" "$API/jobs/$job") || { sleep 15; continue; }
    state=$(printf '%s' "$body" | field status)
    pct=$(printf '%s' "$body" | grep -o '"percent_complete":[0-9]*' | head -1 | cut -d: -f2)
    if [ "$state" != "$last" ]; then echo "$(date '+%H:%M:%S') $state${'$'}{pct:+ ($pct%)}"; last=$state; fi
    case "$state" in
      COMPLETED) exit 0 ;;
      FAILED|CANCELED|TIMEDOUT|ABANDONED|SUSPENDED)
        echo "The job ended as $state: $(printf '%s' "$body" | field error_details)" >&2; exit 1 ;;
    esac
    [ "$(date +%s)" -ge "$deadline" ] && { echo "Still running after $TIMEOUT_MINUTES minutes; giving up waiting (the job goes on in DCT)." >&2; exit 1; }
    sleep 15
  done
}
`

const PS_COMMON = String.raw`$ErrorActionPreference = 'Stop'
# One plain line for any failure, with DCT's own explanation when it gave one.
trap {
  $detail = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
  [Console]::Error.WriteLine("Failed: $detail")
  exit 1
}
if (-not $env:DCT_URL) { throw 'Set DCT_URL, e.g. https://dct.example.com' }
if (-not $env:DCT_API_KEY_PASSWORD) { throw 'Add a credential variable named DCT_API_KEY whose password is a DCT API key' }
$Api = $env:DCT_URL.TrimEnd('/')
if ($Api -notmatch '/dct/v3$') { $Api += '/dct/v3' }
$Key = $env:DCT_API_KEY_PASSWORD -replace '^apk\s+', ''
$TimeoutMinutes = 240; if ($env:DCT_TIMEOUT_MINUTES) { $TimeoutMinutes = [int]$env:DCT_TIMEOUT_MINUTES }
$Headers = @{ Authorization = "apk $Key"; Accept = 'application/json' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Extra = @{}
if ($env:DCT_INSECURE -eq 'true') {
  # PowerShell 6 and later take a parameter; Windows PowerShell 5.1 a process-wide callback.
  if ($PSVersionTable.PSVersion.Major -ge 6) { $Extra['SkipCertificateCheck'] = $true }
  else { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } }
}

function Invoke-Dct([string]$Method, [string]$Path) {
  $params = @{ Method = $Method; Uri = "$Api$Path"; Headers = $Headers; ContentType = 'application/json'; UseBasicParsing = $true }
  if ($Method -eq 'POST') { $params['Body'] = '{}' }
  return Invoke-RestMethod @params @Extra
}

# Follows a DCT job until it ends; exits 0 when it completed, 1 when it did not.
function Wait-DctJob([string]$JobId) {
  Write-Output "DCT job $JobId"
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  $last = ''
  while ($true) {
    try { $job = Invoke-Dct 'GET' "/jobs/$JobId" } catch { Start-Sleep -Seconds 15; continue }
    if ($job.status -ne $last) {
      $pct = ''; if ($null -ne $job.percent_complete) { $pct = " ($($job.percent_complete)%)" }
      Write-Output ("{0} {1}{2}" -f (Get-Date -Format 'HH:mm:ss'), $job.status, $pct)
      $last = $job.status
    }
    if ($job.status -eq 'COMPLETED') { exit 0 }
    if (@('FAILED', 'CANCELED', 'TIMEDOUT', 'ABANDONED', 'SUSPENDED') -contains $job.status) {
      Write-Error ("The job ended as {0}: {1}" -f $job.status, $job.error_details) -ErrorAction Continue
      exit 1
    }
    if ((Get-Date) -gt $deadline) { Write-Error "Still running after $TimeoutMinutes minutes; giving up waiting (the job goes on in DCT)." -ErrorAction Continue; exit 1 }
    Start-Sleep -Seconds 15
  }
}
`

export const HOOK_TEMPLATES: HookTemplate[] = [
  {
    id: 'dct-masking-job',
    name: { en: 'Run a masking job (DCT)', 'pt-BR': 'Rodar um job de mascaramento (DCT)', es: 'Ejecutar un job de enmascaramiento (DCT)' },
    description: {
      en: 'Starts a masking job through Data Control Tower and waits for it to end, failing the hook when the job fails. Attach it to a VDB\'s Configure Clone (after provision and refresh), so the copy is only handed over masked. Variables: DCT_URL, DCT_MASKING_JOB_ID; optional DCT_INSECURE=true (self-signed certificate) and DCT_TIMEOUT_MINUTES (default 240). Credential: a variable named DCT_API_KEY whose password is a DCT API key.',
      'pt-BR': 'Inicia um job de mascaramento pelo Data Control Tower e espera ele terminar, fazendo o hook falhar quando o job falha. Associe ao Configure Clone de uma VDB (depois do provisionamento e do refresh), para a cópia só ser entregue mascarada. Variáveis: DCT_URL, DCT_MASKING_JOB_ID; opcionais DCT_INSECURE=true (certificado autoassinado) e DCT_TIMEOUT_MINUTES (padrão 240). Credencial: uma variável chamada DCT_API_KEY cuja senha é uma chave de API do DCT.',
      es: 'Inicia un job de enmascaramiento a través de Data Control Tower y espera a que termine, haciendo fallar el hook cuando el job falla. Asócialo al Configure Clone de una VDB (después del aprovisionamiento y del refresh), para que la copia solo se entregue enmascarada. Variables: DCT_URL, DCT_MASKING_JOB_ID; opcionales DCT_INSECURE=true (certificado autofirmado) y DCT_TIMEOUT_MINUTES (por defecto 240). Credencial: una variable llamada DCT_API_KEY cuya contraseña es una clave de API de DCT.',
    },
    variables: [
      { name: 'DCT_URL', value: 'https://dct.example.com' },
      { name: 'DCT_MASKING_JOB_ID', value: '' },
      { name: 'DCT_INSECURE', value: 'false' },
      { name: 'DCT_TIMEOUT_MINUTES', value: '240' },
    ],
    credentials: ['DCT_API_KEY'],
    scripts: {
      bash: String.raw`#!/usr/bin/env bash
# Runs a Delphix masking job through Data Control Tower and waits for it to finish.
${BASH_COMMON}
: "${'$'}{DCT_MASKING_JOB_ID:?Set DCT_MASKING_JOB_ID to the id of the masking job in DCT}"

# A masking job DCT reaches through an engine, or a compliance job DCT runs itself.
post "/masking-jobs/$DCT_MASKING_JOB_ID/execute"
if [ "$STATUS" = 404 ]; then post "/compliance-jobs/$DCT_MASKING_JOB_ID/execute"; fi
case "$STATUS" in 2??) ;; *) echo "DCT refused to start the job (HTTP $STATUS): $BODY" >&2; exit 1 ;; esac
wait_job "$(printf '%s' "$BODY" | field id)"
`,
      ps: String.raw`# Runs a Delphix masking job through Data Control Tower and waits for it to finish.
${PS_COMMON}
if (-not $env:DCT_MASKING_JOB_ID) { throw "Set DCT_MASKING_JOB_ID to the masking job's id in DCT" }

# A masking job DCT reaches through an engine, or a compliance job DCT runs itself.
try {
  $started = Invoke-Dct 'POST' "/masking-jobs/$($env:DCT_MASKING_JOB_ID)/execute"
} catch {
  if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
    $started = Invoke-Dct 'POST' "/compliance-jobs/$($env:DCT_MASKING_JOB_ID)/execute"
  } else { throw }
}
Wait-DctJob $started.job.id
`,
    },
  },
  {
    id: 'dct-job-collection',
    name: { en: 'Run a job collection (DCT)', 'pt-BR': 'Rodar uma job collection (DCT)', es: 'Ejecutar una job collection (DCT)' },
    description: {
      en: 'Starts a compliance job collection through Data Control Tower — every masking job in it — and waits for it to end, failing the hook when it fails. Variables: DCT_URL, DCT_JOB_COLLECTION_ID; optional DCT_INSECURE=true and DCT_TIMEOUT_MINUTES (default 240). Credential: a variable named DCT_API_KEY whose password is a DCT API key.',
      'pt-BR': 'Inicia uma compliance job collection pelo Data Control Tower — todos os jobs de mascaramento dela — e espera terminar, fazendo o hook falhar quando ela falha. Variáveis: DCT_URL, DCT_JOB_COLLECTION_ID; opcionais DCT_INSECURE=true e DCT_TIMEOUT_MINUTES (padrão 240). Credencial: uma variável chamada DCT_API_KEY cuja senha é uma chave de API do DCT.',
      es: 'Inicia una compliance job collection a través de Data Control Tower — todos sus jobs de enmascaramiento — y espera a que termine, haciendo fallar el hook cuando falla. Variables: DCT_URL, DCT_JOB_COLLECTION_ID; opcionales DCT_INSECURE=true y DCT_TIMEOUT_MINUTES (por defecto 240). Credencial: una variable llamada DCT_API_KEY cuya contraseña es una clave de API de DCT.',
    },
    variables: [
      { name: 'DCT_URL', value: 'https://dct.example.com' },
      { name: 'DCT_JOB_COLLECTION_ID', value: '' },
      { name: 'DCT_INSECURE', value: 'false' },
      { name: 'DCT_TIMEOUT_MINUTES', value: '240' },
    ],
    credentials: ['DCT_API_KEY'],
    scripts: {
      bash: String.raw`#!/usr/bin/env bash
# Runs a Delphix compliance job collection through Data Control Tower and waits for it to finish.
${BASH_COMMON}
: "${'$'}{DCT_JOB_COLLECTION_ID:?Set DCT_JOB_COLLECTION_ID to the id of the job collection in DCT}"

post "/compliance-job-collections/$DCT_JOB_COLLECTION_ID/execute"
case "$STATUS" in 2??) ;; *) echo "DCT refused to start the collection (HTTP $STATUS): $BODY" >&2; exit 1 ;; esac
wait_job "$(printf '%s' "$BODY" | field id)"
`,
      ps: String.raw`# Runs a Delphix compliance job collection through Data Control Tower and waits for it to finish.
${PS_COMMON}
if (-not $env:DCT_JOB_COLLECTION_ID) { throw "Set DCT_JOB_COLLECTION_ID to the job collection's id in DCT" }

$started = Invoke-Dct 'POST' "/compliance-job-collections/$($env:DCT_JOB_COLLECTION_ID)/execute"
Wait-DctJob $started.job.id
`,
    },
  },
]

/** The script of a template for a shell: PowerShell for ps/psd, bash for the rest. */
export const templateScript = (template: HookTemplate, shell: HookShell) =>
  (shell === 'ps' || shell === 'psd' ? template.scripts.ps : template.scripts.bash)
