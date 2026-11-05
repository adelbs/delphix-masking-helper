import type { HookShell } from '@/types'

/**
 * The basics of each hook language, for whoever writes one without knowing it well: a variable,
 * a condition, the two loops, a function, a call to an API, reading a JSON field, errors, waiting,
 * a log, the exit code. Each example runs as it is; the titles and hints are in the message
 * catalogs (hook.syntax.*).
 *
 * bash and sh differ where it matters to a beginner — [[ ]], arrays, `local` — so sh keeps to
 * POSIX. Delegated PowerShell is the same language as PowerShell, run on another host.
 */

export const SYNTAX_IDS = [
  'variables', 'ifElse', 'loopFor', 'loopWhile', 'functions', 'apiGet', 'apiPost', 'jsonField',
  'errors', 'retry', 'log', 'exitCode', 'spawnExpect',
] as const
export type SyntaxId = typeof SYNTAX_IDS[number]

type Family = 'bash' | 'sh' | 'expect' | 'ps'
export const familyOf = (shell: HookShell): Family =>
  shell === 'ps' || shell === 'psd' ? 'ps' : shell === 'expect' ? 'expect' : shell === 'shell' ? 'sh' : 'bash'

const BASH: Partial<Record<SyntaxId, string>> = {
  variables: String.raw`NAME="Masking - $VDB_DATABASE_NAME"   # no spaces around =
COUNT=3
echo "Name: $NAME, count: $COUNT"
DIR="${'$'}{DLPX_DATA_DIRECTORY:-/tmp}"     # a default when it is empty or unset
TODAY=$(date '+%Y-%m-%d')                 # the output of a command`,
  ifElse: String.raw`if [[ -z "$ORACLE_SID" ]]; then
  echo "ORACLE_SID is empty"
elif [[ "$ORACLE_SID" == QA* ]]; then
  echo "a QA database"
else
  echo "another database: $ORACLE_SID"
fi
# numbers: -eq -ne -lt -le -gt -ge; files: -f (file) -d (directory)
if [[ $COUNT -gt 2 && -d /tmp ]]; then echo "both true"; fi`,
  loopFor: String.raw`for TABLE in CUSTOMERS ORDERS INVOICES; do
  echo "table $TABLE"
done
for i in $(seq 1 5); do echo "attempt $i"; done
for FILE in /tmp/*.log; do echo "found $FILE"; done`,
  loopWhile: String.raw`i=0
while [[ $i -lt 5 ]]; do
  echo "i = $i"
  i=$((i + 1))
done
# line by line from a command
ls /tmp | while read -r LINE; do echo "-> $LINE"; done`,
  functions: String.raw`greet() {
  local who="$1"            # arguments are $1, $2…; local keeps it inside
  echo "hello, $who"
  return 0
}
greet "Delphix"
MSG=$(greet "VDB")          # what it prints, as a value`,
  apiGet: String.raw`DCT_URL="https://dct.example.com"
KEY="$DCT_API_KEY_PASSWORD"            # a credential of the hook template
curl -sk -H "Authorization: apk $KEY" -H "Accept: application/json" \
  "$DCT_URL/dct/v3/vdbs?limit=10"`,
  apiPost: String.raw`BODY='{"filter_expression": "name eq '\''SALES_QA'\''"}'
RESPONSE=$(curl -sk -X POST \
  -H "Authorization: apk $DCT_API_KEY_PASSWORD" \
  -H "Content-Type: application/json" \
  -d "$BODY" -w '\n%{http_code}' \
  "$DCT_URL/dct/v3/vdbs/search")
STATUS=$(printf '%s' "$RESPONSE" | tail -n 1)
JSON=$(printf '%s' "$RESPONSE" | sed '$d')
echo "HTTP $STATUS"`,
  jsonField: String.raw`JSON='{"id": "1-ORACLE_DB_CONTAINER-12", "name": "SALES_QA"}'
# with jq, when the host has it
echo "$JSON" | jq -r '.name'
# without jq: the first "id" in the text
ID=$(printf '%s' "$JSON" | grep -o '"id" *: *"[^"]*"' | head -n 1 | sed 's/.*: *"//; s/"$//')
echo "$ID"`,
  errors: String.raw`set -eu          # stop at the first failing command (-e) or unset variable (-u)
if ! curl -sf "$DCT_URL/dct/v3/about" > /dev/null; then
  echo "DCT does not answer" >&2   # >&2 writes to stderr
  exit 1
fi
cp /a/file /b/ || echo "copy failed, going on"`,
  retry: String.raw`for i in $(seq 1 30); do
  if curl -sk -o /dev/null "$DCT_URL/dct/v3/about"; then
    echo "up after $i attempts"; break
  fi
  echo "not yet, waiting 10 s"
  sleep 10
done`,
  log: String.raw`LOG=/tmp/my-hook-$(date '+%Y%m%d-%H%M%S').log
echo "started" >> "$LOG"           # >> appends, > overwrites
some_command 2>&1 | tee -a "$LOG"   # on screen and in the file
exec > >(tee -a "$LOG") 2>&1        # from here on, everything also goes to the file`,
  exitCode: String.raw`ls /no/such/dir
RC=$?                       # 0 = success, anything else = failure
echo "ls ended with $RC"
# what the hook ends with is what Delphix sees: non-zero fails the operation
exit 0`,
}

