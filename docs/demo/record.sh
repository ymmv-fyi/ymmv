#!/usr/bin/env bash
# Re-records docs/demo.gif from docs/demo/demo.tape: `pnpm demo` at the repo root (`pnpm -w demo`
# inside a package), or this file run directly from anywhere.
#
# The tape runs against a local Worker on a throwaway D1 seeded with a signed-in demo account that
# has never published, so it records a first publish without signing in or touching ymmv.fyi.
# Needs VHS 0.10.0 (0.12.0 exits 0 without writing a gif), ttyd and ffmpeg, on Linux, WSL or macOS
# (VHS on native Windows writes no gif either). On Linux and WSL also fontconfig's fc-match, and on
# macOS the fonts in docs/demo/fonts installed.
set -euo pipefail

port=8790
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
# A CLOUDFLARE_ENV left over from a deploy would bake production or staging config into the build
# this Worker serves.
unset CLOUDFLARE_ENV

for tool in vhs ttyd ffmpeg node pnpm curl; do
  command -v "$tool" >/dev/null || { echo "demo: $tool is not installed" >&2; exit 1; }
done

# The tape's font, IBM Plex Mono from docs/demo/fonts. A browser that can't find it draws the gif in
# another monospace without a word, so it's checked before anything starts. VHS's browser finds
# fonts through fontconfig on Linux and WSL, and fonts.conf adds that directory to the system's.
# On macOS the browser doesn't read fontconfig, so the font has to be installed.
fontconfig=$root/docs/demo/fonts/fonts.conf
if [ "$(uname)" = Darwin ]; then
  # Not grep -q: under pipefail, a grep that quits at the first match can fail the pipe.
  system_profiler SPFontsDataType 2>/dev/null | grep 'Family: IBM Plex Mono$' >/dev/null || {
    echo "demo: install the fonts in docs/demo/fonts (open each .ttf in Font Book)" >&2
    exit 1
  }
else
  command -v fc-match >/dev/null || {
    echo "demo: fc-match is not installed (it comes with fontconfig)" >&2
    exit 1
  }
  case "$(FONTCONFIG_FILE=$fontconfig fc-match -f '%{family}' 'IBM Plex Mono')" in
    "IBM Plex Mono"*) ;;
    *)
      echo "demo: fontconfig can't find IBM Plex Mono through $fontconfig" >&2
      exit 1
      ;;
  esac
fi

# One request to the local Worker, printing its status: no ~/.curlrc, no proxy, and a 2-second
# cap, since a listener that accepts and never answers would otherwise hang the script.
probe() {
  curl -q -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 2 "http://localhost:$port$1"
}
# curl exits 7 only when nothing accepts the connection.
rc=0
probe / >/dev/null || rc=$?
if [ "$rc" -ne 7 ]; then
  echo "demo: port $port is in use. Stop whatever holds it and rerun." >&2
  exit 1
fi

