import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Tests the BUILT bin, so it needs `tsup` to have run (CI builds before `pnpm test`; locally run
// `pnpm --filter ymmv-cli build` first). Guards the regression where `npm i -g` was silently broken
// on Linux/macOS/WSL: npm symlinks the bin, and the old main-module guard skipped main() whenever the
// invocation path (the symlink) differed from import.meta.url (the realpath).
const binPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe("built bin entry", () => {
  it("starts with a node shebang", () => {
    expect(existsSync(binPath), `build the CLI first — dist/cli.js missing at ${binPath}`).toBe(
      true,
    );
    expect(readFileSync(binPath, "utf8").split("\n", 1)[0]).toBe("#!/usr/bin/env node");
  });

  // Symlink semantics differ on Windows (npm uses a .cmd shim there, no symlink — the bug never
  // manifested), so reproduce the Unix `npm i -g` symlink only off-Windows.
  it.skipIf(process.platform === "win32")("runs main() when invoked through a bin symlink", () => {
    expect(existsSync(binPath), `build the CLI first — dist/cli.js missing at ${binPath}`).toBe(
      true,
    );
    const link = join(mkdtempSync(join(tmpdir(), "ymmv-bin-")), "ymmv");
    symlinkSync(binPath, link);
    // `node <symlink> help` recreates the broken case: argv[1] is the symlink, import.meta.url the
    // realpath. main() must still run and print help.
    const res = spawnSync(process.execPath, [link, "help"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("ymmv");
  });
});
