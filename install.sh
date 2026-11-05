#!/usr/bin/env bash
# Delphix Masking Helper — installer, updater and uninstaller for macOS and Linux.
#
#   curl -fsSL https://adelbs.github.io/delphix-masking-helper/install.sh | bash
#
# Or, to read it before running it:
#
#   curl -fsSL https://adelbs.github.io/delphix-masking-helper/install.sh -o install.sh
#   less install.sh && bash install.sh
#
# It only ever touches its own install directory and a launcher in ~/.local/bin. Node, Java and
# git are checked, never installed: this script will not change your system's toolchain.
#
# A release installs from the archive attached to it on GitHub — the app already built, checked
# against the release's SHA256SUMS — so only Node and Java are needed. git is needed only for a
# release without that archive, or to follow the default branch: then it clones and builds.
#
# The Delphix libraries are licensed and cannot be downloaded by anything — the app itself
# explains how to supply them on first run.

set -euo pipefail

# Overridable so a fork — or a local checkout during testing — can be installed from.
REPO_URL="${DLPX_REPO_URL:-https://github.com/adelbs/delphix-masking-helper.git}"
# Pins the install to one ref. Empty means "the newest release", resolved from the remote.
DLPX_REF="${DLPX_REF:-}"
# Where the files of the releases are; a mirror can stand in for GitHub. Each release is a folder
# named after its tag, holding delphix-masking-helper-<tag>.tar.gz and SHA256SUMS.
REPO_PATH=$(printf '%s' "$REPO_URL" | sed -E 's#^.*github\.com[/:]##; s#\.git$##')
RELEASES_URL="${DLPX_RELEASES_URL:-https://github.com/$REPO_PATH/releases/download}"
DEFAULT_DIR="$HOME/delphix-masking-helper"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/dlpx-helper"
NODE_MIN=22
JAVA_MIN=11

# Prompts must read from the terminal: piped into bash, stdin is the script itself. Opening it
# is the only reliable test — /dev/tty can exist and still refuse to open (cron, CI, a container
# without a controlling terminal), and a permission check alone let those through.
TTY=/dev/tty
{ : < "$TTY"; } 2>/dev/null || TTY=""

bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); red=$(printf '\033[31m')
green=$(printf '\033[32m'); yellow=$(printf '\033[33m'); reset=$(printf '\033[0m')

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s\n' "$bold" "$reset" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$green" "$reset" "$*"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset" "$*"; }
die()  { printf '\n%serror:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

ask() {
  local prompt="$1" default="${2-}" answer
  if [ -z "$TTY" ]; then printf '%s\n' "$default"; return; fi
  printf '%s' "$prompt" > "$TTY"
  read -r answer < "$TTY" || answer=""
  printf '%s\n' "${answer:-$default}"
}

confirm() {
  local answer
  answer=$(ask "$1 [y/N] " "n")
  case "$answer" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# ── prerequisites ────────────────────────────────────────────────────────────

hint_install() {
  case "$(uname -s)" in
    Darwin) say "        macOS:  brew install $1" ;;
    Linux)  say "        Debian/Ubuntu:  sudo apt install $2" ;;
  esac
}

