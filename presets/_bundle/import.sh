#!/usr/bin/env bash
#
# Loads this discovery policy into Delphix: Data Control Tower, or a Continuous Compliance Engine.
#
#   ./import.sh
#
# It asks for the language of its messages, where to load, how to connect and which pack, then lists
# what already exists there under the same names. Those objects are deleted before the import; one
# Delphix refuses to delete (because something else uses it) is updated instead. Everything is logged
# to import-<date>.log next to this script — secrets never.
#
# Needs bash 3.2 or later, curl and jq.

LC_ALL_SAVED="${LC_ALL:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$HERE/data"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$HERE/import-$STAMP.log"
WORK="$(mktemp -d 2>/dev/null || mktemp -d -t dlpx-import)"
trap 'rm -rf "$WORK"' EXIT
COL=2

# ── Messages ──────────────────────────────────────────────────────────────────
# key, English, Português, Español — tab separated; printf placeholders.
cat > "$WORK/messages" <<'EOF'
lang	Language	Idioma	Idioma
need	This script needs %s. Install it and run again.	Este script precisa de %s. Instale e rode de novo.	Este script necesita %s. Instálalo y ejecuta de nuevo.
title	Load "%s" (version %s) into Delphix	Carregar "%s" (versão %s) no Delphix	Cargar "%s" (versión %s) en Delphix
target	Where should it be loaded?	Onde carregar?	¿Dónde cargarla?
target_dct	Data Control Tower (DCT)	Data Control Tower (DCT)	Data Control Tower (DCT)
target_engine	Continuous Compliance Engine	Continuous Compliance Engine	Continuous Compliance Engine
choice	Choice	Opção	Opción
host_dct	DCT address (host name or URL)	Endereço do DCT (host ou URL)	Dirección de DCT (host o URL)
host_engine	Engine address (host name or URL)	Endereço do engine (host ou URL)	Dirección del engine (host o URL)
apikey	DCT API key	Chave de API do DCT	Clave de API de DCT
user	User	Usuário	Usuario
password	Password	Senha	Contraseña
insecure	Accept a self-signed or expired certificate? (y/N)	Aceitar certificado autoassinado ou expirado? (s/N)	¿Aceptar un certificado autofirmado o vencido? (s/N)
pack	Which pack?	Qual pacote?	¿Qué paquete?
pack_essential	Essential — the minimum for the law (%s data classes, %s classifiers)	Essencial — o mínimo para a lei (%s classes de dados, %s classifiers)	Esencial — lo mínimo para la ley (%s clases de datos, %s classifiers)
pack_extended	Extended — everything (%s data classes, %s classifiers)	Estendido — tudo (%s classes de dados, %s classifiers)	Extendido — todo (%s clases de datos, %s classifiers)
connecting	Connecting to %s…	Conectando a %s…	Conectando a %s…
connected	Connected.	Conectado.	Conectado.
connect_fail	Could not connect: %s	Não foi possível conectar: %s	No se pudo conectar: %s
reading	Reading what is already there…	Lendo o que já existe lá…	Leyendo lo que ya existe allí…
nothing_exists	None of these objects exists there yet.	Nenhum destes objetos existe lá ainda.	Ninguno de estos objetos existe allí todavía.
warn_title	WARNING: these objects already exist and will be DELETED before the import:	ATENÇÃO: estes objetos já existem e serão APAGADOS antes da importação:	ATENCIÓN: estos objetos ya existen y se BORRARÁN antes de la importación:
warn_update	Whatever Delphix refuses to delete — because something else uses it — is updated instead.	O que o Delphix se recusar a apagar — porque algo mais o usa — é atualizado em vez disso.	Lo que Delphix se niegue a borrar — porque algo más lo usa — se actualiza en su lugar.
confirm	Continue? (y/N)	Continuar? (s/N)	¿Continuar? (s/N)
cancelled	Cancelled. Nothing was changed.	Cancelado. Nada foi alterado.	Cancelado. No se cambió nada.
kind_policy	discovery policy	política de descoberta	política de descubrimiento
kind_classifier	classifier	classifier	classifier
kind_dataclass	data class	classe de dados	clase de datos
kind_algorithm	algorithm	algoritmo	algoritmo
deleting	Deleting %s %s	Apagando %s %s	Borrando %s %s
deleted	deleted	apagado	borrado
kept	refused (%s) — it will be updated	recusado (%s) — será atualizado	rechazado (%s) — se actualizará
uploading	Uploading %s	Enviando %s	Subiendo %s
creating	Creating %s %s	Criando %s %s	Creando %s %s
updating	Updating %s %s	Atualizando %s %s	Actualizando %s %s
ok	ok	ok	ok
unchanged	already as sent — left as it is	já está como seria enviado — mantido	ya está como se enviaría — se mantiene
failed	FAILED: %s	FALHOU: %s	FALLÓ: %s
checkdigit	Data Control Tower refuses to update Checkdigit algorithms (HTTP 500); delete "%s" there and run again.	O Data Control Tower recusa atualizar algoritmos Checkdigit (HTTP 500); apague "%s" lá e rode de novo.	Data Control Tower se niega a actualizar algoritmos Checkdigit (HTTP 500); borra "%s" allí y ejecuta de nuevo.
no_framework	Delphix has no "%s" framework in its dlpx-core plugin.	O Delphix não tem o framework "%s" no plugin dlpx-core.	Delphix no tiene el framework "%s" en su plugin dlpx-core.
no_builtin	Delphix has no built-in algorithm "%s".	O Delphix não tem o algoritmo de fábrica "%s".	Delphix no tiene el algoritmo de fábrica "%s".
stopped	The import stopped. What was done so far stays in Delphix; running again resumes it.	A importação parou. O que já foi feito fica no Delphix; rodar de novo retoma.	La importación se detuvo. Lo hecho hasta aquí queda en Delphix; ejecutar de nuevo la retoma.
done	Done: %s created, %s updated, %s deleted before the import.	Concluído: %s criados, %s atualizados, %s apagados antes da importação.	Listo: %s creados, %s actualizados, %s borrados antes de la importación.
log	Log: %s	Log: %s	Log: %s
EOF

