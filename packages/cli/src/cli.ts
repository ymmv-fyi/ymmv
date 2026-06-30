#!/usr/bin/env node
// Bin entry for `ymmv`. This file's ONLY job is to run the CLI, so it has no "am I the main module?"
// guard — index.ts stays import-safe for tests without one. That guard (import.meta.url vs argv[1])
// silently broke `npm i -g` on Linux/macOS/WSL: npm symlinks the bin, so argv[1] is the symlink path
// while import.meta.url is the realpath, they never match, and main() never ran.
import { main } from "./index.js";

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
