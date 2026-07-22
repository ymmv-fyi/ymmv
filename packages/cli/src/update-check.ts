import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import envPaths from "env-paths";
import { type Codes, link, palette, useColor } from "./render.js";

// Passive update check. Fired concurrently at the top of main() for eligible commands; the fetch
// overlaps the command's own network work, and finish() waits at most FINISH_GRACE_MS after the
// command completes before giving up (aborting the fetch so the process can exit). Every failure
// is silent BY DESIGN — this is a background nicety, so it must never add words, latency past the
// grace, or a nonzero exit to the command the user actually ran. The hard compatibility floor
// stays server-side (the 400 unsupported_schema_version path in api.ts), which is why this check
// never needs teeth.
//
//   main(argv)
//     ├─ config gate  (exempt: logout, update)
//     ├─ eligible? ──► startUpdateCheck()          ┐ concurrent:
//     │    (not help/version/error/update)         │  cache fresh? → resolve from cache
//     ├─ switch(cmd) → command work                │  stale? → fetch registry (2s abort)
//     │    (a THROWN error skips the rest)         │           → write cache {ok}
//     └─ await finish() ◄── race(check, 500ms) ────┘
//           └─ notice? → stderr
//
// The notice prints to STDERR (stdout stays byte-clean for pipes) and only when stderr is a TTY,
// so `ymmv view x > out.json` on a terminal still sees it while pipes/CI never do. Color follows
// stderr's TTY-ness for the same reason — colorEnabled() answers for stdout.

/** npm dist-tag endpoint — tiny JSON, `{ version }` is all we read. Base-agnostic on purpose:
 *  the installed package's freshness has nothing to do with which YMMV_API the CLI points at. */
const REGISTRY_URL = "https://registry.npmjs.org/ymmv-cli/latest";
/** Releases LIST page, not the per-version tag URL: release.yml creates the GitHub Release only
 *  AFTER npm publish, so a tag URL 404s exactly when the notice first fires (and forever if that
 *  job dies). The list page always exists and shows the newest notes first. */
const RELEASES_URL = "https://github.com/ymmv-fyi/ymmv/releases";

/** Far below http.ts's 30s REQUEST_TIMEOUT_MS on purpose: a background check must never be why
 *  the process lingers. */
const FETCH_TIMEOUT_MS = 2_000;
/** How long finish() waits after the command completes. The registry fetch almost always resolves
 *  during the command's own network round-trips, so this is a worst-case bound, not a tax. */
const FINISH_GRACE_MS = 500;
/** A successful check holds for a day; a failed one retries sooner so a transient blip doesn't
 *  hide a release for a full day — while a permanently-offline machine still only pays the grace
 *  wait a few times a day instead of on every run. */
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 6 * 60 * 60 * 1000;
/** `ymmv version` shows the cached latest only when the cache is at most this old — printing a
 *  months-stale number as fact on the one command that asks about versions would be a lie. */
const VERSION_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache of the last registry check. `ok` records whether that check SUCCEEDED — a failed check
 *  writes ok:false (keeping any previously-known `latest`) so the next process can pick the 6h
 *  retry window instead of the 24h one. `latestAt` stamps when `latest` was actually FETCHED
 *  (failures carry it forward unchanged): freshness for user-facing facts (`ymmv version`'s
 *  hint, the ephemeral exact pin) is measured from the successful fetch, never from the latest
 *  attempt — otherwise a long-offline machine re-stamping failed checks would present a
 *  months-old version as current. Corrupt/legacy shapes read as absent. */
interface UpdateCache {
  lastCheckedAt: number;
  ok: boolean;
  latest?: string;
  latestAt?: number;
}

/**
 * How this running binary got onto the machine, from the realpath of the bin script. Segment-based
 * (never raw substrings — a username containing "pnpm" must not misclassify), and deliberately
 * conservative: only the three `-global` results carry enough evidence for `ymmv update` to SPAWN
 * a package manager. `ephemeral` (npx / pnpm dlx / bunx caches) gets a re-invocation hint, and
 * everything ambiguous — local node_modules installs, yarn, packaged binaries — is `unknown` and
 * gets the manual commands. A wrong classification prints text; it never executes anything.
 */
export type InstallMethod = "npm-global" | "pnpm-global" | "bun-global" | "ephemeral" | "unknown";

/** Everything injectable for deterministic tests (the PollDeps pattern — no real network, clock,
 *  fs location, TTY, or bin path). Omitted fields fall back to the real process environment. */
export interface UpdateCheckDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
  cachePath?: string;
  /** Pass null to mean "could not be determined" (readFileSync threw). `undefined` = read it. */
  currentVersion?: string | null;
  stderrIsTTY?: boolean;
  /** The bin script's (real)path — NOT Node's process.execPath (the node binary). */
  binPath?: string;
}