const SH: Partial<Record<SyntaxId, string>> = {
  ...BASH,
  ifElse: String.raw`if [ -z "$ORACLE_SID" ]; then
  echo "ORACLE_SID is empty"
elif [ "$ORACLE_SID" = "QA" ]; then      # one =, and spaces inside [ ]
  echo "the QA database"
else
  echo "another database: $ORACLE_SID"
fi
case "$ORACLE_SID" in                   # patterns: case, not [[ == ]]
  QA*) echo "starts with QA" ;;
  *)   echo "anything else" ;;
esac
if [ "$COUNT" -gt 2 ] && [ -d /tmp ]; then echo "both true"; fi`,
  loopFor: String.raw`for TABLE in CUSTOMERS ORDERS INVOICES; do
  echo "table $TABLE"
done
i=1
while [ $i -le 5 ]; do echo "attempt $i"; i=$((i + 1)); done   # POSIX sh has no {1..5}
for FILE in /tmp/*.log; do echo "found $FILE"; done`,
  loopWhile: String.raw`i=0
while [ $i -lt 5 ]; do
  echo "i = $i"
  i=$((i + 1))
done
ls /tmp | while read -r LINE; do echo "-> $LINE"; done`,
  functions: String.raw`greet() {
  who="$1"                  # POSIX sh has no local: every variable is global
  echo "hello, $who"
  return 0
}
greet "Delphix"
MSG=$(greet "VDB")`,
  log: String.raw`LOG=/tmp/my-hook-$(date '+%Y%m%d-%H%M%S').log
echo "started" >> "$LOG"
some_command 2>&1 | tee -a "$LOG"
# everything at once: the steps in a function, piped through tee
main() { echo "step 1"; echo "step 2"; }
main 2>&1 | tee -a "$LOG"`,
  retry: String.raw`i=1
while [ $i -le 30 ]; do
  if curl -sk -o /dev/null "$DCT_URL/dct/v3/about"; then
    echo "up after $i attempts"; break
  fi
  echo "not yet, waiting 10 s"
  sleep 10
  i=$((i + 1))
done`,
}

