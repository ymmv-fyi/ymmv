#!/usr/bin/env node
// Bin entry for `ymmv`. This file's ONLY job is to run the CLI, so it has no "am I the main module?"
// guard — index.ts stays import-safe for tests without one. That guard (import.meta.url vs argv[1])
// silently broke `npm i -g` on Linux/macOS/WSL: npm symlinks the bin, so argv[1] is the symlink path
// while import.meta.url is the realpath, they never match, and main() never ran.
import { displayError } from "./http.js";
import { main } from "./index.js";
import { message } from "./render.js";

// A reader that stops early (`ymmv x | head -3`, `q` in less, `grep -m1`) closes the pipe, and the
// next write to it fails with EPIPE. Node ignores SIGPIPE, so instead of dying quietly the way a C
// tool would, it emits `error` on the stream, and with no listener that is a stack trace and exit 1.
// The reader already has what it asked for, so EPIPE means "nobody is reading this stream any
// more": from then on its writes are dropped, and the command runs to the end. Finishing rather than
// exiting is for the write commands: `ymmv -y | head -1` closes the pipe after the preview, and
// exiting there could abort a publish before its POST or between the POST and the reply. A view has
// nothing left to do but print, so finishing costs it nothing. The exit code is the command's own
// (0 when it worked), not 141: under `set -o pipefail` a publish that succeeded must not read as a
// failure because its reader left. stderr gets the same treatment (`ymmv x 2>&1 | head -1`), and
// the other stream keeps working: a failed publish behind `| head -1` still reports on stderr.
// Installed before main() runs: Node emits the error on a later tick, after the write that failed.
for (const stream of [process.stdout, process.stderr]) {
  let gone = false;
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (gone) return;
    // Any other stream error is thrown, so Node reports it and exits 1, as it did for a raw write
    // with no listener. One narrow change: an async error from a console write (say ECONNRESET on
    // a socket stdout) used to vanish into console's own no-op listener, which it only adds when
    // the stream has none; with this one in place it is thrown too.
    if (err.code !== "EPIPE") throw err;
    gone = true;
    // console.log swallows a failed write on its own, but a raw write (the closing blank below,
    // prompt.ts's Ctrl+C newline) would raise again on the destroyed stream. Drop the bytes, and
    // still call a write callback so nothing waiting on one hangs.
    stream.write = ((_chunk: unknown, ...rest: unknown[]) => {
      const cb = rest.find((a) => typeof a === "function") as (() => void) | undefined;
      if (cb) process.nextTick(cb);
      return true;
    }) as typeof stream.write;
  });
}

main(process.argv.slice(2))
  .catch((err: unknown) => {
    console.error(message(displayError(err)));
    process.exitCode = 1;
  })
  .finally(() => {
    // The one closing blank line before the shell prompt (render.ts convention). On a non-zero
    // exit it goes to stderr, so failure-only runs leave stdout byte-clean for pipes/captures.
    // After an EPIPE on that stream the write is a no-op (above).
    (process.exitCode ? process.stderr : process.stdout).write("\n");
  });