msg() {
  local key=$1; shift
  local fmt
  fmt=$(awk -F'\t' -v k="$key" -v c="$COL" '$1 == k { print $c; exit }' "$WORK/messages")
  # shellcheck disable=SC2059
  printf -- "$fmt" "$@"
}

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG"; }

# Answers come from the terminal — or, unattended, one per line from the file named by
# DLPX_IMPORT_ANSWERS, in the order the questions are asked.
if [ -n "${DLPX_IMPORT_ANSWERS:-}" ]; then exec 3< "$DLPX_IMPORT_ANSWERS"; TTY=no
else exec 3< /dev/tty; TTY=yes; fi

ask() {   # ask <prompt> [default]
  local answer
  printf '%s' "$1" >&2
  [ -n "${2:-}" ] && printf ' [%s]' "$2" >&2
  printf ': ' >&2
  IFS= read -r answer <&3
  [ "$TTY" = no ] && printf '%s\n' "$answer" >&2
  [ -z "$answer" ] && answer="${2:-}"
  printf '%s' "$answer"
}
ask_secret() {
  local answer
  printf '%s: ' "$1" >&2
  [ "$TTY" = yes ] && stty -echo <&3 2>/dev/null
  IFS= read -r answer <&3
  [ "$TTY" = yes ] && stty echo <&3 2>/dev/null
  printf '\n' >&2
  printf '%s' "$answer"
}
# An error found inside $( … ) would be lost with the subshell; it is kept in a file too.
set_error() { ERROR="$1"; printf '%s' "$1" > "$WORK/error"; }
last_error() { [ -s "$WORK/error" ] && cat "$WORK/error"; }
yes_answer() { case "$1" in y|Y|s|S|yes|YES|sim|SIM|si|SI|sí|Sí) return 0 ;; *) return 1 ;; esac; }

# ── Language, requirements ────────────────────────────────────────────────────

printf '\n  1) English\n  2) Português\n  3) Español\n\n' >&2
case "$(ask 'Language / Idioma' 1)" in
  2) COL=3 ;;
  3) COL=4 ;;
  *) COL=2 ;;
esac

for tool in curl jq; do
  if ! command -v "$tool" > /dev/null 2>&1; then msg need "$tool"; echo; exit 1; fi
done