const EXPECT: Partial<Record<SyntaxId, string>> = {
  variables: String.raw`set name "Masking - $env(ORACLE_SID)"   ;# env(NAME) reads an environment variable
set count 3
puts "Name: $name, count: $count"
set dir [expr {[info exists env(DLPX_DATA_DIRECTORY)] ? $env(DLPX_DATA_DIRECTORY) : "/tmp"}]
set today [clock format [clock seconds] -format %Y-%m-%d]`,
  ifElse: String.raw`if {![info exists env(ORACLE_SID)] || $env(ORACLE_SID) eq ""} {
    puts "ORACLE_SID is empty"
} elseif {[string match "QA*" $env(ORACLE_SID)]} {
    puts "a QA database"
} else {
    puts "another database"
}
if {$count > 2 && [file isdirectory /tmp]} { puts "both true" }`,
  loopFor: String.raw`foreach table {CUSTOMERS ORDERS INVOICES} {
    puts "table $table"
}
for {set i 1} {$i <= 5} {incr i} { puts "attempt $i" }`,
  loopWhile: String.raw`set i 0
while {$i < 5} {
    puts "i = $i"
    incr i
}`,
  functions: String.raw`proc greet {who} {
    return "hello, $who"
}
puts [greet "Delphix"]`,
  apiGet: String.raw`# expect has no HTTP of its own: it runs curl
set key $env(DCT_API_KEY_PASSWORD)
set out [exec curl -sk -H "Authorization: apk $key" "https://dct.example.com/dct/v3/vdbs?limit=10"]
puts $out`,
  apiPost: String.raw`set body {{"filter_expression": "name eq 'SALES_QA'"}}
set out [exec curl -sk -X POST -H "Authorization: apk $env(DCT_API_KEY_PASSWORD)" \
    -H "Content-Type: application/json" -d $body "https://dct.example.com/dct/v3/vdbs/search"]
puts $out`,
  jsonField: String.raw`set json {{"id": "1-ORACLE_DB_CONTAINER-12", "name": "SALES_QA"}}
if {[regexp {"name" *: *"([^"]*)"} $json -> name]} { puts "name = $name" }`,
  errors: String.raw`if {[catch {exec curl -sf "https://dct.example.com/dct/v3/about"} result]} {
    puts stderr "DCT does not answer: $result"
    exit 1
}`,
  retry: String.raw`for {set i 1} {$i <= 30} {incr i} {
    if {![catch {exec curl -sk -o /dev/null "https://dct.example.com/dct/v3/about"}]} {
        puts "up after $i attempts"; break
    }
    puts "not yet, waiting 10 s"
    after 10000                     ;# milliseconds
}`,
  spawnExpect: String.raw`# what expect is for: start a program, wait for what it prints, answer
set timeout 30                      ;# seconds each expect waits
spawn sqlplus -L "/ as sysdba"
expect {
    "SQL>"    { send "select status from v\$instance;\r" }
    timeout   { puts stderr "no prompt in 30 s"; exit 1 }
    eof       { puts stderr "sqlplus ended"; exit 1 }
}
expect "SQL>"
send "exit\r"
expect eof`,
  log: String.raw`log_file -a /tmp/my-hook.log     ;# from here on, what is seen and sent also goes to the file
puts "started"
set f [open /tmp/my-hook.log a]  ;# or write to it yourself
puts $f "a line of my own"
close $f`,
  exitCode: String.raw`set rc [catch {exec ls /no/such/dir} out]
puts "ls failed: $rc"
# the hook ends with this code; non-zero fails the operation in Delphix
exit 0`,
}