check_prereqs() {
  step "Checking what is already on this machine"
  local missing=0

  if command -v node >/dev/null 2>&1; then
    local v; v=$(node -v | sed 's/^v//' | cut -d. -f1)
    if [ "$v" -ge "$NODE_MIN" ]; then ok "Node $(node -v)"
    else warn "Node $(node -v) is too old — $NODE_MIN or newer is required."; hint_install node nodejs; missing=1; fi
  else
    warn "Node is not installed ($NODE_MIN or newer)."; hint_install node nodejs; missing=1
  fi

  # macOS ships /usr/bin/java and /usr/bin/git even with no JDK or Command Line Tools: stubs that
  # print an error and exit 1. So being on the PATH proves nothing — only a version that parses
  # does. The `|| true` matters: under `set -e` and `pipefail` a failing stub ended the script
  # right here, without a word.
  local jv=""
  if command -v java >/dev/null 2>&1; then
    # Java 8 and older report themselves as "1.8.0_…".
    jv=$(java -version 2>&1 | head -1 | sed -nE 's/.*"1\.([0-9]+)[^"]*".*/\1/p; s/.*"([0-9]+)([.].*)?".*/\1/p' || true)
  fi
  if [ -z "$jv" ]; then
    warn "Java is not installed ($JAVA_MIN or newer)."; hint_install "--cask temurin" default-jdk; missing=1
  elif [ "$jv" -ge "$JAVA_MIN" ]; then ok "Java $jv"
  else warn "Java $jv is too old — $JAVA_MIN or newer is required."; hint_install "--cask temurin" default-jdk; missing=1; fi

  local gv=""
  if command -v git >/dev/null 2>&1; then
    gv=$(git --version 2>/dev/null | awk '{print $3}' || true)
  fi
  # Only a release without its archive, or the default branch, needs git: checked, not required.
  if [ -n "$gv" ]; then ok "git $gv"; HAVE_GIT=1
  else say "  ${dim}- git is not installed: fine for a release, needed only to follow the default branch.${reset}"; HAVE_GIT=0; fi
  command -v curl >/dev/null 2>&1 || { warn "curl is not installed."; hint_install curl curl; missing=1; }

  if [ "$missing" -ne 0 ]; then
    die "Install what is missing above, then run this again. Nothing was changed."
  fi
}

# ── which version to install ─────────────────────────────────────────────────

# The newest release tag, read straight from the remote — so cutting a release needs no edit
# here. Deliberately git and not the GitHub releases API: git is already a hard requirement,
# it keeps working for forks and non-GitHub remotes that DLPX_REPO_URL points at, and it has
# no unauthenticated rate limit to trip over.
#
# Only vMAJOR.MINOR.PATCH counts, so a pre-release tag (v2.0.0-rc1) is never picked up by
# someone running the plain one-liner. The sort is by numeric field rather than `sort -V`,
# which is GNU-only: field order is what makes v1.10.0 newer than v1.9.0.
latest_ref() {
  if ! command -v git >/dev/null 2>&1; then
    # Without git: where GitHub sends .../releases/latest, which ends in the newest tag.
    curl -fsSIL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO_PATH/releases/latest" 2>/dev/null \
      | sed -nE 's#.*/releases/tag/(v[0-9]+\.[0-9]+\.[0-9]+)$#\1#p' || true
    return
  fi
  git ls-remote --tags --refs "$REPO_URL" 2>/dev/null \
    | awk '{print $2}' | sed 's#refs/tags/##' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1 | sed 's/^/v/' || true
}

# Empty output means "no release to track" — a fork that has never tagged, or an unreachable
# remote. Callers fall back to the default branch rather than refusing to install.
resolve_ref() {
  if [ -n "$DLPX_REF" ]; then printf '%s\n' "$DLPX_REF"; else latest_ref; fi
}

# ── launcher ─────────────────────────────────────────────────────────────────