INDEX="$DATA/index.json"
NAME=$(jq -r --arg l "$( [ $COL = 3 ] && echo pt-BR || { [ $COL = 4 ] && echo es || echo en; } )" '.name[$l] // .name.en' "$INDEX")
VERSION=$(jq -r '.version' "$INDEX")
log "Delphix discovery policy import — $(jq -r '.id' "$INDEX") v$VERSION"
echo
msg title "$NAME" "$VERSION"; echo; echo

# ── Where, how, which pack ────────────────────────────────────────────────────

msg target; echo
printf '  1) %s\n  2) %s\n' "$(msg target_dct)" "$(msg target_engine)"
case "$(ask "$(msg choice)" 1)" in 2) TARGET=engine ;; *) TARGET=dct ;; esac
log "target: $TARGET"

if [ "$TARGET" = dct ]; then
  HOST=$(ask "$(msg host_dct)")
  KEY=$(ask_secret "$(msg apikey)")
  KEY=${KEY#apk }; KEY=${KEY#APK }
else
  HOST=$(ask "$(msg host_engine)")
  USERNAME=$(ask "$(msg user)" admin)
  PASSWORD=$(ask_secret "$(msg password)")
fi
INSECURE=no
yes_answer "$(ask "$(msg insecure)" n)" && INSECURE=yes

case "$HOST" in http://*|https://*) BASE="$HOST" ;; *) BASE="https://$HOST" ;; esac
BASE=${BASE%/}
if [ "$TARGET" = dct ]; then
  case "$BASE" in */dct/v3) ;; */dct) BASE="$BASE/v3" ;; *) BASE="$BASE/dct/v3" ;; esac
else
  case "$BASE" in */masking/api) ;; *) BASE="$BASE/masking/api" ;; esac
fi
log "api: $BASE (self-signed accepted: $INSECURE)"

PACK=extended
if jq -e '.packs.essential' "$INDEX" > /dev/null; then
  echo; msg pack; echo
  printf '  1) %s\n  2) %s\n' \
    "$(msg pack_essential "$(jq '.packs.essential.dataClasses | length' "$INDEX")" "$(jq '.packs.essential.classifiers | length' "$INDEX")")" \
    "$(msg pack_extended "$(jq '.packs.extended.dataClasses | length' "$INDEX")" "$(jq '.packs.extended.classifiers | length' "$INDEX")")"
  case "$(ask "$(msg choice)" 2)" in 1) PACK=essential ;; *) PACK=extended ;; esac
fi
log "pack: $PACK"

# What this pack holds, in dependency order.
jq -r --arg p "$PACK" '.packs[$p].algorithms as $w | .algorithms[] | select(.name as $n | $w | index($n)) | [.name, .file, .framework] | @tsv' "$INDEX" > "$WORK/algorithms.tsv"
jq -r --arg p "$PACK" '.packs[$p].dataClasses as $w | .dataClasses[] | select(.name as $n | $w | index($n)) | [.name, .file] | @tsv' "$INDEX" > "$WORK/dataclasses.tsv"
jq -r --arg p "$PACK" '.packs[$p].classifiers as $w | .classifiers[] | select(.name as $n | $w | index($n)) | [.name, .file] | @tsv' "$INDEX" > "$WORK/classifiers.tsv"
POLICY_NAME=$(jq -r '.policy.name' "$INDEX")
POLICY_FILE=$(jq -r --arg p "$PACK" '.policy.files[$p]' "$INDEX")

# ── HTTP ──────────────────────────────────────────────────────────────────────

