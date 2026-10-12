#!/usr/bin/env bash
#
# Checks the pre-configured profile sets: every presets/<id>/ with a verify.mjs.
#
#   presets/verify-all.sh                       asks which presets and what to check
#   presets/verify-all.sh all                   every preset, asking only what to check
#   presets/verify-all.sh chile-ley-21719 peru-ley-29733 --mode classifiers
#   presets/verify-all.sh all --mode full --build --jobs 3 --yes
#
# Options
#   --mode classifiers   profile the test columns with the local evaluator; needs nothing running
#   --mode full          also mask the sample values through the running app (several minutes each)
#   --build              regenerate preset.json and files/ from build.mjs first
#   --jobs N             run N presets at a time (default 1)
#   --url URL            the app, for --mode full (default $DLPX_URL or http://localhost:3000)
#   --yes                ask nothing: all presets unless named, full mode unless --mode says otherwise
#
# Presets are found by folder, so a new one is checked as soon as it has a verify.mjs. Every run
# writes a log to presets/_logs/ — the whole output, preset by preset, and a summary — and exits
# non-zero when any preset fails.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
LOG_DIR="$ROOT/presets/_logs"

MODE=""
BUILD=""
JOBS=1
YES=""
URL="${DLPX_URL:-http://localhost:3000}"
CHOSEN=()

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#--mode=}"; shift ;;
    --build) BUILD=yes; shift ;;
    --jobs) JOBS="${2:-1}"; shift 2 ;;
    --jobs=*) JOBS="${1#--jobs=}"; shift ;;
    --url) URL="${2:-}"; shift 2 ;;
    --url=*) URL="${1#--url=}"; shift ;;
    --yes|-y) YES=yes; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
    *) CHOSEN+=("$1"); shift ;;
  esac
done

case "$MODE" in ""|classifiers|full) ;; *) echo "--mode is classifiers or full" >&2; exit 2 ;; esac
case "$JOBS" in ''|*[!0-9]*|0) echo "--jobs is a positive number" >&2; exit 2 ;; esac

command -v node >/dev/null 2>&1 || { echo "Node.js is required (node was not found)." >&2; exit 2; }

# ── Which presets ────────────────────────────────────────────────────────────