write_launcher() {
  local dir="$1"
  mkdir -p "$BIN_DIR"

  # The body is a quoted heredoc so the shell expands nothing inside it: an unquoted one ran the
  # backticks in the comments as commands while generating the file. Only APP_DIR is injected,
  # written before the body.
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' '# Delphix Masking Helper launcher. Generated by install.sh — rewritten on every update.'
    printf '%s\n' 'set -euo pipefail'
    printf 'APP_DIR=%q\n' "$dir"
    cat <<'LAUNCHER_EOF'
PID_FILE="$APP_DIR/.dlpx-helper.pid"
LOG="$APP_DIR/.dlpx-helper.log"
PORT="${PORT:-3000}"
URL="http://localhost:$PORT"

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

open_url() {
  # if/elif, not an && || chain: chained that way a successful open still fell through to
  # xdg-open, which does not exist on macOS.
  if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  else echo "Open $URL"
  fi
}

start() {
  if running; then echo "Already running at $URL"; open_url; return; fi
  cd "$APP_DIR"
  # The frontend is built at install and update time, not on every start.
  [ -d "$APP_DIR/frontend/dist" ] || npm run build --silent
  # node directly, not npm start: npm would be the parent of a shell that is the parent of node,
  # so the recorded pid was npm's and stopping it left the server holding the port.
  # Detached on purpose — closing the terminal must not take the app down with it.
  PORT="$PORT" nohup node server.js > "$LOG" 2>&1 &
  echo $! > "$PID_FILE"
  printf 'Starting'
  for _ in $(seq 1 60); do
    # Probes the root, not an API route: endpoints come and go between versions.
    if curl -fsS -o /dev/null "$URL/" 2>/dev/null; then
      printf '\n%s\n' "Running at $URL"; open_url; return
    fi
    if ! running; then printf '\n'; echo "It stopped on startup:" >&2; tail -20 "$LOG" >&2; exit 1; fi
    printf '.'; sleep 1
  done
  printf '\n'
  echo "No answer after 60s. Last lines of $LOG:" >&2
  tail -20 "$LOG" >&2
  exit 1
}

stop() {
  if ! running; then echo "Not running."; rm -f "$PID_FILE"; return; fi
  pid=$(cat "$PID_FILE")
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Stopped."
}

# Reads the tag out of the checkout, the same way the server does. No network call: this
# answers "what do I have", not "is there something newer".
version() {
  v=""
  [ -f "$APP_DIR/release.json" ] && v=$(node -p "require('$APP_DIR/release.json').tag" 2>/dev/null || true)
  [ -n "$v" ] || v=$(git -C "$APP_DIR" describe --tags --always --dirty 2>/dev/null || true)
  if [ -z "$v" ]; then
    v=$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || true)
  fi
  [ -n "$v" ] && echo "$v" || echo "unknown"
}

case "${1:-start}" in
  start|"")  start ;;
  stop)      stop ;;
  restart)   stop; start ;;
  status)    running && echo "Running at $URL" || echo "Not running." ;;
  version|--version|-v) version ;;
  logs)      tail -f "$LOG" ;;
  update)    bash "$APP_DIR/install.sh" --update ;;
  uninstall) bash "$APP_DIR/install.sh" --uninstall ;;
  *) echo "usage: dlpx-helper [start|stop|restart|status|version|logs|update|uninstall]" >&2; exit 2 ;;
esac
LAUNCHER_EOF
  } > "$LAUNCHER"

  chmod +x "$LAUNCHER"
  ok "Command installed: $LAUNCHER"
}

path_advice() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) ok "$BIN_DIR is already on your PATH." ;;
    *)
      warn "$BIN_DIR is not on your PATH. Add this to your shell profile:"
      say  "        export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
}

# ── the checkout ─────────────────────────────────────────────────────────────

# The presets are most of the repository, and a user loads one or two: the app downloads a
# preset's files from GitHub the first time it is used (preset-catalog.js). So the checkout leaves
# their folders out, keeping presets/index.json, the shared tooling under presets/_*/ and the rest.
PRESET_PATTERNS=('/*' '!/presets/*/' '/presets/_*/')

# clone_app REF DIR — a partial clone (blobs fetched only for what is checked out) without the
# preset folders. REF empty is the default branch. A git too old for either gets the whole
# repository, which works the same.
clone_app() {
  local ref="$1" dir="$2"
  local branch=()
  [ -n "$ref" ] && branch=(--branch "$ref")
  if git -c advice.detachedHead=false clone --quiet --depth 1 --filter=blob:none --no-checkout \
       ${branch[@]+"${branch[@]}"} "$REPO_URL" "$dir" 2>/dev/null \
     && git -C "$dir" sparse-checkout set --no-cone "${PRESET_PATTERNS[@]}" 2>/dev/null \
     && git -C "$dir" -c advice.detachedHead=false checkout --quiet ${ref:+--detach "$ref"}; then
    return 0
  fi
  rm -rf "$dir"
  git -c advice.detachedHead=false clone --quiet --depth 1 ${branch[@]+"${branch[@]}"} "$REPO_URL" "$dir"
}