AUTH_HEADER=""
STATUS=000
# http METHOD PATH [json-file | --upload file] — the body lands in $WORK/resp, the status in $STATUS
http() {
  local method=$1 path=$2 attempt=1
  shift 2
  while :; do
    set -- "$@"
    local args=(-sS -X "$method" -o "$WORK/resp" -w '%{http_code}' -H 'Accept: application/json' --max-time 300)
    [ "$INSECURE" = yes ] && args+=(-k)
    [ -n "$AUTH_HEADER" ] && args+=(-H "Authorization: $AUTH_HEADER")
    if [ "${1:-}" = --upload ]; then
      args+=(-F "file=@$2")
    elif [ -n "${1:-}" ]; then
      args+=(-H 'Content-Type: application/json' --data-binary "@$1")
    fi
    STATUS=$(curl "${args[@]}" "$BASE$path" 2> "$WORK/curlerr") || STATUS=000
    log "  $method $path → $STATUS"
    # An engine forgets a session after a while: log in again once.
    if [ "$STATUS" = 401 ] && [ "$TARGET" = engine ] && [ $attempt -eq 1 ] && [ "$path" != /login ]; then
      engine_login > /dev/null && { attempt=2; continue; }
    fi
    # A read can be asked again when the server was busy; a write never is.
    if [ "$method" = GET ] && [ $attempt -lt 3 ] && case "$STATUS" in 000|502|503|504) true ;; *) false ;; esac; then
      attempt=$((attempt + 1)); sleep 3; continue
    fi
    break
  done
}
ok_status() { case "$STATUS" in 2??) return 0 ;; *) return 1 ;; esac; }
error_text() {
  if [ "$STATUS" = 000 ]; then cat "$WORK/curlerr"; return; fi
  jq -r '.error_description // .errorMessage // .detail // .message // (.errors // [] | join("; ")) // empty' "$WORK/resp" 2>/dev/null | head -c 400
  [ -s "$WORK/resp" ] || printf 'HTTP %s' "$STATUS"
}

engine_login() {
  local body="$WORK/login.json"
  jq -n --arg u "$USERNAME" --arg p "$PASSWORD" '{username: $u, password: $p}' > "$body"
  AUTH_HEADER=""
  http POST /login "$body"
  rm -f "$body"
  ok_status || return 1
  AUTH_HEADER=$(jq -r '.Authorization // empty' "$WORK/resp")
  [ -n "$AUTH_HEADER" ]
}

# Waits for what a write started: an engine's async task, or a DCT job.
wait_done() {
  local id state detail i=0
  if [ "$TARGET" = dct ]; then
    id=$(jq -r '.job.id // empty' "$WORK/resp" 2>/dev/null)
    [ -z "$id" ] && return 0
    cp "$WORK/resp" "$WORK/written"
    while :; do
      http GET "/jobs/$id"
      state=$(jq -r '.status // empty' "$WORK/resp")
      case "$state" in
        COMPLETED) cp "$WORK/written" "$WORK/resp"; return 0 ;;
        FAILED|CANCELED|TIMEDOUT|ABANDONED|SUSPENDED)
          detail=$(jq -r '.error_details // .status' "$WORK/resp"); cp "$WORK/written" "$WORK/resp"; ERROR="$detail"; return 1 ;;
      esac
      i=$((i + 1)); [ $i -gt 600 ] && { ERROR="job $id still running"; return 1; }
      sleep 1
    done
  else
    id=$(jq -r '.asyncTaskId // empty' "$WORK/resp" 2>/dev/null)
    [ -z "$id" ] && return 0
    cp "$WORK/resp" "$WORK/written"
    while :; do
      http GET "/async-tasks/$id"
      state=$(jq -r '.status // empty' "$WORK/resp")
      case "$state" in
        SUCCEEDED) cp "$WORK/written" "$WORK/resp"; return 0 ;;
        FAILED|CANCELLED) detail=$(jq -r '.exceptionDetail // .status' "$WORK/resp"); ERROR="$detail"; return 1 ;;
      esac
      i=$((i + 1)); [ $i -gt 600 ] && { ERROR="task $id still running"; return 1; }
      sleep 1
    done
  fi
}

# Every item of a list, into a file as one JSON array.
list_all() {
  local path=$1 out=$2 cursor="" page=1 sep
  case "$path" in *\?*) sep='&' ;; *) sep='?' ;; esac
  echo '[]' > "$out"
  while :; do
    if [ "$TARGET" = dct ]; then
      if [ -n "$cursor" ]; then http GET "$path${sep}limit=100&cursor=$(jq -rn --arg c "$cursor" '$c|@uri')"; else http GET "$path${sep}limit=100"; fi
      ok_status || return 1
      jq -s '.[0] + (.[1].items // [])' "$out" "$WORK/resp" > "$out.tmp" && mv "$out.tmp" "$out"
      cursor=$(jq -r '.response_metadata.next_cursor // empty' "$WORK/resp")
      [ -z "$cursor" ] && return 0
    else
      http GET "$path${sep}page_size=100&page_number=$page"
      ok_status || return 1
      jq -s '.[0] + (.[1].responseList // [])' "$out" "$WORK/resp" > "$out.tmp" && mv "$out.tmp" "$out"
      local got total
      got=$(jq 'length' "$out"); total=$(jq -r '._pageInfo.total // 0' "$WORK/resp")
      [ "$(jq '.responseList // [] | length' "$WORK/resp")" -eq 0 ] && return 0
      [ "$got" -ge "$total" ] && return 0
      page=$((page + 1))
    fi
  done
}

