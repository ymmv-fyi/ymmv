import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
// on the check; spawn/where/execPath on runUpdate) — no vi.stubGlobal, no real network, no real clock,
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

  // pnpm 11 (and 12.16): the shim runs a path in pnpm's global dir, whose `<hash>` links into the
  // store. Both halves are evidence; either one alone is not.
  const P11_RAW = "/home/u/.local/share/pnpm/global/v11/575c/node_modules/ymmv-cli/dist/cli.js";
  const P11_REAL =
    "/home/u/.local/share/pnpm/store/v11/links/@/ymmv-cli/0.15.1/3bd1/node_modules/ymmv-cli/dist/cli.js";
  it.each([
    { label: "pnpm 11 global", raw: P11_RAW, real: P11_REAL, expected: "pnpm-global" },
    {
      label: "pnpm 11 global on Windows",
      raw: "C:\\Users\\b\\AppData\\Local\\pnpm\\global\\v11\\575c\\node_modules\\ymmv-cli\\dist\\cli.js",
      real: "C:\\Users\\b\\AppData\\Local\\pnpm\\store\\v11\\links\\@\\ymmv-cli\\0.15.1\\3bd1\\node_modules\\ymmv-cli\\dist\\cli.js",
      expected: "pnpm-global",
    },
    // a project that installs through pnpm's global virtual store: store realpath, no global dir
    {
      label: "store realpath from a project",
      raw: "/repo/node_modules/ymmv-cli/dist/cli.js",
      real: P11_REAL,
      expected: "unknown",
    },
    // the store realpath alone (what the classifier saw before the raw path was passed)
    { label: "store realpath alone", raw: P11_REAL, real: P11_REAL, expected: "unknown" },
    // a raw path in the global dir keeps today's verdict for whatever its realpath is
    {
      label: "global dir raw path, realpath not resolved",
      raw: P11_RAW,
      real: P11_RAW,
      expected: "pnpm-global",
    },
    {
      label: "global dir raw path, npm realpath",
      raw: P11_RAW,
      real: "/usr/local/lib/node_modules/ymmv-cli/dist/cli.js",
      expected: "npm-global",
    },
    {
      label: "global dir raw path, realpath somewhere unrelated",
      raw: P11_RAW,
      real: "/opt/tools/ymmv-cli/dist/cli.js",
      expected: "unknown",
    },
    // the raw path must sit in pnpm's own global dir, ymmv-cli directly under global/v<N>/<hash>
    {
      label: "store realpath, raw path not in pnpm's global dir",
      raw: "/home/u/global/v11/575c/node_modules/ymmv-cli/dist/cli.js",
      real: P11_REAL,
      expected: "unknown",
    },
    {
      label: "store realpath, raw path nested deeper in the global dir",
      raw: "/home/u/.local/share/pnpm/global/v11/575c/x/node_modules/ymmv-cli/dist/cli.js",
      real: P11_REAL,
      expected: "unknown",
    },
    {
      label: "global dir raw path, realpath in a store without links",
      raw: P11_RAW,
      real: "/home/u/.local/share/pnpm/store/v11/files/ab/node_modules/ymmv-cli/dist/cli.js",
      expected: "unknown",
    },
  ] as const)("$label → $expected", ({ raw, real, expected }) => {
    expect(detectInstallMethod({ raw, real })).toBe(expected);
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
  /** What `npm root -g` prints for the prefix NPM_PATH lives in. */
  const NPM_ROOT = "/usr/local/lib/node_modules\n";

  /** runUpdate with the post-install pnpm lookup made hermetic: a cold cache, so the lookup never
   *  runs, and a lookup that rejects in case one does. Tests of the lookup override both. */
  const run = (d: Parameters<typeof runUpdate>[0] = {}) =>
    runUpdate({
      cachePath: join(dir, "absent.json"),
      list: vi.fn(async () => {
        throw new Error("unexpected pnpm list");
      }),
      ...d,
    });

  /** The package manager's answer to "where do your global installs live". */
  const where = (stdout: string) => vi.fn(async () => stdout);
  /** A spawn whose child fires `event` once runUpdate has attached its listeners. The spawn now
   *  happens after an awaited lookup, so a test can no longer emit right after calling. */
  const spawnThat = (event: "error" | "exit", arg: unknown) =>
    vi.fn(() => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit(event, arg));
      return child;
    });

  // Real layouts: what each manager prints, and where the copy it installed really lives.
  it.each([
    [
      "npm",
      "/usr/local/lib/node_modules/ymmv-cli/dist/cli.js",
      "npm root -g",
      "/usr/local/lib/node_modules",
      "npm i -g ymmv-cli@latest",
    ],
    [
      // The real package is a SIBLING of the printed node_modules, not inside it.
      "pnpm 9 and 10",
      "/home/u/.local/share/pnpm/global/5/.pnpm/ymmv-cli@0.8.0/node_modules/ymmv-cli/dist/cli.js",
      "pnpm root -g",
      "/home/u/.local/share/pnpm/global/5/node_modules",
      "pnpm add -g ymmv-cli@latest",
    ],
    [
      // No node_modules in what 12 prints; the install dir under it is a hash.
      "pnpm 12",
      "/home/u/.local/share/pnpm/global/v11/24a8-18da/node_modules/.pnpm/ymmv-cli@0.8.0/node_modules/ymmv-cli/dist/cli.js",
      "pnpm root -g",
      "/home/u/.local/share/pnpm/global/v11",
      "pnpm add -g ymmv-cli@latest",
    ],
    [
      "bun",
      "/home/u/.bun/install/global/node_modules/ymmv-cli/dist/cli.js",
      "bun pm bin -g",
      "/home/u/.bun/bin",
      "bun add -g ymmv-cli@latest",
    ],
  ] as const)(
    "%s: spawns the upgrade when the manager on PATH owns the running copy",
    async (_label, binPath, lookup, printed, expected) => {
      const spawn = spawnThat("exit", 0);
      const whereFn = where(`${printed}\n`);
      await run({ spawn, where: whereFn, binPath });
      // cwd is pinned to the home dir: cmd.exe resolves bare names from the CURRENT directory
      // first (CWE-427), so spawning from an untrusted checkout could execute a planted npm.cmd.
      // The lookup runs the same manager, so it gets the same shell and cwd, plus a timeout.
      expect(whereFn).toHaveBeenCalledWith(lookup, {
        shell: true,
        cwd: homedir(),
        timeout: expect.any(Number),
      });
      expect(spawn).toHaveBeenCalledWith(expected, SPAWN_OPTS);
      expect(errs).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each([
    [
      "npm",
      "/usr/local/lib/node_modules/ymmv-cli/dist/cli.js",
      "/home/u/.nvm/versions/node/v22.1.0/lib/node_modules",
      "This ymmv runs from /usr/local/lib/node_modules/ymmv-cli, but `npm i -g ymmv-cli@latest` installs under /home/u/.nvm/versions/node/v22.1.0/lib/node_modules.",
      "Run the update with the npm that installed this copy.",
    ],
    [
      "pnpm",
      "/home/u/.local/share/pnpm/global/5/.pnpm/ymmv-cli@0.8.0/node_modules/ymmv-cli/dist/cli.js",
      "/opt/pnpm/global/v11",
      "but `pnpm add -g ymmv-cli@latest` installs under /opt/pnpm/global/v11.",
      "Run the update with the pnpm that installed this copy.",
    ],
    [
      // pnpm 11's copy is named by the global dir it runs from, not by its store path.
      "pnpm 11",
      {
        raw: "/home/u/.local/share/pnpm/global/v11/575c/node_modules/ymmv-cli/dist/cli.js",
        real: "/home/u/.local/share/pnpm/store/v11/links/@/ymmv-cli/0.15.1/3bd1/node_modules/ymmv-cli/dist/cli.js",
      },
      "/opt/pnpm/global/v11",
      "This ymmv runs from /home/u/.local/share/pnpm/global/v11/575c/node_modules/ymmv-cli, but `pnpm add -g ymmv-cli@latest` installs under /opt/pnpm/global/v11.",
      "Run the update with the pnpm that installed this copy.",
    ],
    [
      "bun",
      "/home/u/.bun/install/global/node_modules/ymmv-cli/dist/cli.js",
      "/opt/.bun/bin",
      "but `bun add -g ymmv-cli@latest` installs under /opt/.bun.",
      "Run the update with the bun that installed this copy.",
    ],
    [
      // The case the bug was filed from: WSL runs the Windows npm's copy, finds the Linux npm.
      "WSL running the Windows install",
      "/mnt/c/Users/u/AppData/Roaming/npm/node_modules/ymmv-cli/dist/cli.js",
      "/home/u/.nvm/versions/node/v22.1.0/lib/node_modules",
      "This ymmv runs from /mnt/c/Users/u/AppData/Roaming/npm/node_modules/ymmv-cli, but",
      "This copy is a Windows install, so run `ymmv update` from Windows.",
    ],
  ] as const)(
    "%s: a manager that doesn't own the running copy is refused, nothing spawns",
    async (_label, binPath, printed, first, second) => {
      const spawn = vi.fn();
      await run({ spawn, where: where(`${printed}\n`), binPath });
      expect(spawn).not.toHaveBeenCalled();
      expect(logs).toEqual([]); // never claims to be "running" anything
      const lines = errs.join("\n").split("\n");
      expect(lines[1]).toContain(first);
      expect(lines[2]).toBe(`  ${second}`);
      expect(lines).toHaveLength(3);
      expect(process.exitCode).toBe(1);
    },
  );

  it.each([
    ["rejects (missing manager, nonzero exit, timeout)", () => Promise.reject(new Error("x"))],
    [
      "throws synchronously",
      () => {
        throw new Error("spawn EPERM");
      },
    ],
    ["prints nothing", async () => ""],
    ["prints a relative path", async () => "lib/node_modules\n"],
    ["prints two paths", async () => "/usr/local/lib/node_modules\n/opt/x\n"],
  ] as const)("a lookup that %s gets the manual commands, nothing spawns", async (_label, fn) => {
    const spawn = vi.fn();
    await run({ spawn, where: fn, binPath: NPM_PATH });
    expect(spawn).not.toHaveBeenCalled();
    const out = errs.join("\n");
    expect(out).toContain("Couldn't check where `npm i -g ymmv-cli@latest` would install.");
    expect(out).toContain("pnpm add -g ymmv-cli@latest");
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["CRLF from a Windows shell", "/usr/local/lib/node_modules\r\n"],
    ["a trailing separator", "/usr/local/lib/node_modules/\n"],
    ["a notice around the path", "\nnpm notice new version\n/usr/local/lib/node_modules\n\n"],
  ] as const)("the lookup's path line survives %s", async (_label, stdout) => {
    const spawn = spawnThat("exit", 0);
    await run({ spawn, where: where(stdout), binPath: NPM_PATH });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("a segment npm redacted to *** matches the running copy's segment there", async () => {
    // npm prints a UUID-shaped directory name as `***`. Without this a prefix under one is
    // refused although it owns the copy.
    const binPath =
      "/srv/3f2b8c1e-0d4a-4b6f-9a7e-2c5d8e1f0a3b/node/lib/node_modules/ymmv-cli/dist/cli.js";
    const spawn = spawnThat("exit", 0);
    await run({ spawn, where: where("/srv/***/node/lib/node_modules\n"), binPath });
    expect(spawn).toHaveBeenCalledTimes(1);

    const refused = vi.fn();
    await run({
      spawn: refused,
      where: where("/srv/***/other/lib/node_modules\n"),
      binPath,
    });
    expect(refused).not.toHaveBeenCalled();
  });

  it("Windows paths that differ only by case and separators are the same place", async () => {
    const spawn = spawnThat("exit", 0);
    await run({
      spawn,
      where: where("c:/users/U/AppData/Roaming/npm/node_modules\r\n"),
      binPath: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ymmv-cli\\dist\\cli.js",
    });
    expect(spawn).toHaveBeenCalledWith("npm i -g ymmv-cli@latest", SPAWN_OPTS);
    expect(errs).toEqual([]);
  });

  it("POSIX paths that differ by case are different places", async () => {
    const spawn = vi.fn();
    await run({ spawn, where: where("/usr/LOCAL/lib/node_modules\n"), binPath: NPM_PATH });
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("a Windows mismatch names both locations in their own form", async () => {
    const spawn = vi.fn();
    await run({
      spawn,
      where: where("D:\\nodes\\npm\\node_modules\r\n"),
      binPath: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ymmv-cli\\dist\\cli.js",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain(
      "This ymmv runs from C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ymmv-cli, but `npm i -g ymmv-cli@latest` installs under D:\\nodes\\npm\\node_modules.",
    );
  });

  it("the refusal strips control bytes from both paths", async () => {
    // Paths are printed, and a directory name can hold anything.
    const spawn = vi.fn();
    await run({
      spawn,
      where: where(`/opt/${ESC}[31mnode/lib/node_modules\n`),
      binPath: `/home/${ESC}[2Ju/node/lib/node_modules/ymmv-cli/dist/cli.js`,
    });
    expect(spawn).not.toHaveBeenCalled();
    const out = errs.join("\n");
    expect(out).not.toContain(ESC);
    expect(out).toContain("/home/u/node/lib/node_modules/ymmv-cli");
    expect(out).toContain("/opt/node/lib/node_modules");
  });

  // Symlinks need a real tree; Windows has neither these shapes nor unprivileged symlinks.
  describe.skipIf(process.platform === "win32")("on a real tree", () => {
    /** An npm prefix at `<dir>/<name>/node` with ymmv-cli in it; returns the bin script. */
    const npmInstall = (name: string): string => {
      const bin = join(dir, name, "node", "lib", "node_modules", "ymmv-cli", "dist", "cli.js");
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, "");
      return bin;
    };

    it("a prefix that is itself a symlink still owns the copy behind it", async () => {
      // Homebrew and nvm's `current` hand npm a symlinked prefix; the running bin is a realpath.
      const binPath = realpathSync(npmInstall("real"));
      symlinkSync(join(dir, "real"), join(dir, "current"));
      const spawn = spawnThat("exit", 0);
      await run({
        spawn,
        where: where(`${join(dir, "current", "node", "lib", "node_modules")}\n`),
        binPath,
      });
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("bun with its bin dir moved: the `ymmv` link there names the running copy", async () => {
      const binPath = join(dir, ".bun", "install", "global", "node_modules", "ymmv-cli", "cli.js");
      mkdirSync(dirname(binPath), { recursive: true });
      writeFileSync(binPath, "");
      mkdirSync(join(dir, "elsewhere", "bin"), { recursive: true });
      symlinkSync(binPath, join(dir, "elsewhere", "bin", "ymmv"));
      const spawn = spawnThat("exit", 0);
      await run({
        spawn,
        where: where(`${join(dir, "elsewhere", "bin")}\n`),
        binPath: realpathSync(binPath),
      });
      expect(spawn).toHaveBeenCalledWith("bun add -g ymmv-cli@latest", SPAWN_OPTS);
    });

    /** pnpm 11's layout under `<dir>/<home>`: the package in the store (`<dir>/<store>/store`),
     *  a hash-named link in the global dir pointing at the install dir that links the package.
     *  Returns the path the shim runs (what Node puts in argv[1]). */
    const pnpm11Install = (home: string, store = home): string => {
      const pkg = join(dir, store, "store", "v11", "links", "@", "ymmv-cli", "0.15.1", "3bd1");
      const pkgDir = join(pkg, "node_modules", "ymmv-cli");
      mkdirSync(join(pkgDir, "dist"), { recursive: true });
      writeFileSync(join(pkgDir, "dist", "cli.js"), "");
      const installDir = join(dir, home, "global", "v11", "2bbbf8-1a19");
      mkdirSync(join(installDir, "node_modules"), { recursive: true });
      symlinkSync(pkgDir, join(installDir, "node_modules", "ymmv-cli"));
      symlinkSync(installDir, join(dir, home, "global", "v11", "575c"));
      return join(dir, home, "global", "v11", "575c", "node_modules", "ymmv-cli", "dist", "cli.js");
    };
    const pnpm11Bin = (raw: string) => ({ raw, real: realpathSync(raw) });

    it("pnpm 11: pnpm prints the global dir the running copy runs from, so it spawns", async () => {
      const raw = pnpm11Install("pnpm");
      const spawn = spawnThat("exit", 0);
      await run({
        spawn,
        where: where(`${join(dir, "pnpm", "global", "v11")}\n`),
        binPath: pnpm11Bin(raw),
      });
      expect(spawn).toHaveBeenCalledWith("pnpm add -g ymmv-cli@latest", SPAWN_OPTS);
      expect(errs).toEqual([]);
    });

    it("pnpm 11: another global dir is refused", async () => {
      const raw = pnpm11Install("pnpm");
      const spawn = vi.fn();
      const other = join(dir, "other", "pnpm", "global", "v11");
      await run({ spawn, where: where(`${other}\n`), binPath: pnpm11Bin(raw) });
      expect(spawn).not.toHaveBeenCalled();
      expect(errs.join("\n")).toContain(
        `This ymmv runs from ${dirname(dirname(raw))}, but \`pnpm add -g ymmv-cli@latest\` installs under ${other}.`,
      );
      expect(process.exitCode).toBe(1);
    });

    it.each([
      ["its own store", join("second", "pnpm")],
      // Both homes' links then end at the very same file, so only the global dir tells them apart.
      ["the same store", "pnpm"],
    ] as const)(
      "pnpm 11: another PNPM_HOME with the same version in %s is refused",
      async (_label, store) => {
        const raw = pnpm11Install("pnpm");
        pnpm11Install(join("second", "pnpm"), store);
        const spawn = vi.fn();
        await run({
          spawn,
          where: where(`${join(dir, "second", "pnpm", "global", "v11")}\n`),
          binPath: pnpm11Bin(raw),
        });
        expect(spawn).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      },
    );

    it.each([
      ["the running path goes through it", "alias", "data"],
      ["pnpm prints the path through it", "data", "alias"],
    ] as const)(
      "pnpm 11: a PNPM_HOME behind a symlink still owns the copy (%s)",
      async (_label, runVia, printVia) => {
        pnpm11Install(join("data", "pnpm"));
        mkdirSync(join(dir, "alias"));
        symlinkSync(join(dir, "data", "pnpm"), join(dir, "alias", "pnpm"));
        const raw = join(dir, runVia, "pnpm", "global", "v11", "575c", "node_modules", "ymmv-cli");
        const spawn = spawnThat("exit", 0);
        await run({
          spawn,
          where: where(`${join(dir, printVia, "pnpm", "global", "v11")}\n`),
          binPath: pnpm11Bin(join(raw, "dist", "cli.js")),
        });
        expect(spawn).toHaveBeenCalledTimes(1);
      },
    );

    it("pnpm 11: the DEFAULT bin paths keep argv[1] unresolved for the classifier", async () => {
      const raw = pnpm11Install("pnpm");
      const argv1 = process.argv[1];
      process.argv[1] = raw;
      try {
        const spawn = spawnThat("exit", 0);
        // NO binPath: exercise the default resolution
        await run({ spawn, where: where(`${join(dir, "pnpm", "global", "v11")}\n`) });
        expect(spawn).toHaveBeenCalledWith("pnpm add -g ymmv-cli@latest", SPAWN_OPTS);
      } finally {
        process.argv[1] = argv1;
      }
    });

    it("bun with its bin dir moved and no link to the running copy is refused", async () => {
      mkdirSync(join(dir, "elsewhere", "bin"), { recursive: true });
      const spawn = vi.fn();
      await run({
        spawn,
        where: where(`${join(dir, "elsewhere", "bin")}\n`),
        binPath: "/home/u/.bun/install/global/node_modules/ymmv-cli/dist/cli.js",
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
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
        const spawn = spawnThat("exit", 0);
        // NO binPath: exercise the default resolution
        await run({ spawn, where: where(`${dirname(dirname(dirname(target)))}\n`) });
        expect(spawn).toHaveBeenCalledWith("npm i -g ymmv-cli@latest", SPAWN_OPTS);
      } finally {
        process.argv[1] = argv1;
      }
    },
  );

  it("passes a nonzero package-manager exit straight through", async () => {
    await run({ spawn: spawnThat("exit", 3), where: where(NPM_ROOT), binPath: NPM_PATH });
    expect(process.exitCode).toBe(3);
    expect(errs).toEqual([]); // the pm already explained itself on inherited stdio
  });

  it.each([
    ["POSIX sh not-found", 127],
    ["cmd.exe not-found", 9009],
  ] as const)("%s exit code gets the manual fallback, exit 1", async (_label, code) => {
    await run({ spawn: spawnThat("exit", code), where: where(NPM_ROOT), binPath: NPM_PATH });
    expect(process.exitCode).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain("Couldn't run `npm i -g ymmv-cli@latest`");
    expect(out).toContain("pnpm add -g ymmv-cli@latest"); // all three manual commands offered
  });

  it("a spawn error event gets the manual fallback, exit 1, never a stack trace", async () => {
    await run({
      spawn: spawnThat("error", new Error("EACCES")),
      where: where(NPM_ROOT),
      binPath: NPM_PATH,
    });
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("Couldn't run");
  });

  it("a synchronously-throwing spawn gets the same fallback", async () => {
    await run({
      spawn: () => {
        throw new Error("spawn EPERM");
      },
      where: where(NPM_ROOT),
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
    await run({
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
    await run({
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
    const whereFn = where(NPM_ROOT);
    await run({
      spawn,
      where: whereFn,
      binPath: NPX_PATH,
      now: () => NOW,
      cachePath: join(dir, "absent.json"),
      currentVersion: "0.8.0",
    });
    expect(whereFn).not.toHaveBeenCalled(); // no install to check
    expect(spawn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("npx ymmv-cli@latest");
  });

  describe("after a pnpm update exits 0", () => {
    const PNPM_PATH =
      "/home/u/.local/share/pnpm/global/5/.pnpm/ymmv-cli@0.14.1/node_modules/ymmv-cli/dist/cli.js";
    const PNPM_ROOT = "/home/u/.local/share/pnpm/global/5/node_modules\n";
    /** `pnpm list -g --json` as pnpm 9 to 12 print it, with ymmv-cli at `version`. */
    const listed = (version: unknown, extra: Record<string, unknown> = {}): string =>
      JSON.stringify([
        {
          path: "/home/u/.local/share/pnpm/global/5",
          private: false,
          dependencies: { ...extra, "ymmv-cli": { from: "ymmv-cli", version } },
        },
      ]);
    const cache = (latest: string, latestAt = NOW): void => {
      writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: NOW, ok: true, latest, latestAt }));
    };
    const NOTE =
      "Installed 0.14.1, not 0.15.1.\n  The pnpm minimumReleaseAge setting (a day by default since pnpm 11) holds back newer releases.";
    const update = (list: () => Promise<string>, binPath = PNPM_PATH, root = PNPM_ROOT) =>
      run({
        spawn: spawnThat("exit", 0),
        where: where(root),
        list: vi.fn(list),
        binPath,
        cachePath,
        now: () => NOW,
      });

    it("names the version pnpm installed when the cached latest is newer, and exits 0", async () => {
      cache("0.15.1");
      const list = vi.fn(async () => listed("0.14.1", { "is-number": { version: "7.0.0" } }));
      await run({
        spawn: spawnThat("exit", 0),
        where: where(PNPM_ROOT),
        list,
        binPath: PNPM_PATH,
        cachePath,
        now: () => NOW,
      });
      // Static command, same shell and cwd as the install, with a timeout.
      expect(list).toHaveBeenCalledWith("pnpm list -g --json", {
        shell: true,
        cwd: homedir(),
        timeout: expect.any(Number),
      });
      expect(logs.at(-1)).toBe(`\n  ${NOTE}`);
      expect(errs).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    });

    it.each([
      ["the same version", "0.15.1"],
      ["a newer version than the cache (the cache lags a day)", "0.15.2"],
    ] as const)("prints nothing when pnpm installed %s", async (_label, version) => {
      cache("0.15.1");
      await update(async () => listed(version));
      expect(logs).toHaveLength(1); // just the "running" line
      expect(process.exitCode).toBeUndefined();
    });

    it.each([
      ["cold", () => {}],
      ["stale (fetched over a week ago)", () => cache("0.15.1", NOW - 8 * DAY)],
      ["holding a version that isn't a plain triple", () => cache("0.16.0-beta.1")],
    ] as const)("a %s cache prints nothing and never asks pnpm", async (_label, seed) => {
      seed();
      const list = vi.fn(async () => listed("0.14.1"));
      await run({
        spawn: spawnThat("exit", 0),
        where: where(PNPM_ROOT),
        list,
        binPath: PNPM_PATH,
        cachePath,
        now: () => NOW,
      });
      expect(list).not.toHaveBeenCalled();
      expect(logs).toHaveLength(1);
    });

    it.each([
      ["rejects (failed, timed out)", () => Promise.reject(new Error("exit 1"))],
      ["prints nothing", async () => ""],
      ["prints something that isn't JSON", async () => "ymmv-cli 0.14.1\n"],
      ["prints an object, not a list", async () => JSON.stringify({ dependencies: {} })],
      ["lists no ymmv-cli", async () => JSON.stringify([{ dependencies: {} }])],
      ["lists a project with no dependencies", async () => JSON.stringify([{ path: "/x" }, null])],
      [
        "lists ymmv-cli twice",
        async () =>
          JSON.stringify([JSON.parse(listed("0.14.1"))[0], JSON.parse(listed("0.13.0"))[0]]),
      ],
      ["lists a prerelease", async () => listed("0.14.1-beta.1")],
      ["lists a version laced with escapes", async () => listed(`${ESC}[2J0.14.1`)],
      ["lists a version that isn't a string", async () => listed(14)],
    ] as const)("a lookup that %s prints nothing", async (_label, list) => {
      cache("0.15.1");
      await update(list);
      expect(logs).toHaveLength(1);
      expect(errs).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    });

    it("a failed pnpm install never asks what it installed", async () => {
      cache("0.15.1");
      const list = vi.fn(async () => listed("0.14.1"));
      await run({
        spawn: spawnThat("exit", 1),
        where: where(PNPM_ROOT),
        list,
        binPath: PNPM_PATH,
        cachePath,
        now: () => NOW,
      });
      expect(list).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it.each([
      ["npm", NPM_PATH, NPM_ROOT],
      [
        "bun",
        "/home/u/.bun/install/global/node_modules/ymmv-cli/dist/cli.js",
        "/home/u/.bun/bin\n",
      ],
    ] as const)("%s updates are untouched", async (_label, binPath, root) => {
      cache("0.15.1");
      const list = vi.fn(async () => listed("0.14.1"));
      await run({
        spawn: spawnThat("exit", 0),
        where: where(root),
        list,
        binPath,
        cachePath,
        now: () => NOW,
      });
      expect(list).not.toHaveBeenCalled();
      expect(logs).toHaveLength(1);
      expect(process.exitCode).toBeUndefined();
    });
  });

  it("unknown installs get all three manual commands and exit 0 (doubt never spawns)", async () => {
    const spawn = vi.fn();
    const whereFn = where(NPM_ROOT);
    await run({ spawn, where: whereFn, binPath: "/opt/tools/ymmv" });
    expect(whereFn).not.toHaveBeenCalled(); // no manager was picked, so none is asked
    expect(spawn).not.toHaveBeenCalled();
    const out = logs.join("\n");
    expect(out).toContain("npm i -g ymmv-cli@latest");
    expect(out).toContain("pnpm add -g ymmv-cli@latest");
    expect(out).toContain("bun add -g ymmv-cli@latest");
    expect(process.exitCode).toBeUndefined();
  });
});