const PS: Partial<Record<SyntaxId, string>> = {
  variables: String.raw`$Name = "Masking - $env:VDB_DATABASE_NAME"   # $env:NAME reads an environment variable
$Count = 3
Write-Host "Name: $Name, count: $Count"
$Dir = if ($env:DLPX_DATA_DIRECTORY) { $env:DLPX_DATA_DIRECTORY } else { 'C:\Temp' }
$Today = Get-Date -Format 'yyyy-MM-dd'`,
  ifElse: String.raw`if (-not $env:VDB_INSTANCE_NAME) {
    Write-Host 'VDB_INSTANCE_NAME is empty'
} elseif ($env:VDB_INSTANCE_NAME -like 'QA*') {
    Write-Host 'a QA instance'
} else {
    Write-Host "another instance: $env:VDB_INSTANCE_NAME"
}
# comparisons: -eq -ne -lt -le -gt -ge -like -match; and: -and -or -not
if ($Count -gt 2 -and (Test-Path 'C:\Temp')) { Write-Host 'both true' }`,
  loopFor: String.raw`foreach ($Table in @('CUSTOMERS', 'ORDERS', 'INVOICES')) {
    Write-Host "table $Table"
}
for ($i = 1; $i -le 5; $i++) { Write-Host "attempt $i" }
Get-ChildItem 'C:\Temp\*.log' | ForEach-Object { Write-Host "found $($_.FullName)" }`,
  loopWhile: String.raw`$i = 0
while ($i -lt 5) {
    Write-Host "i = $i"
    $i++
}`,
  functions: String.raw`function Get-Greeting([string]$Who) {
    return "hello, $Who"
}
Write-Host (Get-Greeting 'Delphix')`,
  apiGet: String.raw`$DctUrl = 'https://dct.example.com'
$Headers = @{ Authorization = "apk $env:DCT_API_KEY_PASSWORD"; Accept = 'application/json' }
# PowerShell 5.1: TLS 1.2, and (lab only) accept a self-signed certificate
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Vdbs = Invoke-RestMethod -Uri "$DctUrl/dct/v3/vdbs?limit=10" -Headers $Headers
$Vdbs.items | ForEach-Object { Write-Host $_.name }`,
  apiPost: String.raw`$Body = @{ filter_expression = "name eq 'SALES_QA'" } | ConvertTo-Json
$Found = Invoke-RestMethod -Method Post -Uri "$DctUrl/dct/v3/vdbs/search" ${'`'}
    -Headers $Headers -ContentType 'application/json' -Body $Body
Write-Host "found $($Found.items.Count)"`,
  jsonField: String.raw`$Json = '{"id": "1-ORACLE_DB_CONTAINER-12", "name": "SALES_QA"}'
$Obj = $Json | ConvertFrom-Json
Write-Host $Obj.name
# Invoke-RestMethod already answers objects: $Vdbs.items[0].id`,
  errors: String.raw`$ErrorActionPreference = 'Stop'     # every error stops the script
try {
    Invoke-RestMethod -Uri "$DctUrl/dct/v3/about" -Headers $Headers | Out-Null
} catch {
    Write-Error "DCT does not answer: $($_.Exception.Message)"
    exit 1
}`,
  retry: String.raw`for ($i = 1; $i -le 30; $i++) {
    try {
        Invoke-RestMethod -Uri "$DctUrl/dct/v3/about" -Headers $Headers | Out-Null
        Write-Host "up after $i attempts"; break
    } catch {
        Write-Host 'not yet, waiting 10 s'
        Start-Sleep -Seconds 10
    }
}`,
  log: String.raw`$Log = "C:\Temp\my-hook-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
Add-Content -Path $Log -Value 'started'
Start-Transcript -Path $Log -Append | Out-Null    # from here on, everything also goes to the file
Write-Host 'a step'
Stop-Transcript | Out-Null`,
  exitCode: String.raw`cmd /c 'dir C:\no\such\dir'
Write-Host "ended with $LASTEXITCODE"   # the exit code of the last program
# the hook ends with this code; non-zero fails the operation in Delphix
exit 0`,
}

const BY_FAMILY: Record<Family, Partial<Record<SyntaxId, string>>> = { bash: BASH, sh: SH, expect: EXPECT, ps: PS }

/** The topics this language has an example for, in order. */
export const syntaxIds = (shell: HookShell): SyntaxId[] => SYNTAX_IDS.filter(id => BY_FAMILY[familyOf(shell)][id] !== undefined)

export const syntaxExample = (shell: HookShell, id: SyntaxId): string => BY_FAMILY[familyOf(shell)][id] ?? ''