# ── Connect ───────────────────────────────────────────────────────────────────

echo; msg connecting "$BASE"; echo
if [ "$TARGET" = dct ]; then
  AUTH_HEADER="apk $KEY"
  http GET '/algorithms?limit=1'
  if ! ok_status; then msg connect_fail "$(error_text)"; echo; log "connect failed"; exit 1; fi
else
  if ! engine_login; then msg connect_fail "$(error_text)"; echo; log "connect failed"; exit 1; fi
fi
msg connected; echo
unset PASSWORD

# ── What is there ─────────────────────────────────────────────────────────────

msg reading; echo
STATE="$WORK/state.json"
echo '{"alg":{},"dc":{},"cls":{},"files":{},"update":{}}' > "$STATE"
state_set() { jq --arg k "$2" --arg v "$3" ".$1[\$k] = \$v" "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"; }
state_get() { jq -r --arg k "$2" ".$1[\$k] // empty" "$STATE"; }

if [ "$TARGET" = dct ]; then
  list_all /algorithms "$WORK/remote-alg.json" || { msg connect_fail "$(error_text)"; echo; exit 1; }
  list_all /data-classes "$WORK/remote-dc.json" || { msg connect_fail "$(error_text)"; echo; exit 1; }
  list_all /classifiers "$WORK/remote-cls.json" || { msg connect_fail "$(error_text)"; echo; exit 1; }
  list_all /discovery-policies "$WORK/remote-pol.json" || { msg connect_fail "$(error_text)"; echo; exit 1; }
  list_all /masking-plugins "$WORK/plugins.json" || { msg connect_fail "$(error_text)"; echo; exit 1; }
  # Only what DCT manages is ours to touch; its built-ins never are.
  own='[.[] | select(.dct_managed == true and (.built_in // .is_default_instance // false) == false)]'
  jq "$own" "$WORK/remote-alg.json" > "$WORK/own-alg.json"
  jq "$own" "$WORK/remote-dc.json" > "$WORK/own-dc.json"
  jq "$own" "$WORK/remote-cls.json" > "$WORK/own-cls.json"
  jq "$own" "$WORK/remote-pol.json" > "$WORK/own-pol.json"
  jq '[.[] | select(.name == "dlpx-core")] | (map(select(.dct_managed)) + .)[0].frameworks // [] | map({(.name): .id}) | add // {}' "$WORK/plugins.json" > "$WORK/frameworks.json"
  remote_id() { jq -r --arg n "$2" '[.[] | select(.name == $n)][0].id // empty' "$WORK/own-$1.json"; }
else
  list_all /algorithms "$WORK/remote-alg.json" || { msg connect_fail "$(error_text)"; echo; exit 1; }
  list_all /domains "$WORK/remote-dc.json" || { msg connect_fail "$(error_text)"; echo; exit 1; }
  list_all /classifiers "$WORK/remote-cls.json" || { msg connect_fail "$(error_text)"; echo; exit 1; }
  list_all /profile-sets "$WORK/remote-pol.json" || { msg connect_fail "$(error_text)"; echo; exit 1; }
  http GET '/algorithm/frameworks?page_size=500'
  jq '[.responseList[] | select(.plugin.pluginName == "dlpx-core")] | map({(.frameworkName): (.frameworkId | tostring)}) | add // {}' "$WORK/resp" > "$WORK/frameworks.json"
  http GET '/classifiers/frameworks'
  jq '[.responseList[]] | map({(.frameworkName): (.frameworkId | tostring)}) | add // {}' "$WORK/resp" > "$WORK/classifier-frameworks.json"
  jq '[.[] | {name: .algorithmName, id: .algorithmName}]' "$WORK/remote-alg.json" > "$WORK/own-alg.json"
  jq '[.[] | {name: .domainName, id: .domainName}]' "$WORK/remote-dc.json" > "$WORK/own-dc.json"
  jq '[.[] | {name: .classifierName, id: (.classifierId | tostring)}]' "$WORK/remote-cls.json" > "$WORK/own-cls.json"
  jq '[.[] | {name: .profileSetName, id: (.profileSetId | tostring)}]' "$WORK/remote-pol.json" > "$WORK/own-pol.json"
  remote_id() { jq -r --arg n "$2" '[.[] | select(.name == $n)][0].id // empty' "$WORK/own-$1.json"; }
