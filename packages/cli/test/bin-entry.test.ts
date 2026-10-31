import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

  // CRITICAL regression pin: `ymmv version`'s piped STDOUT is a machine interface — exactly the
  // version line plus cli.ts's one closing blank, byte-for-byte, regardless of update-check
  // state. The `latest:` hint lives on stderr behind a TTY gate precisely so this shape can
  // never vary with invisible cache freshness. (Spawned pipes are non-TTY, so the hint is
  // structurally absent here; the suite-wide YMMV_NO_UPDATE_CHECK in setup-env is belt and
  // braces on top.)
  it("piped `version` stdout is byte-identical to the pre-update-check contract", () => {
    const res = spawnSync(process.execPath, [binPath, "version"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^ymmv-cli \S+\n\n$/); // one line + exactly one closing blank
    expect(res.stderr).toBe(""); // no latest hint leaks into a piped run
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

  // A reader that stops early (`ymmv <handle> | head -1`) closes the pipe, and the next write
  // fails with EPIPE: a Node stack trace and exit 1 when nothing listens for it (cli.ts). Only a raw
  // write crashes (console.log quietly swallows its own failed write and destroys the stream, so
  // the writes after it fail quietly too): the run has to print, lose its reader, then reach
  // cli.ts's closing blank. A miss with a file login does exactly that, with a request in the
  // middle: "not found" prints, then the viewer's own profile is read (the publish-yours nudge).
  // The server holds that reply until the test's reader has closed after its first chunk, so the
  // closing blank always meets a closed pipe. Closing after one line of a found profile instead
  // races the CLI's last write, and a run that wins the race passes without meeting one.
  // Off-Windows: the token file's path comes from HOME/XDG_CONFIG_HOME there.
  it.skipIf(process.platform === "win32")(
    "exits 0 with an empty stderr when the reader leaves after the first line",
    async () => {
      expect(existsSync(binPath), `build the CLI first — dist/cli.js missing at ${binPath}`).toBe(
        true,
      );
      let readerGone: () => void = () => {};
      const gone = new Promise<void>((done) => {
        readerGone = done;
      });
      const server: Server = createServer((req, res) => {
        if (req.url === "/api/v1/u/pipeuser") {
          void gone.then(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                schema_version: 1,
                handle: "pipeuser",
                entries: [{ key: "editor", value: "Helix" }],
                extras: [],
                updated_at: "2026-06-28T12:00:00.000Z",
              }),
            );
          });
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      try {
        const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const home = mkdtempSync(join(tmpdir(), "ymmv-pipe-"));
        const config = join(home, ".config");
        mkdirSync(join(config, "ymmv"), { recursive: true });
        // macOS keeps env-paths' config under ~/Library/Preferences; both point into `home`.
        mkdirSync(join(home, "Library", "Preferences", "ymmv"), { recursive: true });
        // A fixture login: never printed, and the test server ignores it.
        const login = JSON.stringify({ base: api, token: "t", handle: "pipeuser", github_id: 1 });
        for (const dir of [join(config, "ymmv"), join(home, "Library", "Preferences", "ymmv")]) {
          writeFileSync(join(dir, "token.json"), login, { mode: 0o600 });
        }
        const res = await new Promise<{ status: number | null; stderr: string; first: string }>(
          (done, fail) => {
            const child = spawn(process.execPath, [binPath, "ghost"], {
              env: { ...process.env, YMMV_API: api, HOME: home, XDG_CONFIG_HOME: config },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let first = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stdout.once("data", (chunk: string) => {
              first = chunk;
              child.stdout.destroy();
            });
            // Released once the read end is closed, so the CLI's next write meets a closed pipe.
            child.stdout.once("close", readerGone);
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk: string) => {
              stderr += chunk;
            });
            child.on("error", fail);
            child.on("close", (status) => done({ status, stderr, first }));
          },
        );
        expect(res.first).toContain("ghost"); // the reader got its line
        expect(res.stderr).toBe(""); // no stack trace, no "write EPIPE"
        expect(res.status).toBe(0);
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
  );
});