# limit_presets DIR — an install from before: from now on it fetches without the blobs it does not
# check out, and its preset folders leave the working tree. What the old clone already holds in
# .git stays there; reinstalling frees that too.
limit_presets() {
  local dir="$1"
  git -C "$dir" sparse-checkout list 2>/dev/null | grep -qxF '!/presets/*/' && return 0
  git -C "$dir" config remote.origin.promisor true
  git -C "$dir" config remote.origin.partialclonefilter blob:none
  if git -C "$dir" sparse-checkout set --no-cone "${PRESET_PATTERNS[@]}" 2>/dev/null; then
    ok "Preset folders left out of the checkout — each comes down when it is first used"
  else
    git -C "$dir" config --unset remote.origin.promisor || true
    git -C "$dir" config --unset remote.origin.partialclonefilter || true
  fi
}

# ── the release archive ──────────────────────────────────────────────────────

# A release archive that is there but wrong is the end of it, not a reason to try git instead:
# inside $( ) die would only end the subshell, so these leave with 3 and the caller stops.
fatal() { printf '\n%serror:%s %s\n' "$red" "$reset" "$*" >&2; exit 3; }

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

# fetch_release TAG — downloads the app archive of a release and its SHA256SUMS into a new
# temporary folder, checks it, unpacks it, and prints the folder of the app inside. Fails quietly
# when that release has no archive (one published before there were any).
fetch_release() {
  local tag="$1" tmp name="delphix-masking-helper-$1"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/SHA256SUMS" "$RELEASES_URL/$tag/SHA256SUMS" 2>/dev/null || { rm -rf "${tmp:?}"; return 1; }
  local want; want=$(awk -v f="$name.tar.gz" '$2 == f {print $1}' "$tmp/SHA256SUMS")
  [ -n "$want" ] || { rm -rf "${tmp:?}"; return 1; }
  curl -fSL --progress-bar -o "$tmp/$name.tar.gz" "$RELEASES_URL/$tag/$name.tar.gz" >&2 || { rm -rf "${tmp:?}"; return 1; }
  [ "$(sha256_of "$tmp/$name.tar.gz")" = "$want" ] || { rm -rf "${tmp:?}"; fatal "$name.tar.gz does not match the release's SHA256SUMS."; }
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp" || { rm -rf "${tmp:?}"; fatal "Could not unpack $name.tar.gz."; }
  [ -f "$tmp/$name/release.json" ] || { rm -rf "${tmp:?}"; fatal "$name.tar.gz is not a Delphix Masking Helper release."; }
  printf '%s\n' "$tmp/$name"
}

# The files a release brought, one per line — read with node, which is here by then.
release_files() { node -e 'for (const f of require(process.argv[1]).files) console.log(f)' "$1"; }