fi

# The existing objects, in the order they are deleted: what uses comes before what is used.
: > "$WORK/existing.tsv"
id=$(remote_id pol "$POLICY_NAME"); [ -n "$id" ] && printf 'pol\t%s\t%s\n' "$POLICY_NAME" "$id" >> "$WORK/existing.tsv"
while IFS=$'\t' read -r n f; do id=$(remote_id cls "$n"); [ -n "$id" ] && printf 'cls\t%s\t%s\n' "$n" "$id" >> "$WORK/existing.tsv"; done < "$WORK/classifiers.tsv"
while IFS=$'\t' read -r n f; do id=$(remote_id dc "$n"); [ -n "$id" ] && printf 'dc\t%s\t%s\n' "$n" "$id" >> "$WORK/existing.tsv"; done < "$WORK/dataclasses.tsv"
# Algorithms in reverse dependency order, so a chain goes before the algorithms in it.
awk '{ a[NR] = $0 } END { for (i = NR; i > 0; i--) print a[i] }' "$WORK/algorithms.tsv" > "$WORK/algorithms-rev.tsv"
while IFS=$'\t' read -r n f fw; do id=$(remote_id alg "$n"); [ -n "$id" ] && printf 'alg\t%s\t%s\n' "$n" "$id" >> "$WORK/existing.tsv"; done < "$WORK/algorithms-rev.tsv"

kind_label() { case "$1" in pol) msg kind_policy ;; cls) msg kind_classifier ;; dc) msg kind_dataclass ;; alg) msg kind_algorithm ;; esac; }

DELETED=0
if [ ! -s "$WORK/existing.tsv" ]; then
  msg nothing_exists; echo
else
  echo; msg warn_title; echo
  while IFS=$'\t' read -r k n id; do printf '  - %s: %s\n' "$(kind_label "$k")" "$n"; log "exists: $k $n ($id)"; done < "$WORK/existing.tsv"
  echo; msg warn_update; echo
  if ! yes_answer "$(ask "$(msg confirm)" n)"; then msg cancelled; echo; log cancelled; exit 0; fi
  echo
  while IFS=$'\t' read -r k n id; do
    printf '%s… ' "$(msg deleting "$(kind_label "$k")" "$n")"
    case "$TARGET:$k" in
      dct:pol) path="/discovery-policies/$id" ;; dct:cls) path="/classifiers/$id" ;;
      dct:dc) path="/data-classes/$id" ;; dct:alg) path="/algorithms/$id" ;;
      engine:pol) path="/profile-sets/$id" ;; engine:cls) path="/classifiers/$id" ;;
      engine:dc) path="/domains/$(jq -rn --arg v "$id" '$v|@uri')" ;; engine:alg) path="/algorithms/$(jq -rn --arg v "$id" '$v|@uri')" ;;
    esac
    http DELETE "$path"
    ERROR=""
    if ok_status && wait_done; then
      msg deleted; echo; log "deleted: $k $n"; DELETED=$((DELETED + 1))
    else
      reason="${ERROR:-$(error_text)}"
      msg kept "$reason"; echo; log "delete refused: $k $n — $reason"
      state_set update "$k:$n" "$id"
    fi
  done < "$WORK/existing.tsv"
fi

# ── Import ────────────────────────────────────────────────────────────────────

CREATED=0
UPDATED=0
fail() { echo; msg failed "$1"; echo; log "FAILED: $1"; echo; msg stopped; echo; msg log "$LOG"; echo; exit 1; }

# Uploads a file. An engine lets every object name one upload; DCT ties an upload to the object that
# named it first, so there each object gets its own.
upload() {
  local name=$1 ref
  if [ "$TARGET" = engine ]; then
    ref=$(state_get files "$name"); [ -n "$ref" ] && { printf '%s' "$ref"; return 0; }
  fi
  log "upload: $name"
  if [ "$TARGET" = dct ]; then http POST /masking-file-uploads --upload "$DATA/files/$name"; else http POST /file-uploads --upload "$DATA/files/$name"; fi
  ok_status || { set_error "$name: $(error_text)"; return 1; }
  ref=$(jq -r '.file.file_reference_id // .fileReferenceId // empty' "$WORK/resp")
  [ -n "$ref" ] || { set_error "$name: no file reference"; return 1; }
  [ "$TARGET" = engine ] && state_set files "$name" "$ref"
  printf '%s' "$ref"
}

