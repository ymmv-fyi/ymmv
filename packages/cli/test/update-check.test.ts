import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUpdate, type SpawnedChild } from "../src/update.js";
import {
  detectInstallMethod,
  formatUpdateNotice,
  isNewer,
  npxInvocation,
  parseTriple,
  readCachedLatest,
  startUpdateCheck,
  type UpdateCheckDeps,
} from "../src/update-check.js";

// Everything here goes through the DI seams (fetch/now/env/cachePath/currentVersion/TTY/execPath
// on the check; spawn/execPath on runUpdate) — no vi.stubGlobal, no real network, no real clock,
// no real config dir. The suite-wide YMMV_NO_UPDATE_CHECK kill switch in setup-env never applies
// because every call passes its own `env`.

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ESC = String.fromCharCode(27);

let dir: string;
let cachePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ymmv-update-"));
  cachePath = join(dir, "update-check.json");
});

const okRes = (version: unknown): Response =>
  new Response(JSON.stringify({ version }), { status: 200 });

/** Plain-output deps: registered 0.8.0 build, TTY stderr, color off (NO_COLOR) so copy pins are
 *  byte-exact, npm-global bin path, isolated cache. Tests override what they exercise. */
function deps(overrides: Partial<UpdateCheckDeps> = {}): UpdateCheckDeps {
  return {
    env: { NO_COLOR: "1" },
    now: () => NOW,
    stderrIsTTY: true,
    currentVersion: "0.8.0",
    cachePath,
    binPath: "/usr/local/lib/node_modules/ymmv-cli/dist/cli.js",
    fetch: vi.fn(async () => okRes("0.9.0")),
    ...overrides,
  };
}

async function readCacheFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(cachePath, "utf8")) as Record<string, unknown>;
}

describe("parseTriple / isNewer", () => {
  it("accepts strict X.Y.Z and nothing else", () => {
    expect(parseTriple("0.9.0")).toEqual([0, 9, 0]);
    expect(parseTriple("10.2.33")).toEqual([10, 2, 33]);
    for (const bad of ["0.9", "0.9.0-beta.1", "0.0.0-dispatch.3", "v0.9.0", "0.9.0 ", "", "x"]) {
      expect(parseTriple(bad), bad).toBeNull();
    }
  });

  it("compares numerically, not lexically", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.1", "0.9.0")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.9.0", "0.9.0")).toBe(false);
    expect(isNewer("0.8.9", "0.9.0")).toBe(false);
    expect(isNewer("0.9.0-beta.1", "0.8.0")).toBe(false); // unparseable side ⇒ never newer
  });
});