PRESETS=()
for dir in presets/*/; do
  id="$(basename "$dir")"
  case "$id" in _*) continue ;; esac
  [ -f "$dir/verify.mjs" ] && PRESETS+=("$id")
done
[ ${#PRESETS[@]} -gt 0 ] || { echo "No preset with a verify.mjs under presets/." >&2; exit 2; }

if [ ${#CHOSEN[@]} -eq 0 ] && [ -z "$YES" ]; then
  echo "Profile sets:"
  echo "   0) all"
  i=1
  for id in "${PRESETS[@]}"; do printf "  %2d) %s\n" "$i" "$id"; i=$((i + 1)); done
  printf "Which? Numbers or names, separated by spaces [0]: "
  read -r answer
  for word in ${answer:-0}; do CHOSEN+=("$word"); done
fi
[ ${#CHOSEN[@]} -eq 0 ] && CHOSEN=(all)

SELECTED=()
for word in "${CHOSEN[@]}"; do
  if [ "$word" = all ] || [ "$word" = 0 ]; then SELECTED=("${PRESETS[@]}"); break; fi
  match=""
  case "$word" in
    *[!0-9]*) for id in "${PRESETS[@]}"; do [ "$id" = "$word" ] && match="$id"; done
              # A unique prefix is enough: "chile" for chile-ley-21719.
              if [ -z "$match" ]; then
                for id in "${PRESETS[@]}"; do case "$id" in "$word"*) [ -z "$match" ] && match="$id" || match="AMBIGUOUS" ;; esac; done
              fi ;;
    *) [ "$word" -ge 1 ] && [ "$word" -le ${#PRESETS[@]} ] && match="${PRESETS[$((word - 1))]}" ;;
  esac
  if [ -z "$match" ] || [ "$match" = AMBIGUOUS ]; then echo "Not a preset: $word" >&2; exit 2; fi
  SELECTED+=("$match")
done

# ── What to check ────────────────────────────────────────────────────────────

app_up() { curl -s -m 5 -o /dev/null -w '%{http_code}' "$URL/api/frameworks" 2>/dev/null | grep -q '^200$'; }

if [ -z "$MODE" ]; then
  if [ -n "$YES" ]; then
    MODE=full
  else
    echo
    echo "What to check:"
    echo "  1) classifiers — the test columns, profiled locally; takes seconds, needs nothing running"
    echo "  2) full        — classifiers, then masking through the running app; several minutes per preset"
    printf "Choose [1]: "
    read -r answer
    [ "${answer:-1}" = 2 ] && MODE=full || MODE=classifiers
  fi
fi

if [ "$MODE" = full ] && ! app_up; then
  echo
  echo "The app is not answering at $URL, and the full check masks through it."
  echo "Start it in another terminal (npm run dev, from $ROOT) or pass --url."
  if [ -n "$YES" ]; then exit 2; fi
  printf "Check classifiers only instead? [Y/n]: "
  read -r answer
  case "${answer:-y}" in [nN]*) exit 2 ;; *) MODE=classifiers ;; esac
fi

if [ -z "$BUILD" ] && [ -z "$YES" ]; then
  printf "Regenerate preset.json from build.mjs before checking? [y/N]: "
  read -r answer
  case "${answer:-n}" in [yY]*) BUILD=yes ;; esac
fi

# ── Run ──────────────────────────────────────────────────────────────────────

mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$LOG_DIR/verify-$STAMP.log"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-presets.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

{
  echo "Profile set check — $(date '+%Y-%m-%d %H:%M:%S')"
  echo "commit:  $(git rev-parse --short HEAD 2>/dev/null || echo '?')$(git diff --quiet 2>/dev/null || echo ' (with uncommitted changes)')"
  echo "node:    $(node --version)"
  echo "mode:    $MODE$([ "$MODE" = full ] && echo " — app at $URL")"
  echo "build:   ${BUILD:-no}"
  echo "presets: ${SELECTED[*]}"
} > "$LOG"
cat "$LOG"
echo

check_one() {
  id="$1"; out="$WORK/$id.log"; started=$(date +%s); status=0
  {
    echo "════ $id"
    if [ -n "$BUILD" ]; then
      echo "── build"
      node "presets/$id/build.mjs" 2>&1 || status=1
    fi
    if [ $status -eq 0 ]; then
      if [ "$MODE" = full ]; then
        echo "── verify (classifiers and algorithms)"
        DLPX_URL="$URL" node "presets/$id/verify.mjs" 2>&1 || status=1
      else
        echo "── verify (classifiers)"
        node "presets/$id/verify.mjs" classifiers 2>&1 || status=1
      fi
    fi
  } > "$out" 2>&1
  seconds=$(( $(date +%s) - started ))
  echo "── $([ $status -eq 0 ] && echo passed || echo FAILED) in ${seconds}s" >> "$out"
  echo >> "$out"
  echo "$status $seconds" > "$WORK/$id.status"
  printf "  %-24s %s\n" "$id" "$([ $status -eq 0 ] && echo passed || echo FAILED) (${seconds}s)"
}

echo "Checking ${#SELECTED[@]} preset(s), $JOBS at a time:"
running=0
for id in "${SELECTED[@]}"; do
  check_one "$id" &
  running=$((running + 1))
  if [ $running -ge "$JOBS" ]; then wait; running=0; fi
done
wait

# The app also reviews each preset when it lists them: what it would refuse to load.
SERVER_NOTES=""
if app_up; then
  SERVER_NOTES="$(curl -s -m 30 "$URL/api/presets" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const wanted = new Set(process.argv.slice(1))
      try {
        for (const p of JSON.parse(s)) if (wanted.has(p.id)) {
          const problems = p.problems || []
          console.log(`  ${p.id.padEnd(24)} ${problems.length ? "REFUSED: " + problems.join(" | ") : "accepted"} (v${p.version}, ${p.versionDate || "no date"})`)
        }
      } catch (e) { console.log("  could not read the app’s preset listing: " + e.message) }
    })' "${SELECTED[@]}")"
fi

failed=()
for id in "${SELECTED[@]}"; do
  cat "$WORK/$id.log" >> "$LOG"
  read -r status _ < "$WORK/$id.status"
  [ "$status" -eq 0 ] || failed+=("$id")
done
if [ -n "$SERVER_NOTES" ]; then
  { echo "════ the app's own review of each preset"; echo "$SERVER_NOTES"; echo; } | tee -a "$LOG"
  echo "$SERVER_NOTES" | grep -q REFUSED && failed+=("(app review)")
fi

{
  echo "════ summary"
  for id in "${SELECTED[@]}"; do
    read -r status seconds < "$WORK/$id.status"
    printf "  %-24s %s (%ss)\n" "$id" "$([ "$status" -eq 0 ] && echo passed || echo FAILED)" "$seconds"
  done
  if [ ${#failed[@]} -eq 0 ]; then echo "All ${#SELECTED[@]} passed."; else echo "Failed: ${failed[*]}"; fi
} | tee -a "$LOG"

if [ ${#failed[@]} -gt 0 ]; then
  echo
  echo "What failed (lines with ✗):"
  grep -h "✗\|^Error\|Error:" "$LOG" | head -40
fi
echo
echo "Log: $LOG"
[ ${#failed[@]} -eq 0 ]