# sync_release NEW DIR — puts the release unpacked at NEW in place of the app at DIR. What the old
# version brought and the new one does not is removed; what is not the app's — db/ (everything
# saved in it, the downloaded presets), the jars in lib/, test files — is never touched. An install
# made with git loses its .git and its build tools: from here on it updates from archives.
sync_release() {
  local new="${1:?}" dir="${2:?}" old
  old=$(mktemp)
  if [ -f "$dir/release.json" ]; then release_files "$dir/release.json" > "$old"
  elif [ -d "$dir/.git" ]; then git -C "$dir" ls-files > "$old" 2>/dev/null || : > "$old"
  else : > "$old"; fi
  release_files "$new/release.json" | sort > "$old.new"
  sort "$old" | comm -23 - "$old.new" | while IFS= read -r f; do
    case "$f" in db/*|lib/*.jar|''|*..*) continue ;; esac
    rm -f "${dir:?}/${f:?}"
    # And the folders it leaves empty — rmdir never removes one with anything in it.
    rmdir -p "$(dirname "${dir:?}/${f:?}")" 2>/dev/null || true
  done
  rm -rf "${dir:?}/node_modules" "${dir:?}/frontend/dist" "${dir:?}/frontend/node_modules" "${dir:?}/.git"
  cp -R "$new/." "$dir/"
  rm -f "${old:?}" "${old:?}.new"
}

# install_release TAG DIR — a new install from the release archive. Fails when there is none.
install_release() {
  local tag="$1" dir="$2" new
  new=$(fetch_release "$tag") || { local rc=$?; [ "$rc" -eq 3 ] && exit 1; return 1; }
  mkdir -p "$dir"
  cp -R "$new/." "$dir/"
  rm -rf "$(dirname "${new:?}")"
}

# ── actions ──────────────────────────────────────────────────────────────────

do_install() {
  check_prereqs

  step "Where should it be installed?"
  local dir; dir=$(ask "  Directory [$DEFAULT_DIR]: " "$DEFAULT_DIR")
  dir="${dir/#\~/$HOME}"

  if [ -d "$dir/.git" ] || [ -f "$dir/release.json" ]; then
    warn "There is already an install at $dir."
    confirm "  Update it instead?" && { do_update "$dir"; return; }
    die "Nothing was changed."
  fi
  [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ] && die "$dir exists and is not empty."

  step "Downloading"
  local ref; ref=$(resolve_ref)
  if [ -n "$ref" ] && install_release "$ref" "$dir"; then
    ok "Installed $ref into $dir"
  elif [ "${HAVE_GIT:-0}" = 1 ]; then
    if [ -n "$ref" ]; then
      warn "$ref has no release archive — cloning and building it instead."
      clone_app "$ref" "$dir"
      ok "Cloned $ref into $dir"
    else
      # No tag to track: better a working install off the default branch than none at all.
      clone_app "" "$dir"
      warn "No release tag found — installed the default branch instead."
    fi
    build "$dir"
  else
    die "${ref:-The newest release} has no release archive to install, and without git it cannot be cloned. Install git and run this again."
  fi

  write_launcher "$dir"
  path_advice
  finish "$dir"
}

build() {
  local dir="$1"
  step "Installing dependencies"
  # --omit=dev at the root: its devDependencies are the maintainer's tools (the demo recorder
  # pulls puppeteer-core, tens of megabytes) and none are needed to build or run the app.
  # The frontend keeps its dev dependencies — vite and typescript are what build it.
  # --no-save: the install directory is a checkout, not a development tree. Some npm versions
  # rewrite package-lock.json on a plain install, which leaves a modified tracked file behind
  # and blocks the next update from moving the working tree.
  ( cd "$dir" && npm install --silent --no-audit --no-fund --no-save --omit=dev )
  ( cd "$dir" && npm install --silent --no-audit --no-fund --no-save --prefix frontend )
  ok "Dependencies installed"

  step "Building"
  ( cd "$dir" && npm run build --silent )
  ok "Built"
}

do_update() {
  local dir="${1:-}"
  [ -n "$dir" ] || dir=$(find_install)
  [ -d "$dir/.git" ] || [ -f "$dir/release.json" ] || die "No install found. Run without --update to install."

  step "Updating $dir"
  local ref; ref=$(resolve_ref)

  # From the release archive whenever the release has one — a git install moves over to archives.
  if [ -n "$ref" ]; then
    local current=""
    [ -f "$dir/release.json" ] && current=$(node -p "require('$dir/release.json').tag" 2>/dev/null || true)
    if [ "$current" = "$ref" ]; then
      ok "Already up to date ($ref)."
      write_launcher "$dir"
      return
    fi
    local new rc=0
    new=$(fetch_release "$ref") || rc=$?
    [ "$rc" -eq 3 ] && exit 1
    if [ "$rc" -eq 0 ]; then
      [ -d "$dir/.git" ] && say "  ${dim}This install was made with git; from now on it updates from release archives.${reset}"
      local from="${current:-$(git -C "$dir" describe --tags --always 2>/dev/null || echo "the old version")}"
      sync_release "$new" "$dir"
      rm -rf "$(dirname "${new:?}")"
      ok "Updated $from → $ref"
      write_launcher "$dir"
      say ""
      ok "Your saved algorithms and settings were untouched — they live in $dir/db/."
      say "  Restart it with: ${bold}dlpx-helper restart${reset}"
      return
    fi
    [ -d "$dir/.git" ] || die "$ref has no release archive, and this install was not made with git."
    warn "$ref has no release archive — updating with git instead."
  fi
  [ -d "$dir/.git" ] || die "No release to update to was found."
  command -v git >/dev/null 2>&1 || die "This install updates with git, which is not installed."

  local before; before=$(git -C "$dir" rev-parse --short HEAD)
  limit_presets "$dir"

  if [ -n "$ref" ]; then
    # Fetching the one tag keeps the clone shallow. It is allowed to fail — an install that
    # already has the tag is still fine to move onto, and only a genuinely missing ref is fatal.
    git -C "$dir" fetch --quiet --depth 1 origin "refs/tags/$ref:refs/tags/$ref" 2>/dev/null || true
    git -C "$dir" rev-parse -q --verify "refs/tags/$ref" >/dev/null 2>&1 \
      || die "Could not fetch $ref from $REPO_URL."
    # --detach because a release is a point, not a branch to accumulate commits on. Installs
    # made before this script tracked releases sit on the default branch; this is what moves
    # them across, and from then on every update is release to release.
    git -C "$dir" -c advice.detachedHead=false checkout --quiet --detach "$ref" \
      || die "Could not switch to $ref — the install has local changes."
  else
    warn "No release tag found — following the default branch."
    git -C "$dir" pull --quiet --ff-only || die "Could not fast-forward — the install has local changes."
  fi

  local after; after=$(git -C "$dir" rev-parse --short HEAD)
  if [ "$before" = "$after" ]; then ok "Already up to date${ref:+ ($ref)}."
  else ok "Updated $before → $after${ref:+ ($ref)}"; fi

  build "$dir"
  write_launcher "$dir"
  say ""
  ok "Your saved algorithms and settings were untouched — they live in $dir/db/."
  say "  Restart it with: ${bold}dlpx-helper restart${reset}"
}

do_uninstall() {
  local dir="${1:-}"
  [ -n "$dir" ] || dir=$(find_install)
  [ -d "$dir" ] || die "No install found."

  step "Uninstalling $dir"
  say ""
  say "  ${bold}This removes everything, including your saved algorithms and settings.${reset}"
  say "  ${dim}They live in $dir/db/ and cannot be recovered afterwards.${reset}"
  say ""
  say "  If you want to keep them, stop now and use ${bold}Export${reset} in the app"
  say "  (sidebar → Algorithms → ⋯ → Export) to save them to a file first."
  say ""
  confirm "  Delete $dir and the dlpx-helper command?" || { say "  Nothing was removed."; return; }

  [ -x "$LAUNCHER" ] && "$LAUNCHER" stop >/dev/null 2>&1 || true
  rm -rf "$dir"
  rm -f "$LAUNCHER"
  ok "Removed."
}

find_install() {
  if [ -x "$LAUNCHER" ]; then
    # The line was written with printf %q, which quotes only when it has to — parsing it with a
    # regex that assumed quotes found nothing. Evaluating our own generated line in a subshell
    # handles every form it can take.
    ( eval "$(grep -m1 '^APP_DIR=' "$LAUNCHER")"; printf '%s\n' "${APP_DIR:-$DEFAULT_DIR}" )
  else
    printf '%s\n' "$DEFAULT_DIR"
  fi
}

finish() {
  local dir="$1"
  step "Done"
  say ""
  say "  Start it with:  ${bold}dlpx-helper${reset}"
  say ""
  say "  ${yellow}One step left:${reset} the masking frameworks come from Delphix product files that"
  say "  cannot be distributed. Copy the jars from your Masking Devkit (SDK) into:"
  say ""
  say "      ${bold}$dir/lib/${reset}"
  say ""
  say "  The app lists exactly which files it needs when you open it."
}

# ── entry ────────────────────────────────────────────────────────────────────

main() {
  case "${1:-}" in
    --update)    do_update ;;
    --uninstall) do_uninstall ;;
    --help|-h)   sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' ;;
    "")
      say "${bold}Delphix Masking Helper${reset}"
      say "${dim}An independent open source project. Requires an active Delphix licence.${reset}"
      if [ -x "$LAUNCHER" ] && { [ -d "$(find_install)/.git" ] || [ -f "$(find_install)/release.json" ]; }; then
        say ""
        say "  An install was found at $(find_install)."
        local choice
        choice=$(ask "  [u]pdate, [r]emove, or [q]uit? [u] " "u")
        case "$choice" in
          [uU]*) do_update ;;
          [rR]*) do_uninstall ;;
          *)     say "  Nothing was changed." ;;
        esac
      else
        do_install
      fi
      ;;
    *) die "Unknown option: $1" ;;
  esac
}

main "$@"