describe("detectInstallMethod", () => {
  // Real-world layouts, win32 and POSIX. The contract under test: spawn-confidence only comes
  // from positive ANCHORED global evidence; runner caches are ephemeral; everything ambiguous is
  // unknown — a wrong `-global` verdict spawns an installer, so unknown is the safe verdict.
  it.each([
    // ephemeral runner caches
    [
      "C:\\Users\\b\\AppData\\Local\\npm-cache\\_npx\\a1b2\\node_modules\\ymmv-cli\\dist\\cli.js",
      "ephemeral",
    ],
    ["/home/u/.npm/_npx/a1b2/node_modules/ymmv-cli/dist/cli.js", "ephemeral"],
    ["/home/u/.cache/pnpm/dlx/a1b2/node_modules/ymmv-cli/dist/cli.js", "ephemeral"],
    ["/tmp/dlx-12345/node_modules/ymmv-cli/dist/cli.js", "ephemeral"],
    ["/tmp/bunx-501-ymmv-cli@latest/node_modules/ymmv-cli/dist/cli.js", "ephemeral"], // bunx temp
    ["/home/u/.bun/install/cache/ymmv-cli@0.8.0/dist/cli.js", "ephemeral"],
    // npm global layouts (anchored: known prefix root or version segment before lib/)
    ["/usr/local/lib/node_modules/ymmv-cli/dist/cli.js", "npm-global"],
    ["/usr/lib/node_modules/ymmv-cli/dist/cli.js", "npm-global"],
    ["/opt/homebrew/lib/node_modules/ymmv-cli/dist/cli.js", "npm-global"],
    ["/home/u/.nvm/versions/node/v22.17.0/lib/node_modules/ymmv-cli/dist/cli.js", "npm-global"],
    ["/home/u/.asdf/installs/nodejs/22.1.0/lib/node_modules/ymmv-cli/dist/cli.js", "npm-global"],
    ["C:\\Users\\Brian\\AppData\\Roaming\\npm\\node_modules\\ymmv-cli\\dist\\cli.js", "npm-global"],
    // pnpm global (pnpm's OWN global dir: adjacent pnpm/global)
    [
      "/home/u/.local/share/pnpm/global/5/.pnpm/ymmv-cli@0.8.0/node_modules/ymmv-cli/dist/cli.js",
      "pnpm-global",
    ],
    [
      "C:\\Users\\b\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\ymmv-cli@0.8.0\\node_modules\\ymmv-cli\\dist\\cli.js",
      "pnpm-global",
    ],
    // bun global (installed tree and the bin dir a failed realpath leaves you at)
    ["/home/u/.bun/install/global/node_modules/ymmv-cli/dist/cli.js", "bun-global"],
    ["/home/u/.bun/bin/ymmv", "bun-global"],
    // ambiguous ⇒ unknown, never a spawn (each of these previously — or plausibly — spawned)
    ["/repo/node_modules/ymmv-cli/dist/cli.js", "unknown"], // local install
    ["/home/u/projects/lib/node_modules/ymmv-cli/dist/cli.js", "unknown"], // project dir named lib/
    [
      "/home/u/global/proj/node_modules/.pnpm/ymmv-cli@0.8.0/node_modules/ymmv-cli/dist/cli.js",
      "unknown",
    ], // pnpm PROJECT with a stray `global` path segment
    [
      "/home/u/.volta/tools/image/packages/ymmv-cli/lib/node_modules/ymmv-cli/dist/cli.js",
      "unknown",
    ], // volta owns its installs — npm -g would fork behind its back
    ["/home/u/.config/yarn/global/node_modules/ymmv-cli/dist/cli.js", "unknown"], // yarn
    ["/opt/tools/ymmv", "unknown"], // packaged binary
  ] as const)("%s → %s", (path, expected) => {
    expect(detectInstallMethod(path)).toBe(expected);
  });

  it("matches whole segments, never substrings (hostile lookalikes stay correct)", () => {
    // A username containing "pnpm" must not turn an npm install into a pnpm spawn…
    expect(
      detectInstallMethod(
        "C:\\Users\\pnpm-fan\\AppData\\Roaming\\npm\\node_modules\\ymmv-cli\\dist\\cli.js",
      ),
    ).toBe("npm-global");
    // …and a project dir containing ".bun" as a substring is not bun.
    expect(detectInstallMethod("/home/u/projects/my.bunny/node_modules/ymmv-cli/dist/cli.js")).toBe(
      "unknown",
    );
  });

  it("no path at all → unknown", () => {
    expect(detectInstallMethod(undefined)).toBe("unknown");
  });
});

describe("formatUpdateNotice", () => {
  it("plain copy is byte-exact for a global install", () => {
    expect(formatUpdateNotice("0.8.0", "0.9.0", "npm-global", false)).toBe(
      "ymmv-cli 0.9.0 is out (you have 0.8.0) → run ymmv update",
    );
  });

  it("ephemeral installs get the EXACT npx pin, not @latest", () => {
    // npx's cache can serve a stale version even for `@latest` (npm/rfcs#700); an exact spec
    // always installs what it names.
    expect(formatUpdateNotice("0.8.0", "0.9.0", "ephemeral", false)).toBe(
      "ymmv-cli 0.9.0 is out (you have 0.8.0) → run npx ymmv-cli@0.9.0",
    );
  });

  it("equal or older latest → null", () => {
    expect(formatUpdateNotice("0.9.0", "0.9.0", "npm-global", false)).toBeNull();
    expect(formatUpdateNotice("0.9.0", "0.8.2", "npm-global", false)).toBeNull();
  });

  it("with color: the headline is an OSC-8 link to the releases LIST page", () => {
    const styled = formatUpdateNotice("0.8.0", "0.9.0", "npm-global", true);
    expect(styled).toContain(`${ESC}]8;;https://github.com/ymmv-fyi/ymmv/releases${ESC}\\`);
    expect(styled).toContain("ymmv-cli 0.9.0 is out");
    expect(styled).toContain(`${ESC}[93m`); // amber CTA
  });

  it("ANSI garbage posing as a version never reaches output", () => {
    expect(formatUpdateNotice("0.8.0", `${ESC}[2J9.9.9`, "npm-global", false)).toBeNull();
    expect(formatUpdateNotice(`${ESC}[2J`, "0.9.0", "npm-global", false)).toBeNull();
  });
});

