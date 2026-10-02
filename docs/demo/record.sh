#!/usr/bin/env bash
# Re-records docs/demo.gif from docs/demo/demo.tape: `pnpm demo` at the repo root (`pnpm -w demo`
# inside a package), or this file run directly from anywhere.
#
# The tape runs against a local Worker on a throwaway D1 seeded with a signed-in demo account that
# has never published, so it records a first publish without signing in or touching ymmv.fyi.
# Needs VHS 0.10.0 (0.12.0 exits 0 without writing a gif), ttyd and ffmpeg, on Linux, WSL or macOS
# (VHS on native Windows writes no gif either).
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
cleanup() {
  local status=$?
  # `set -m` below gives wrangler its own process group, so this also stops its workerd. The group
  # has to be gone before the D1 it writes to is deleted.
  if [ -n "$worker" ]; then
    kill -- "-$worker" 2>/dev/null || true
    for _ in $(seq 20); do
      kill -0 -- "-$worker" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL -- "-$worker" 2>/dev/null || true
  fi
  # A failed run says why before the temp directory goes: what each `ymmv` exited with, the end of
  # the Worker's log, and the gif when VHS got as far as writing one. A Wait that timed out writes
  # none; VHS's own error then quotes the line the terminal was on.
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
# works anywhere is committed.
token=$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')
hash=$(node -p 'require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex")' "$token")
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
# empty environment shell.sh runs the CLI in.
YMMV_DEMO_ROOT=$root YMMV_DEMO_HOME=$tmp/home YMMV_DEMO_NODE=$(node -p process.execPath) \
  YMMV_DEMO_WORKER=http://localhost:$port \
  vhs docs/demo/demo.tape -o "$tmp/demo.gif"

# VHS 0.12.0 exits 0 without writing anything. And a command that failed still ends at a shell
# prompt with VHS exiting 0, so the committed gif is replaced only when the publish landed and every
# `ymmv` the tape ran exited 0 (shell.sh logs each status).
[ -s "$tmp/demo.gif" ] || { echo "demo: vhs wrote no gif" >&2; exit 1; }
if ! kill -0 "$worker" 2>/dev/null || [ "$(probe /api/v1/u/bardisty)" != 200 ]; then
  echo "demo: the recording didn't publish the demo profile, so docs/demo.gif is unchanged" >&2
  exit 1
fi
if [ ! -s "$tmp/home/statuses" ] || grep -qv '^0$' "$tmp/home/statuses"; then
  echo "demo: a ymmv command in the recording failed, so docs/demo.gif is unchanged" >&2
  exit 1
fi
mv "$tmp/demo.gif" docs/demo.gif
echo "Wrote docs/demo.gif"