/** This build's version from the packaged package.json, or null when unreadable. `0.0.0` is what
 *  dev builds report (CI stamps the real number from the git tag at publish) — callers treat it
 *  as "not a released build". Shared with printVersion so the two can't drift. */
export function ownVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Strict X.Y.Z triple, or null. Anything else — prereleases, dist-tag garbage, `0.0.0-dispatch.N`
 *  rehearsal stamps, ANSI-laced registry data — fails the parse and silently disables whatever
 *  needed it. Doubles as the sanitizer: every printed/interpolated version is REBUILT from the
 *  parsed triple, so wire bytes never reach the terminal. */
export function parseTriple(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `latest` strictly newer than `current`? False when either side fails the triple parse. */
export function isNewer(latest: string, current: string): boolean {
  const l = parseTriple(latest);
  const c = parseTriple(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] !== c[i]) return (l[i] as number) > (c[i] as number);
  }
  return false;
}

/** Sibling of token.json; base-agnostic (no `base` field — the npm registry doesn't care which
 *  API the CLI targets). */
export function updateCachePath(): string {
  return join(envPaths("ymmv", { suffix: "" }).config, "update-check.json");
}

/** Lenient read, same posture as readTokenFile: any failure or wrong shape is "no cache".
 *  Timestamps must be finite and not in the future (measured against `now`): a poisoned or
 *  clock-skewed `lastCheckedAt: 9e99` would otherwise read as fresh forever and silence the
 *  update channel permanently — for a cache, "corrupt" and "impossible" both mean absent. */
async function readCache(path: string, now: number): Promise<UpdateCache | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as Partial<UpdateCache>;
    if (typeof c.lastCheckedAt !== "number" || typeof c.ok !== "boolean") return null;
    if (!Number.isFinite(c.lastCheckedAt) || c.lastCheckedAt > now) return null;
    if (c.latest !== undefined && typeof c.latest !== "string") return null;
    if (c.latestAt !== undefined && (!Number.isFinite(c.latestAt) || c.latestAt > now)) return null;
    return { lastCheckedAt: c.lastCheckedAt, ok: c.ok, latest: c.latest, latestAt: c.latestAt };
  } catch {
    return null;
  }
}

/** Atomic like saveToken (unique temp + rename, survives concurrent processes) but fully
 *  best-effort: this is a throttle cache, not a credential — a read-only config dir must never
 *  break the command, and there is no permissions requirement. */
async function writeCache(path: string, cache: UpdateCache): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(cache));
    await rename(tmp, path);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** The bin script's realpath (npm global bins are symlinks — the TARGET is what carries the
 *  install-layout evidence). Falls back to the raw path when realpath fails. Shared with
 *  runUpdate: both surfaces MUST classify identically or the notice's "run ymmv update" and the
 *  command's own verdict contradict each other. */
