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

  // The output convention's closing blank (cli.ts .finally) and the wrapped .catch/error prints
  // only exist at the bin layer — nothing above dist/cli.js exercises them.
  it("ends every run with exactly one closing blank line", () => {
    const res = spawnSync(process.execPath, [binPath, "help"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout.endsWith("\n\n")).toBe(true); // help text, then the one closing blank
    expect(res.stdout.endsWith("\n\n\n")).toBe(false); // exactly one — never two
  });

  // help and --version are the convention's documented flush-left exceptions — pin the head
  // bytes so wrapping either print in message() cannot slip through.
  it("keeps help and --version flush-left (no leading blank, no indent)", () => {
    const help = spawnSync(process.execPath, [binPath, "help"], { encoding: "utf8" });
    expect(help.stdout.startsWith("ymmv:")).toBe(true);
    const version = spawnSync(process.execPath, [binPath, "--version"], { encoding: "utf8" });
    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(/^ymmv-cli /);
  });

  // Dispatch wiring, not resolver logic: the pure table is pinned in resolve.test.ts; these
  // prove the words actually reach their commands through the built bin.
  it("dispatches the bare `version` word through the built bin", () => {
    const res = spawnSync(process.execPath, [binPath, "version"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^ymmv-cli /);
  });

  it("flag-first `-y delete` exits 1 with the ordering hint, publishing nothing", () => {
    // Errors in resolveArg before any command runs, so no network is ever touched.
    const res = spawnSync(process.execPath, [binPath, "-y", "delete"], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("ymmv delete -y");
    expect(res.stdout).toBe("");
  });

  it("prints arg errors as indented units on stderr, leaving stdout byte-clean", () => {
    const res = spawnSync(process.execPath, [binPath, "set", "bogus-key", "x"], {
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr.startsWith('\n  "bogus-key" is not a curated key.')).toBe(true);
    expect(res.stderr).toContain("\n  For anything else"); // second line carries its own indent
    expect(res.stderr.endsWith("\n\n")).toBe(true); // closing blank follows the failure stream
    expect(res.stdout).toBe(""); // failed runs emit NOTHING on stdout (pipe/capture safety)
  });

  it("prints thrown errors (bin .catch) as indented units with exit 1", () => {
    // Port 1 fails before any dial (undici rejects it as a bad port) — deterministic, no network.
    // The cause text in the parentheses varies by platform/Node, so only the unit shape is pinned.
    const res = spawnSync(process.execPath, [binPath, "view", "ghost"], {
      encoding: "utf8",
      env: { ...process.env, YMMV_API: "http://127.0.0.1:1" },
    });
    expect(res.status).toBe(1);
    expect(res.stderr.startsWith("\n  Can't reach http://127.0.0.1:1. Check your connection")).toBe(
      true,
    );
    expect(res.stderr.endsWith("\n\n")).toBe(true);
    expect(res.stdout).toBe("");
  });
});