describe("npxInvocation", () => {
  it("pins the exact version when known, @latest when not", () => {
    expect(npxInvocation("0.9.0")).toBe("npx ymmv-cli@0.9.0");
    expect(npxInvocation(null)).toBe("npx ymmv-cli@latest");
    expect(npxInvocation("0.9.0-beta.1")).toBe("npx ymmv-cli@latest"); // unparseable ⇒ safe form
  });
});

describe("startUpdateCheck gating (the fetch must never even fire)", () => {
  it.each([
    ["YMMV_NO_UPDATE_CHECK", { NO_COLOR: "1", YMMV_NO_UPDATE_CHECK: "1" }],
    ["NO_UPDATE_NOTIFIER", { NO_COLOR: "1", NO_UPDATE_NOTIFIER: "1" }],
    ["CI=true", { NO_COLOR: "1", CI: "true" }],
    ["CI=1", { NO_COLOR: "1", CI: "1" }],
  ] as const)("%s disables the check", async (_label, env) => {
    const fetchFn = vi.fn(async () => okRes("9.9.9"));
    const check = startUpdateCheck(deps({ env, fetch: fetchFn }));
    expect(await check.finish()).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("CI=false does NOT disable the check", async () => {
    const fetchFn = vi.fn(async () => okRes("0.9.0"));
    const check = startUpdateCheck(deps({ env: { NO_COLOR: "1", CI: "false" }, fetch: fetchFn }));
    expect(await check.finish()).toContain("0.9.0 is out");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["dev build 0.0.0", "0.0.0"],
    ["dispatch rehearsal", "0.0.0-dispatch.3"],
    ["unreadable package.json", null],
  ] as const)("%s skips (own version isn't a released triple)", async (_label, currentVersion) => {
    const fetchFn = vi.fn(async () => okRes("9.9.9"));
    const check = startUpdateCheck(deps({ currentVersion, fetch: fetchFn }));
    expect(await check.finish()).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("non-TTY stderr skips (pipes and CI logs never see the notice)", async () => {
    const fetchFn = vi.fn(async () => okRes("9.9.9"));
    const check = startUpdateCheck(deps({ stderrIsTTY: false, fetch: fetchFn }));
    expect(await check.finish()).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("empty-string opt-outs mean UNSET (the YMMV_* convention) — the check still runs", async () => {
    // Pins the truthiness-based gate: a refactor to presence-based checks ("key" in env) would
    // flip this documented convention and this test is the tripwire.
    const fetchFn = vi.fn(async () => okRes("0.9.0"));
    const check = startUpdateCheck(
      deps({
        env: { NO_COLOR: "1", YMMV_NO_UPDATE_CHECK: "", NO_UPDATE_NOTIFIER: "", CI: "" },
        fetch: fetchFn,
      }),
    );
    expect(await check.finish()).toContain("0.9.0 is out");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("startUpdateCheck fetch outcomes", () => {
  it("a newer registry version → the notice, and a fresh ok cache stamped latestAt", async () => {
    const check = startUpdateCheck(deps());
    expect(await check.finish()).toBe("ymmv-cli 0.9.0 is out (you have 0.8.0) → run ymmv update");
    expect(await readCacheFile()).toEqual({
      lastCheckedAt: NOW,
      ok: true,
      latest: "0.9.0",
      latestAt: NOW,
    });
  });

  it.each([
    ["equal version", async () => okRes("0.8.0")],
    ["older version", async () => okRes("0.7.9")],
  ] as const)("%s → null (no nag when current)", async (_label, fetchFn) => {
    const check = startUpdateCheck(deps({ fetch: vi.fn(fetchFn) }));
    expect(await check.finish()).toBeNull();
  });

  it.each([
    ["non-200", async () => new Response("nope", { status: 503 })],
    ["malformed JSON", async () => new Response("not json", { status: 200 })],
    ["version is not a string", async () => okRes(900)],
    ["prerelease latest", async () => okRes("1.0.0-beta.1")],
    [
      "thrown fetch (offline)",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ] as const)("%s → silent null, recorded as a failed check", async (_label, fetchFn) => {
    const check = startUpdateCheck(deps({ fetch: vi.fn(fetchFn) }));
    expect(await check.finish()).toBeNull();
    expect(await readCacheFile()).toMatchObject({ lastCheckedAt: NOW, ok: false });
  });

  it("an instantly-rejecting fetch never becomes an unhandledRejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const check = startUpdateCheck(
        deps({ fetch: vi.fn(async () => Promise.reject(new Error("boom"))) }),
      );
      // Give the rejection a macrotask to surface before finish() is ever awaited.
      await new Promise((r) => setTimeout(r, 0));
      expect(await check.finish()).toBeNull();
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });
});

describe("startUpdateCheck cache behavior", () => {
  it("a fresh ok cache answers without fetching", async () => {
    await writeFile(
      cachePath,
      JSON.stringify({ lastCheckedAt: NOW - 23 * HOUR, ok: true, latest: "0.9.0" }),
    );
    const fetchFn = vi.fn(async () => okRes("9.9.9"));
    const check = startUpdateCheck(deps({ fetch: fetchFn }));
    expect(await check.finish()).toContain("0.9.0 is out");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a stale ok cache (>24h) refetches and rewrites", async () => {
    await writeFile(
      cachePath,
      JSON.stringify({ lastCheckedAt: NOW - 25 * HOUR, ok: true, latest: "0.8.5" }),
    );
    const fetchFn = vi.fn(async () => okRes("0.9.0"));
    const check = startUpdateCheck(deps({ fetch: fetchFn }));
    expect(await check.finish()).toContain("0.9.0 is out");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await readCacheFile()).toEqual({
      lastCheckedAt: NOW,
      ok: true,
      latest: "0.9.0",
      latestAt: NOW,
    });
  });

  it("a failed check within its 6h window is NOT retried (offline machines don't pay per run)", async () => {
    await writeFile(
      cachePath,
      JSON.stringify({ lastCheckedAt: NOW - 5 * HOUR, ok: false, latest: "0.9.0" }),
    );
    const fetchFn = vi.fn(async () => okRes("9.9.9"));
    const check = startUpdateCheck(deps({ fetch: fetchFn }));
    // The preserved latest from the last SUCCESSFUL fetch still notices while offline.
    expect(await check.finish()).toContain("0.9.0 is out");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a failed check past 6h retries", async () => {
    await writeFile(cachePath, JSON.stringify({ lastCheckedAt: NOW - 7 * HOUR, ok: false }));
    const fetchFn = vi.fn(async () => okRes("0.9.0"));
    const check = startUpdateCheck(deps({ fetch: fetchFn }));
    expect(await check.finish()).toContain("0.9.0 is out");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a failed refetch preserves the known latest AND its original fetch stamp", async () => {
    await writeFile(
      cachePath,
      JSON.stringify({
        lastCheckedAt: NOW - 25 * HOUR,
        ok: true,
        latest: "0.9.0",
        latestAt: NOW - 25 * HOUR,
      }),
    );
    const check = startUpdateCheck(
      deps({
        fetch: vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      }),
    );
    expect(await check.finish()).toContain("0.9.0 is out"); // stale-but-known still notices
    // lastCheckedAt re-stamps (the 6h retry clock) but latestAt does NOT — a failure must never
    // refresh the fact-freshness window `ymmv version` and the exact pin rely on.
    expect(await readCacheFile()).toEqual({
      lastCheckedAt: NOW,
      ok: false,
      latest: "0.9.0",
      latestAt: NOW - 25 * HOUR,
    });
  });

  it("a corrupt cache file reads as absent", async () => {
    await writeFile(cachePath, "{ definitely not json");
    const fetchFn = vi.fn(async () => okRes("0.9.0"));
    const check = startUpdateCheck(deps({ fetch: fetchFn }));
    expect(await check.finish()).toContain("0.9.0 is out");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a FUTURE lastCheckedAt (poisoned/skewed clock)",
      JSON.stringify({ lastCheckedAt: NOW + 5 * DAY, ok: true }),
    ],
    // Raw JSON on purpose: JSON.parse("1e999") yields Infinity at read time, which a stringified
    // object literal can't express (and a literal 1e999 in source trips noPrecisionLoss).
    ["a non-finite lastCheckedAt", '{"lastCheckedAt":1e999,"ok":true}'],
  ] as const)("%s reads as absent (never permanently fresh)", async (_label, cache) => {
    await writeFile(cachePath, cache);
    const fetchFn = vi.fn(async () => okRes("0.9.0"));
    const check = startUpdateCheck(deps({ fetch: fetchFn }));
    expect(await check.finish()).toContain("0.9.0 is out");
    expect(fetchFn).toHaveBeenCalledTimes(1); // the poisoned entry could not suppress the fetch
  });

  it("an unwritable cache location still returns the notice (write is best-effort)", async () => {
    // The cache path's PARENT is a file, so mkdir/write must fail — and be swallowed.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "i am a file");
    const check = startUpdateCheck(deps({ cachePath: join(blocker, "update-check.json") }));
    expect(await check.finish()).toContain("0.9.0 is out");
  });
});

describe("startUpdateCheck grace/abort", () => {
  it("a never-settling fetch resolves finish() null promptly and aborts the signal", async () => {
    vi.useFakeTimers();
    try {
      let captured: AbortSignal | undefined;
      // The check's first await is a REAL fs read (readCache) that fake timers cannot advance —
      // on a slow runner the fake 500ms grace can fire before the fetch was ever invoked,
      // leaving `captured` undefined (flaked on CI verify(22) at bb823c0). Gate the timer
      // advance on the fetch actually starting: fs completion is a real libuv event, so this
      // await resolves regardless of the fake clock.
      let fetchStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        fetchStarted = resolve;
      });
      const check = startUpdateCheck(
        deps({
          fetch: vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
            captured = init?.signal ?? undefined;
            fetchStarted();
            return new Promise<Response>(() => {}); // hangs forever
          }) as unknown as typeof globalThis.fetch,
        }),
      );
      await started; // fetch is now in flight, holding the pending promise
      const finished = check.finish();
      await vi.advanceTimersByTimeAsync(600); // past the 500ms grace
      expect(await finished).toBeNull();
      expect(captured?.aborted).toBe(true); // the pending socket must not hold the process open
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readCachedLatest (the `ymmv version` hint / exact-pin source)", () => {
  it("fresh latestAt → the latest; stale (>7d) → null; absent → null", async () => {
    await writeFile(
      cachePath,
      JSON.stringify({
        lastCheckedAt: NOW - 6 * DAY,
        ok: true,
        latest: "0.9.0",
        latestAt: NOW - 6 * DAY,
      }),
    );
    expect(await readCachedLatest({ now: () => NOW, cachePath })).toBe("0.9.0");
    await writeFile(
      cachePath,
      JSON.stringify({
        lastCheckedAt: NOW - 8 * DAY,
        ok: true,
        latest: "0.9.0",
        latestAt: NOW - 8 * DAY,
      }),
    );
    expect(await readCachedLatest({ now: () => NOW, cachePath })).toBeNull();
    expect(
      await readCachedLatest({ now: () => NOW, cachePath: join(dir, "nope.json") }),
    ).toBeNull();
  });

  it("freshness follows the SUCCESSFUL fetch, not the latest failed attempt", async () => {
    // A long-offline machine keeps re-stamping lastCheckedAt on failed checks while carrying an
    // old `latest` forward — that must never launder a months-old version into a current fact.
    await writeFile(
      cachePath,
      JSON.stringify({
        lastCheckedAt: NOW - 1 * HOUR, // fresh ATTEMPT (a failure an hour ago)
        ok: false,
        latest: "0.9.0",
        latestAt: NOW - 8 * DAY, // the value itself is 8 days old
      }),
    );
    expect(await readCachedLatest({ now: () => NOW, cachePath })).toBeNull();
  });

  it("a legacy cache without latestAt never qualifies as a stated fact", async () => {
    await writeFile(cachePath, JSON.stringify({ lastCheckedAt: NOW, ok: true, latest: "0.9.0" }));
    expect(await readCachedLatest({ now: () => NOW, cachePath })).toBeNull();
  });

  it("garbage latest in the cache never comes back", async () => {
    await writeFile(
      cachePath,
      JSON.stringify({ lastCheckedAt: NOW, ok: true, latest: `${ESC}[2J9.9.9`, latestAt: NOW }),
    );
    expect(await readCachedLatest({ now: () => NOW, cachePath })).toBeNull();
  });
});

// ── ymmv update ──────────────────────────────────────────────────────────────────────────────

/** Minimal fake child: records nothing, lets the test fire error/exit. */
class FakeChild implements SpawnedChild {
  private listeners = new Map<string, (arg: never) => void>();
  on(event: "error" | "exit", listener: (arg: never) => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  emit(event: "error" | "exit", arg: unknown): void {
    this.listeners.get(event)?.(arg as never);
  }
}

describe("runUpdate", () => {
  const NPM_PATH = "/usr/local/lib/node_modules/ymmv-cli/dist/cli.js";
  let logs: string[];
  let errs: string[];
  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.join(" "));
    });
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const SPAWN_OPTS = { stdio: "inherit", shell: true, cwd: homedir() } as const;
  const NPX_PATH = "/home/u/.npm/_npx/a1b2/node_modules/ymmv-cli/dist/cli.js";

  it.each([
    ["/usr/local/lib/node_modules/ymmv-cli/dist/cli.js", "npm i -g ymmv-cli@latest"],
    [
      "/home/u/.local/share/pnpm/global/5/.pnpm/ymmv-cli@0.8.0/node_modules/ymmv-cli/dist/cli.js",
      "pnpm add -g ymmv-cli@latest",
    ],
    ["/home/u/.bun/install/global/node_modules/ymmv-cli/dist/cli.js", "bun add -g ymmv-cli@latest"],
  ] as const)("spawns the matching upgrade for %s", async (binPath, expected) => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const run = runUpdate({ spawn, binPath });
    child.emit("exit", 0);
    await run;
    // cwd is pinned to the home dir: cmd.exe resolves bare names from the CURRENT directory
    // first (CWE-427), so spawning from an untrusted checkout could execute a planted npm.cmd.
    expect(spawn).toHaveBeenCalledWith(expected, SPAWN_OPTS);
    expect(process.exitCode).toBeUndefined();
  });

  // Symlink semantics differ on Windows (npm uses a .cmd shim, no symlink), so the POSIX
  // npm-global shape — bin symlink → lib/node_modules target — is reproduced off-Windows only.
  it.skipIf(process.platform === "win32")(
    "the DEFAULT bin path resolves through realpath (symlinked npm bin spawns npm)",
    async () => {
      // Three independent reviewers converged on this one: argv[1] keeps the SYMLINK path, so
      // without realpath the notice (which realpaths) says "run ymmv update" while update itself
      // would shrug with the manual fallback.
      const target = join(dir, "usr", "local", "lib", "node_modules", "ymmv-cli", "dist", "cli.js");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "");
      const bin = join(dir, "usr", "local", "bin", "ymmv");
      mkdirSync(dirname(bin), { recursive: true });
      symlinkSync(target, bin);
      const argv1 = process.argv[1];
      process.argv[1] = bin;
      try {
        const child = new FakeChild();
        const spawn = vi.fn(() => child);
        const run = runUpdate({ spawn }); // NO binPath: exercise the default resolution
        await Promise.resolve(); // let the sync prelude reach the spawn
        child.emit("exit", 0);
        await run;
        expect(spawn).toHaveBeenCalledWith("npm i -g ymmv-cli@latest", SPAWN_OPTS);
      } finally {
        process.argv[1] = argv1;
      }
    },
  );

  it("passes a nonzero package-manager exit straight through", async () => {
    const child = new FakeChild();
    const run = runUpdate({ spawn: () => child, binPath: NPM_PATH });
    child.emit("exit", 3);
    await run;
    expect(process.exitCode).toBe(3);
    expect(errs).toEqual([]); // the pm already explained itself on inherited stdio
  });

  it.each([
    ["POSIX sh not-found", 127],
    ["cmd.exe not-found", 9009],
  ] as const)("%s exit code gets the manual fallback, exit 1", async (_label, code) => {
    const child = new FakeChild();
    const run = runUpdate({ spawn: () => child, binPath: NPM_PATH });
    child.emit("exit", code);
    await run;
    expect(process.exitCode).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain("Couldn't run `npm i -g ymmv-cli@latest`");
    expect(out).toContain("pnpm add -g ymmv-cli@latest"); // all three manual commands offered
  });

  it("a spawn error event gets the manual fallback, exit 1, never a stack trace", async () => {
    const child = new FakeChild();
    const run = runUpdate({ spawn: () => child, binPath: NPM_PATH });
    child.emit("error", new Error("EACCES"));
    await run;
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("Couldn't run");
  });

  it("a synchronously-throwing spawn gets the same fallback", async () => {
    await runUpdate({
      spawn: () => {
        throw new Error("spawn EPERM");
      },
      binPath: NPM_PATH,
    });
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("Couldn't run");
  });

  it("ephemeral runs print the exact pin from a fresh NEWER cache, no spawn", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ lastCheckedAt: NOW, ok: true, latest: "0.9.0", latestAt: NOW }),
    );
    const spawn = vi.fn();
    await runUpdate({
      spawn,
      binPath: NPX_PATH,
      now: () => NOW,
      cachePath,
      currentVersion: "0.8.0",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("npx ymmv-cli@0.9.0");
    expect(process.exitCode).toBeUndefined();
  });

  it("ephemeral NEVER pins a downgrade: cache ≤ running version falls back to @latest", async () => {
    // Right after a release the shared cache can lag the version the user is already running
    // (fresh 24h TTL) — pinning it would instruct a downgrade.
    writeFileSync(
      cachePath,
      JSON.stringify({ lastCheckedAt: NOW, ok: true, latest: "0.8.0", latestAt: NOW }),
    );
    const spawn = vi.fn();
    await runUpdate({
      spawn,
      binPath: NPX_PATH,
      now: () => NOW,
      cachePath,
      currentVersion: "0.9.0",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("npx ymmv-cli@latest");
    expect(logs.join("\n")).not.toContain("npx ymmv-cli@0.8.0");
  });

  it("ephemeral with a cold cache falls back to @latest", async () => {
    const spawn = vi.fn();
    await runUpdate({
      spawn,
      binPath: NPX_PATH,
      now: () => NOW,
      cachePath: join(dir, "absent.json"),
      currentVersion: "0.8.0",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("npx ymmv-cli@latest");
  });

  it("unknown installs get all three manual commands and exit 0 (doubt never spawns)", async () => {
    const spawn = vi.fn();
    await runUpdate({ spawn, binPath: "/opt/tools/ymmv" });
    expect(spawn).not.toHaveBeenCalled();
    const out = logs.join("\n");
    expect(out).toContain("npm i -g ymmv-cli@latest");
    expect(out).toContain("pnpm add -g ymmv-cli@latest");
    expect(out).toContain("bun add -g ymmv-cli@latest");
    expect(process.exitCode).toBeUndefined();
  });
});