export function binRealpath(): string | undefined {
  const raw = process.argv[1];
  if (!raw) return undefined;
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

/** Directory names that legitimately precede `lib/node_modules` in an npm GLOBAL prefix:
 *  /usr/local/lib, /usr/lib, /opt/homebrew/lib, and version-manager trees whose version segment
 *  sits before lib (~/.nvm/versions/node/v22.1.0/lib, asdf's installs/nodejs/22.1.0/lib). A
 *  version-shaped segment (v22.1.0 / 22.1.0) is matched by regex below. This list is the
 *  POSITIVE evidence bar: a layout not on it prints the manual commands instead of spawning —
 *  extend it when a real manager's layout shows up, never loosen the rule itself. */
const NPM_PREFIX_ROOTS = new Set(["usr", "local", "homebrew", "nodejs", "node", "installation"]);
const VERSIONISH_RE = /^v?\d+(\.\d+)*$/;

/**
 * Classify the install from the bin path's segments. Order matters: the ephemeral runner caches
 * nest under manager dirs (`~/.npm/_npx`, pnpm's `dlx`, bunx temp dirs, `~/.bun/install/cache`),
 * so runners are ruled out before their parent manager can claim the path, and disqualifiers
 * (volta owns its installs; a `.pnpm` store is project territory unless pnpm's own global dir
 * anchors it) are ruled out before npm can. Global evidence is POSITIVE and ANCHORED:
 *   npm-global   <known-prefix>/lib/node_modules/ymmv-cli/… or …\npm\node_modules\ymmv-cli\…
 *   pnpm-global  pnpm's OWN global dir — an adjacent `pnpm/global` pair ($PNPM_HOME/global/5/…)
 *   bun-global   under .bun's global install or its bin dir (~/.bun/install/global, ~/.bun/bin)
 * Anchoring matters because a wrong `-global` verdict SPAWNS an installer: a project checked out
 * under a directory literally named `lib/`, or a pnpm project with a stray `global` path segment,
 * must classify `unknown` (prints the manual commands), never npm/pnpm-global.
 */
export function detectInstallMethod(binPath: string | undefined): InstallMethod {
  if (!binPath) return "unknown";
  const segs = binPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const has = (name: string): boolean => segs.includes(name);

  // Ephemeral runner caches first.
  if (has("_npx")) return "ephemeral";
  if (has("dlx") || segs.some((s) => s.startsWith("dlx-"))) return "ephemeral";
  if (segs.some((s) => s.startsWith("bunx-"))) return "ephemeral";
  if (has(".bun") && has("cache")) return "ephemeral";

  if (has(".bun") && (has("global") || has("bin"))) return "bun-global";
  // Volta owns every install under its tree (including lib/node_modules shapes) — spawning
  // `npm i -g` there would fork the install behind volta's back.
  if (has(".volta")) return "unknown";
  // pnpm-global: ONLY pnpm's own global dir (adjacent pnpm→global). `has(pnpm) && has(global)`
  // false-positived on any pnpm PROJECT under a path containing a `global` segment.
  if (segs.some((s, i) => s === "pnpm" && segs[i + 1] === "global")) return "pnpm-global";
  if (has(".pnpm")) return "unknown"; // a pnpm store outside pnpm's global dir = project install
  // npm-global: the node_modules must directly contain ymmv-cli AND sit in a recognized global
  // prefix — <known-root>/lib/node_modules (POSIX / version managers) or npm/node_modules
  // (Windows %APPDATA%\npm). A project dir named `lib/` fails the root check → unknown.
  const npmGlobal = segs.some(
    (s, i) =>
      s === "node_modules" &&
      segs[i + 1] === "ymmv-cli" &&
      ((segs[i - 1] === "lib" &&
        i >= 2 &&
        (NPM_PREFIX_ROOTS.has(segs[i - 2] as string) ||
          VERSIONISH_RE.test(segs[i - 2] as string))) ||
        segs[i - 1] === "npm"),
  );
  if (npmGlobal) return "npm-global";
  return "unknown";
}

/** The upgrade command the notice/`ymmv update` should point an ephemeral (npx-style) user at.
 *  An EXACT pin when the latest version is known: `npx pkg@latest` can serve a stale cached
 *  version (npm's npx cache does not reliably re-resolve moving tags — npm/rfcs#700), while an
 *  exact spec always installs what it names. */
export function npxInvocation(latest: string | null): string {
  const triple = latest ? parseTriple(latest) : null;
  return `npx ymmv-cli@${triple ? triple.join(".") : "latest"}`;
}

/**
 * The one-line notice, or null when `latest` isn't strictly newer. Both versions are rebuilt from
 * their parsed triples (never wire bytes). With color: the "is out" text is an amber OSC-8 link to
 * the releases page — a genuine call-to-action, the sanctioned amber use (see nudge()). Without
 * color: plain text, no URL (the command is the essential part; link()'s no-color contract stays
 * URL-only, so the label form is color-mode-only).
 */
export function formatUpdateNotice(
  current: string,
  latest: string,
  method: InstallMethod,
  color: boolean,
  term?: string,
): string | null {
  const cur = parseTriple(current);
  const lat = parseTriple(latest);
  if (!cur || !lat || !isNewer(lat.join("."), cur.join("."))) return null;
  const latestClean = lat.join(".");
  const currentClean = cur.join(".");
  const cmd = method === "ephemeral" ? npxInvocation(latestClean) : "ymmv update";
  const c: Codes = palette(color);
  const headline = `ymmv-cli ${latestClean} is out`;
  const linked = color ? link(RELEASES_URL, true, term, headline) : headline;
  return `${linked} ${c.faint}(you have ${currentClean})${c.reset} → run ${c.bold}${cmd}${c.reset}`;
}

/** The explicit opt-outs, shared by the startup check and `ymmv version`'s hint — a user who
 *  set the switch asked for NO update surfaces, not just no startup notice. YMMV_* follows the
 *  repo's empty-means-unset convention; NO_UPDATE_NOTIFIER is presence-based upstream, but an
 *  empty-set corner isn't worth a divergent rule; CI covers pipelines that fake a TTY. */
export function updatesOptedOut(env: Record<string, string | undefined>): boolean {
  if (env.YMMV_NO_UPDATE_CHECK) return true;
  if (env.NO_UPDATE_NOTIFIER) return true;
  if (env.CI && env.CI !== "false") return true;
  return false;
}

/** Cached latest for `ymmv version`'s hint and the ephemeral exact pin — only when the value's
 *  own fetch (`latestAt`) is fresh enough to state as fact (VERSION_FRESH_MS; legacy caches
 *  without the field never qualify), and only a value that survives the triple parse. Gating on
 *  `lastCheckedAt` would be wrong: failed checks re-stamp it, so an offline machine would
 *  present an arbitrarily old version as current. Never fetches. */
export async function readCachedLatest(
  deps: { now?: () => number; cachePath?: string } = {},
): Promise<string | null> {
  const now = (deps.now ?? Date.now)();
  const cache = await readCache(deps.cachePath ?? updateCachePath(), now);
  if (!cache?.latest || cache.latestAt === undefined) return null;
  if (now - cache.latestAt > VERSION_FRESH_MS) return null;
  const triple = parseTriple(cache.latest);
  return triple ? triple.join(".") : null;
}

const GRACE: unique symbol = Symbol("grace");

/**
 * Start the background check. All gating happens here so index.ts stays branch-free: when any
 * gate trips, the returned finish() is inert. Gates, in order: explicit opt-outs
 * (YMMV_NO_UPDATE_CHECK / NO_UPDATE_NOTIFIER non-empty — the YMMV_* empty-means-unset convention,
 * applied to both; NO_UPDATE_NOTIFIER is presence-based upstream, but an empty-set corner isn't
 * worth a divergent rule), CI (non-empty and not "false"), a non-TTY stderr, and a current
 * version that isn't a released triple (dev 0.0.0 builds would otherwise always see a "newer"
 * registry).
 */
export function startUpdateCheck(deps: UpdateCheckDeps = {}): {
  finish: () => Promise<string | null>;
  /** Abandon the check without printing — the THROWN-command path in main() calls this so an
   *  in-flight registry socket can't hold the process open after the error prints (finish() is
   *  never reached there, and finish() is otherwise the only abort site). */
  abort: () => void;
} {
  const env = deps.env ?? process.env;
  const nowFn = deps.now ?? Date.now;
  const stderrIsTTY = deps.stderrIsTTY ?? Boolean(process.stderr.isTTY);

  const inert = { finish: async (): Promise<string | null> => null, abort: (): void => {} };
  if (updatesOptedOut(env)) return inert;
  if (!stderrIsTTY) return inert;
  const current = deps.currentVersion !== undefined ? deps.currentVersion : ownVersion();
  const currentTriple = current === null ? null : parseTriple(current);
  if (!currentTriple || currentTriple.join(".") === "0.0.0") return inert;
  const currentClean = currentTriple.join(".");

  const cachePath = deps.cachePath ?? updateCachePath();
  const doFetch = deps.fetch ?? globalThis.fetch;
  const method = detectInstallMethod(deps.binPath ?? binRealpath());
  const color = useColor(env, stderrIsTTY);
  const term = env.TERM;

  const controller = new AbortController();
  const notice = (latest: string | undefined): string | null =>
    latest ? formatUpdateNotice(currentClean, latest, method, color, term) : null;

  // `.catch` attached at creation: an instant rejection (offline) must never surface as an
  // unhandledRejection while the command is still running.
  const check: Promise<string | null> = (async () => {
    const cache = await readCache(cachePath, nowFn());
    if (cache && nowFn() - cache.lastCheckedAt < (cache.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) {
      return notice(cache.latest);
    }
    // Stale or absent → one registry round-trip, hard-capped well under the finish() grace +
    // command runtime. The timer is unref'd so an abandoned fetch never holds the process open.
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    timeout.unref?.();
    let fetched: string | null = null;
    try {
      const res = await doFetch(REGISTRY_URL, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const body = (await res.json()) as { version?: unknown };
        if (typeof body.version === "string") fetched = body.version;
      }
    } catch {
      // Offline, timeout, abort, proxy garbage: all equal silence.
    } finally {
      clearTimeout(timeout);
    }
    const triple = fetched === null ? null : parseTriple(fetched);
    const canonical = triple ? triple.join(".") : undefined;
    // A failed check records the attempt (ok:false → 6h retry) but KEEPS the last known latest
    // AND its original fetch stamp, so a machine that was told about 0.9.0 yesterday still
    // notices while offline today — without the failure masquerading as fresh data.
    const now = nowFn();
    await writeCache(cachePath, {
      lastCheckedAt: now,
      ok: canonical !== undefined,
      latest: canonical ?? cache?.latest,
      latestAt: canonical !== undefined ? now : cache?.latestAt,
    });
    return notice(canonical ?? cache?.latest);
  })().catch(() => null);

  return {
    async finish(): Promise<string | null> {
      const result = await new Promise<string | null | typeof GRACE>((resolve) => {
        const timer = setTimeout(() => resolve(GRACE), FINISH_GRACE_MS);
        timer.unref?.();
        void check.then((v) => {
          clearTimeout(timer);
          resolve(v);
        });
      });
      if (result === GRACE) {
        controller.abort();
        return null;
      }
      return result;
    },
    abort(): void {
      controller.abort();
    },
  };
}