# The value a token stands for there.
resolve() {
  local kind=$1 key=$2 v
  case "$kind" in
    FW) v=$(jq -r --arg k "$key" '.[$k] // empty' "$WORK/frameworks.json"); [ -n "$v" ] || { set_error "$(msg no_framework "$key")"; return 1; } ;;
    CFW) v=$(jq -r --arg k "$key" '.[$k] // empty' "$WORK/classifier-frameworks.json"); [ -n "$v" ] || { set_error "$(msg no_framework "$key")"; return 1; } ;;
    FILE) v=$(upload "$key") || return 1 ;;
    DC) v=$(state_get dc "$key"); [ -n "$v" ] || v=$(jq -r --arg n "$key" '[.[] | select(.name == $n and .dct_managed == true)] | (map(select((.built_in // false) == false)) + .)[0].id // empty' "$WORK/remote-dc.json")
        [ -n "$v" ] || { set_error "data class $key"; return 1; } ;;
    CLS) v=$(state_get cls "$key"); [ -n "$v" ] || { set_error "classifier $key"; return 1; } ;;
    ALG)
      v=$(state_get alg "$key")
      if [ -z "$v" ]; then
        case "$key" in
          dlpx-core:*)
            if [ "$TARGET" = engine ]; then v="$key"; else
              local dn; dn=$(jq -r --arg k "$key" '.builtins[$k] // empty' "$INDEX")
              v=$(jq -r --arg n "$dn" '[.[] | select(.dct_managed == true and .is_default_instance == true and .name == $n)][0].id // empty' "$WORK/remote-alg.json")
              [ -n "$v" ] || { set_error "$(msg no_builtin "$key")"; return 1; }
            fi ;;
          *) set_error "algorithm $key"; return 1 ;;
        esac
      fi ;;
  esac
  printf '%s' "$v"
}

