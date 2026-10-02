# Sourced by demo.tape's hidden setup, in the shell record.sh starts VHS from. `ymmv` is the repo's
# build, run under an empty environment plus the demo stack below, so detection finds the same 7 of
# 13 fields on any machine (OS comes from the recording machine) and the walk asks for the other 6.
# Outside `pnpm demo` this returns 1, and the tape's `|| exit` ends the shell, so a `ymmv` typed
# after it can never reach a global install signed in as you.
if [ -z "${YMMV_DEMO_ROOT-}" ] || [ -z "${YMMV_DEMO_HOME-}" ] || [ -z "${YMMV_DEMO_NODE-}" ] ||
  [ -z "${YMMV_DEMO_WORKER-}" ]; then
  echo "demo: record with pnpm demo" >&2
  return 1
fi
# --import reads its argument as a URL, so a `#`, `?` or `%` in the checkout's path would end the
# path early or be decoded. The file URL has them encoded.
ymmv_demo_reroute=$("$YMMV_DEMO_NODE" -p 'require("node:url").pathToFileURL(process.argv[1]).href' \
  "$YMMV_DEMO_ROOT/docs/demo/reroute.mjs") || return 1

ymmv() {
  env -i \
    HOME="$YMMV_DEMO_HOME" PATH=/usr/bin:/bin TERM="$TERM" \
    VISUAL=zed SHELL=/bin/bash TERM_PROGRAM=WarpTerminal BROWSER=zen MISE_SHELL=bash CLAUDECODE=1 \
    YMMV_NO_UPDATE_CHECK=1 YMMV_DEMO_WORKER="$YMMV_DEMO_WORKER" \
    "$YMMV_DEMO_NODE" --import "$ymmv_demo_reroute" \
    "$YMMV_DEMO_ROOT/packages/cli/dist/cli.js" "$@"
  # A failed command still ends at a shell prompt, which is all a bare Wait checks, so each exit
  # status is logged for record.sh to check.
  local status=$?
  echo "$status" >>"$YMMV_DEMO_HOME/statuses"
  return "$status"
}
