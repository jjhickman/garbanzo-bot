#!/usr/bin/env bash
set -euo pipefail

# Pack rehearsal (T6 hard gate).
#
# Proves, without mocks, that `npm pack` produces a self-contained tarball
# that installs and boots correctly outside the repo, and — the load-bearing
# assertion for the whole mode-resolution feature (T2/D1) — that an installed
# copy resolves GARBANZO_HOME_DIR to $HOME/.garbanzo with no GARBANZO_HOME
# override. `npm pack` runs the real "prepack" build (tsc + the dist/.packaged
# sentinel), so this exercises the exact artifact `npm publish` would ship.
#
# Usage:
#   bash scripts/pack-rehearsal.sh
#
# Wired into CI as a blocking job — see .github/workflows/ci.yml.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORKDIR="$(mktemp -d -t garbanzo-pack-rehearsal-XXXXXX)"
TEMP_HOME="$WORKDIR/home"
PREFIX="$WORKDIR/prefix"
mkdir -p "$TEMP_HOME" "$PREFIX"

BOT_PID=""

cleanup() {
  local exit_code=$?
  if [[ -n "$BOT_PID" ]] && kill -0 "$BOT_PID" 2>/dev/null; then
    kill "$BOT_PID" 2>/dev/null || true
    wait "$BOT_PID" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
  exit "$exit_code"
}
trap cleanup EXIT

echo "== pack-rehearsal: npm pack =="
TARBALL_NAME="$(npm pack --pack-destination "$WORKDIR" | tail -1)"
TARBALL_PATH="$WORKDIR/$TARBALL_NAME"
echo "Packed: $TARBALL_PATH"

if [[ -f "$REPO_ROOT/dist/.packaged" ]]; then
  echo "FAIL: repo dist/.packaged sentinel survived the pack (postpack must remove it)" >&2
  exit 1
fi

echo
echo "== pack-rehearsal: npm install tarball into an isolated prefix =="
npm install "$TARBALL_PATH" --prefix "$PREFIX" --no-audit --no-fund >/dev/null
echo "Installed into $PREFIX"

BIN_SYMLINK="$PREFIX/node_modules/.bin/garbanzo"
if [[ ! -e "$BIN_SYMLINK" ]]; then
  echo "FAIL: installed bin symlink missing at $BIN_SYMLINK" >&2
  exit 1
fi

# Rehearsal env: only PATH + HOME, pointed at an isolated fake home directory.
# No GARBANZO_HOME — this is the hard-gate condition: mode resolution must
# fall through the sentinel branch to $HOME/.garbanzo entirely on its own,
# with nothing telling it where "home" is except $HOME.
run_rehearsal() {
  env -i "PATH=$PATH" "HOME=$TEMP_HOME" "$@"
}

echo
echo "== (a) installed bin symlink: garbanzo --version =="
VERSION_OUTPUT="$(run_rehearsal "$BIN_SYMLINK" --version)"
echo "  -> ${VERSION_OUTPUT:-<empty>}"
if [[ -z "$VERSION_OUTPUT" ]]; then
  echo "FAIL: garbanzo --version via the installed bin symlink produced no output (symlink no-op bug)" >&2
  exit 1
fi

echo
echo "== (b) garbanzo doctor: expect mode=packaged, home=\$HOME/.garbanzo =="
DOCTOR_OUTPUT="$(run_rehearsal GARBANZO_DOCTOR_OFFLINE=1 "$BIN_SYMLINK" doctor)"
echo "$DOCTOR_OUTPUT"

if ! grep -qF "mode=packaged" <<<"$DOCTOR_OUTPUT"; then
  echo "FAIL: doctor did not report mode=packaged" >&2
  exit 1
fi
if ! grep -qF "home=${TEMP_HOME}/.garbanzo" <<<"$DOCTOR_OUTPUT"; then
  echo "FAIL: doctor did not resolve home=\$HOME/.garbanzo (got a different home path)" >&2
  exit 1
fi
echo "  -> hard-gate assertion confirmed: mode=packaged, home=${TEMP_HOME}/.garbanzo"

echo
echo "== (c) garbanzo setup --non-interactive --platform=discord --deploy=native =="
run_rehearsal "$BIN_SYMLINK" setup \
  --non-interactive \
  --platform=discord \
  --deploy=native \
  --discord-bot-token=test_discord_token_ci \
  --discord-client-id=123456789012345678 \
  --discord-owner-id=999999999999999999 \
  --discord-channel-id=111111111111111111 \
  --discord-channel-name=general \
  --providers=openai \
  --openai-key=test_key_ci

INSTALLED_HOME="$TEMP_HOME/.garbanzo"
for expected in ".env" ".env.discord" "config/discord-channels.json"; do
  if [[ ! -f "$INSTALLED_HOME/$expected" ]]; then
    echo "FAIL: expected setup output file missing: $INSTALLED_HOME/$expected" >&2
    exit 1
  fi
done
echo "  -> file set confirmed under $INSTALLED_HOME"

echo
echo "== (d) boot the installed package (HEALTH_ONLY=true) and probe /health =="
# Non-default port: a stale listener on 3001 (another CI job, an orphaned
# earlier run) must not be able to answer the probe and fake a healthy boot.
HEALTH_PORT=39311
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"
if curl -sf -o /dev/null --max-time 2 "$HEALTH_URL"; then
  echo "FAIL: something is already listening on port $HEALTH_PORT before boot" >&2
  exit 1
fi

# Backgrounded as a direct env command, NOT via the run_rehearsal function: a
# backgrounded function call forks a subshell, making $! the subshell's PID —
# the kill below would then hit the subshell and orphan the actual node
# process (leaving it alive past cleanup, holding the port).
env -i "PATH=$PATH" "HOME=$TEMP_HOME" \
  HEALTH_ONLY=true \
  HEALTH_PORT="$HEALTH_PORT" \
  VECTOR_STORE=none \
  MESSAGING_PLATFORM=whatsapp \
  OWNER_JID=test_owner@s.whatsapp.net \
  OPENROUTER_API_KEY=test_key_ci \
  AI_PROVIDER_ORDER=openrouter \
  "$BIN_SYMLINK" start &
BOT_PID=$!

SUCCESS=0
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "$HEALTH_URL"; then
    SUCCESS=1
    break
  fi
  if ! kill -0 "$BOT_PID" 2>/dev/null; then
    echo "FAIL: installed bot process exited before /health answered" >&2
    wait "$BOT_PID" 2>/dev/null || true
    BOT_PID=""
    exit 1
  fi
  sleep 1
done

kill "$BOT_PID" 2>/dev/null || true
wait "$BOT_PID" 2>/dev/null || true
BOT_PID=""

if [[ "$SUCCESS" -ne 1 ]]; then
  echo "FAIL: $HEALTH_URL never returned 200 within the retry budget" >&2
  exit 1
fi
echo "  -> /health returned 200; process killed cleanly"

echo
echo "== (e) service template shipped in the installed tree =="
INSTALLED_ROOT="$PREFIX/node_modules/garbanzo-bot"
SERVICE_TEMPLATE="$INSTALLED_ROOT/scripts/garbanzo.service"
if [[ ! -f "$SERVICE_TEMPLATE" ]]; then
  echo "FAIL: scripts/garbanzo.service missing from the installed tree ($SERVICE_TEMPLATE)" >&2
  exit 1
fi
echo "  -> found $SERVICE_TEMPLATE"

echo
echo "pack rehearsal: PASS"