# A template with every token swapped for its value, into $WORK/body.json.
render() {
  local text tok kind key val before after
  text=$(cat "$1")
  grep -o '{{[A-Z]*:[^}]*}}' "$1" | sort -u > "$WORK/tokens"
  while IFS= read -r tok; do
    [ -z "$tok" ] && continue
    kind=${tok#\{\{}; kind=${kind%%:*}
    key=${tok#*:}; key=${key%\}\}}
    val=$(resolve "$kind" "$key") || { ERROR=$(last_error); return 1; }
    while :; do
      case "$text" in *"$tok"*) ;; *) break ;; esac
      before=${text%%"$tok"*}
      after=${text#*"$tok"}
      text="$before$val$after"
    done
  done < "$WORK/tokens"
  printf '%s\n' "$text" > "$WORK/body.json"
}

# Sends one object: created, or updated when Delphix kept it.
send() {   # send <kind> <name> <template> <create-path> <update-path>
  local k=$1 n=$2 tpl=$3 create=$4 update=$5 id
  ERROR=""; : > "$WORK/error"
  render "$tpl" || fail "$n — $ERROR"
  id=$(state_get update "$k:$n")
  if [ -n "$id" ]; then
    printf '%s… ' "$(msg updating "$(kind_label "$k")" "$n")"
    if [ "$TARGET" = dct ] && [ "$k" = alg ] && jq -e -n --slurpfile b "$WORK/body.json" --slurpfile all "$WORK/remote-alg.json" --arg id "$id" \
        '[$all[0][] | select(.id == $id)][0] as $r | $r != null and $r.config == $b[0].config and (($b[0].description // "") == "" or $b[0].description == $r.description)' > /dev/null; then
      # Already as it would be sent: nothing to write. For a Checkdigit this is also the only way
      # through, since DCT answers 500 to any update of one.
      msg unchanged; echo
      log "unchanged: $k $n ($id)"
      state_set alg "$n" "$id"
      return 0
    fi
    if [ "$TARGET" = dct ]; then
      # DCT's updates take only the fields that may change.
      case "$k" in
        alg) jq '{config, description}' "$WORK/body.json" > "$WORK/patch.json" ;;
        dc) jq 'del(.name, .algorithm_ids)' "$WORK/body.json" > "$WORK/patch.json" ;;
        cls) cp "$WORK/body.json" "$WORK/patch.json" ;;
        pol) jq 'del(.classifier_ids)' "$WORK/body.json" > "$WORK/patch.json" ;;
      esac
      http PATCH "$update$id" "$WORK/patch.json"
    else
      if [ "$k" = cls ]; then
        # An engine keeps a classifier's framework; send the one it has.
        jq --arg id "$id" --slurpfile all "$WORK/remote-cls.json" '.frameworkId = ([$all[0][] | select((.classifierId | tostring) == $id)][0].frameworkId // .frameworkId)' "$WORK/body.json" > "$WORK/patch.json"
      else
        cp "$WORK/body.json" "$WORK/patch.json"
      fi
      http PUT "$update$(jq -rn --arg v "$id" '$v|@uri')" "$WORK/patch.json"
    fi
    if [ "$STATUS" = 500 ] && [ "$TARGET" = dct ] && [ "$k" = alg ]; then fail "$(msg checkdigit "$n")"; fi
    { ok_status && wait_done; } || fail "$n — ${ERROR:-$(error_text)}"
    UPDATED=$((UPDATED + 1))
  else
    printf '%s… ' "$(msg creating "$(kind_label "$k")" "$n")"
    http POST "$create" "$WORK/body.json"
    { ok_status && wait_done; } || fail "$n — ${ERROR:-$(error_text)}"
    CREATED=$((CREATED + 1))
    case "$TARGET:$k" in
      dct:*) id=$(jq -r '.id // .hook_template.id // empty' "$WORK/resp") ;;
      engine:alg|engine:dc) id="$n" ;;
      engine:cls) id=$(jq -r '.classifierId // empty' "$WORK/resp") ;;
      engine:pol) id=$(jq -r '.profileSetId // empty' "$WORK/resp") ;;
    esac
  fi
  msg ok; echo
  log "sent: $k $n ($id)"
  case "$k" in alg) state_set alg "$n" "$id" ;; dc) state_set dc "$n" "$id" ;; cls) state_set cls "$n" "$id" ;; esac
  # A DCT policy's members are a call of their own on update.
  if [ "$TARGET" = dct ] && [ "$k" = pol ] && [ -n "$(state_get update "pol:$n")" ]; then
    jq '{classifier_ids}' "$WORK/body.json" > "$WORK/members.json"
    http POST "/discovery-policies/$id/classifiers" "$WORK/members.json"
    { ok_status && wait_done; } || log "members not added: $(error_text)"
  fi
}

echo
if [ "$TARGET" = dct ]; then
  ALG_PATH=/algorithms; ALG_UPDATE=/algorithms/; DC_PATH=/data-classes; DC_UPDATE=/data-classes/
  CLS_PATH=/classifiers; CLS_UPDATE=/classifiers/; POL_PATH=/discovery-policies; POL_UPDATE=/discovery-policies/
  TPL="$DATA/dct"
else
  ALG_PATH=/algorithms; ALG_UPDATE=/algorithms/; DC_PATH=/domains; DC_UPDATE=/domains/
  CLS_PATH=/classifiers; CLS_UPDATE=/classifiers/; POL_PATH=/profile-sets; POL_UPDATE=/profile-sets/
  TPL="$DATA/engine"
fi

while IFS=$'\t' read -r n f fw; do send alg "$n" "$TPL/$f" "$ALG_PATH" "$ALG_UPDATE"; done < "$WORK/algorithms.tsv"
while IFS=$'\t' read -r n f; do send dc "$n" "$TPL/$f" "$DC_PATH" "$DC_UPDATE"; done < "$WORK/dataclasses.tsv"
while IFS=$'\t' read -r n f; do send cls "$n" "$TPL/$f" "$CLS_PATH" "$CLS_UPDATE"; done < "$WORK/classifiers.tsv"
send pol "$POLICY_NAME" "$TPL/$POLICY_FILE" "$POL_PATH" "$POL_UPDATE"

echo
msg done "$CREATED" "$UPDATED" "$DELETED"; echo
msg log "$LOG"; echo
log "done: $CREATED created, $UPDATED updated, $DELETED deleted"