tmp=$(mktemp -d)
# Where a failed recording is kept: outside the repo, so it can't dirty the tree or be committed,
# and under one name, so each failed run replaces the last instead of piling up.
failed=${TMPDIR:-/tmp}/ymmv-demo-failed.gif
worker=
vhs=
# Stops a job started under `set -m`, which gave it its own process group: wrangler's holds its
# workerd and VHS's its ttyd. The browser VHS starts is in a group of its own, and VHS closes it
# when it gets the TERM.
stop() {
  [ -n "$1" ] || return 0
  kill -- "-$1" 2>/dev/null || true
  for _ in $(seq 20); do
    kill -0 -- "-$1" 2>/dev/null || break
    sleep 0.25
  done
  kill -KILL -- "-$1" 2>/dev/null || true
}
cleanup() {
  local status=$?
  # The Worker's group has to be gone before the D1 it writes to is deleted, and VHS's before the
  # HOME its shell logs to.
  stop "$vhs"
  stop "$worker"
  # A failed run says why before the temp directory goes: what each `ymmv` exited with, the end of
  # the Worker's log, and the gif when VHS got as far as writing one. A Wait that timed out writes
  # none; VHS's own error then quotes the line the terminal was on. A TERM or HUP ends the script
  # with this status at 0, so that run stops what it started and prints nothing more. A Ctrl-C
  # arrives as 130 and is reported like any failure, with the part of the gif VHS had recorded.
  if [ "$status" -ne 0 ]; then
    if [ -s "$tmp/home/statuses" ]; then
      echo "demo: the recording's ymmv commands exited with: $(tr '\n' ' ' <"$tmp/home/statuses")" >&2
    fi
    if [ -s "$tmp/wrangler.log" ]; then
      echo "demo: the local Worker's log ends with:" >&2
      tail -n 20 "$tmp/wrangler.log" >&2
    fi
    if [ -s "$tmp/demo.gif" ] && mv "$tmp/demo.gif" "$failed"; then
      echo "demo: the failed recording is at $failed" >&2
    fi
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

pnpm -r build

# A fresh login for each run. Its hash goes into this run's copy of the seed, so no token that
# works anywhere is committed. One process makes both, so the token is never on a command line.
login=$(node -p 'const c = require("node:crypto"), t = c.randomBytes(32).toString("hex");
  `${t} ${c.createHash("sha256").update(t).digest("hex")}`')
token=${login% *}
hash=${login#* }
sed "s/@TOKEN_HASH@/$hash/" docs/demo/seed.sql >"$tmp/seed.sql"

cd packages/web
pnpm exec wrangler d1 migrations apply ymmv --local --persist-to "$tmp/d1" </dev/null
pnpm exec wrangler d1 execute ymmv --local --persist-to "$tmp/d1" --file "$tmp/seed.sql"
set -m
pnpm exec wrangler dev -c dist/server/wrangler.json --port "$port" --persist-to "$tmp/d1" \
  </dev/null >"$tmp/wrangler.log" 2>&1 &
worker=$!
set +m
cd "$root"

ready() { [ "$(probe /api/v1/u/LottieDottieDa)" = 200 ]; }
for _ in $(seq 60); do
  ready && break
  kill -0 "$worker" 2>/dev/null || { echo "demo: the local Worker stopped" >&2; exit 1; }
  sleep 1
done
ready || {
  echo "demo: the local Worker didn't answer within 60 seconds" >&2
  exit 1
}

# The login stored where the CLI looks under the demo's HOME (the env-paths config dir). Its base
# is ymmv.fyi, the address the CLI shows; reroute.mjs sends the requests to the local Worker.
case "$(uname)" in
  Darwin) config=$tmp/home/Library/Preferences/ymmv ;;
  *) config=$tmp/home/.config/ymmv ;;
esac
mkdir -p -m 700 "$config"
printf '{"base":"https://ymmv.fyi","token":"%s","handle":"bardisty","github_id":101}' "$token" \
  >"$config/token.json"
chmod 600 "$config/token.json"

# process.execPath, not `command -v node`: a version manager's shim can't find its node under the
# empty environment shell.sh runs the CLI in. VHS runs as a job in its own process group, waited
# for, so a signal to this script reaches cleanup at once and cleanup can stop VHS with everything
# it started.
set -m
YMMV_DEMO_ROOT=$root YMMV_DEMO_HOME=$tmp/home YMMV_DEMO_NODE=$(node -p process.execPath) \
  YMMV_DEMO_WORKER=http://localhost:$port FONTCONFIG_FILE=$fontconfig \
  vhs docs/demo/demo.tape -o "$tmp/demo.gif" </dev/null &
vhs=$!
set +m
wait "$vhs"

# VHS 0.12.0 exits 0 without writing anything. And a command that failed still ends at a shell
# prompt with VHS exiting 0, so the committed gif is replaced only when the publish landed and every
# command the tape runs was `ymmv` and exited 0 (shell.sh logs each status). The tape ends each one
# with a bare `Wait`, for the shell prompt, so the log has to hold one 0 per bare Wait: a mistyped
# `ymv` logs nothing, and counting the tape's `ymmv` lines would miss it along with the log.
[ -s "$tmp/demo.gif" ] || { echo "demo: vhs wrote no gif" >&2; exit 1; }
if ! kill -0 "$worker" 2>/dev/null || [ "$(probe /api/v1/u/bardisty)" != 200 ]; then
  echo "demo: the recording didn't publish the demo profile, so docs/demo.gif is unchanged" >&2
  exit 1
fi
scenes=$(grep -cE '^Wait[[:space:]]*(#|$)' docs/demo/demo.tape)
ran=$(grep -c '^0$' "$tmp/home/statuses" 2>/dev/null || true)
if [ "$ran" != "$scenes" ] || grep -qv '^0$' "$tmp/home/statuses"; then
  echo "demo: the tape runs $scenes commands and ${ran:-0} of them were a ymmv that exited 0, so" \
    "docs/demo.gif is unchanged" >&2
  exit 1
fi
mv "$tmp/demo.gif" docs/demo.gif
echo "Wrote docs/demo.gif"
