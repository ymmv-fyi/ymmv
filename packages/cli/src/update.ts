import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { colorEnabled, message, palette } from "./render.js";
import {
  binRealpath,
  detectInstallMethod,
  isNewer,
  npxInvocation,
  ownVersion,
  readCachedLatest,
} from "./update-check.js";

// `ymmv update` — the one-command upgrade path the update notice points at. The command SPAWNS a
// package manager only when detectInstallMethod found positive global-install evidence; ephemeral
// runs (npx / pnpm dlx / bunx) get the re-invocation to type, and anything ambiguous gets all
// three manual commands. Printing the wrong text is harmless; running the wrong installer forks
// the user's setup — so doubt always prints. No network here: the ephemeral hint reads the update
// check's cache for an exact pin and falls back to @latest when the cache is cold.

/** The full upgrade command per confident install method — static strings, which is what makes
 *  `shell: true` safe (nothing user-controlled is ever interpolated). */
const UPGRADE_COMMANDS = {
  "npm-global": "npm i -g ymmv-cli@latest",
  "pnpm-global": "pnpm add -g ymmv-cli@latest",
  "bun-global": "bun add -g ymmv-cli@latest",
} as const;

const MANUAL_LIST = Object.values(UPGRADE_COMMANDS)
  .map((cmd) => `  ${cmd}`)
  .join("\n");

/** "Command not found" exit codes from the shell wrapper: POSIX sh says 127, cmd.exe says 9009.
 *  With shell:true the spawn itself succeeds (the SHELL exists) and the missing package manager
 *  surfaces as one of these instead of an `error` event — both get the manual fallback. */
const NOT_FOUND_CODES = new Set([127, 9009]);

/** Minimal structural slice of a spawned child — what runUpdate needs, injectable for tests. */
export interface SpawnedChild {
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
}
export type SpawnFn = (
  command: string,
  options: { stdio: "inherit"; shell: true; cwd: string },
) => SpawnedChild;

export interface UpdateRunDeps {
  spawn?: SpawnFn;
  /** The bin script's (real)path — NOT Node's process.execPath (the node binary). */
  binPath?: string;
  now?: () => number;
  cachePath?: string;
  /** Pass null to mean "could not be determined". `undefined` = read it. */
  currentVersion?: string | null;
}

function manualFallback(intro: string): string {
  return `${intro} Update with the command that matches your setup:\n${MANUAL_LIST}`;
}

export async function runUpdate(deps: UpdateRunDeps = {}): Promise<void> {
  // Same realpath resolution as the startup notice — npm global bins are symlinks, and the two
  // surfaces must agree or the notice says "run ymmv update" while update itself shrugs.
  const method = detectInstallMethod(deps.binPath ?? binRealpath());
  const c = palette(colorEnabled());

  if (method === "ephemeral") {
    // Nothing installed to update — the running copy lives in a runner cache. A fresh cached
    // latest gives an exact pin (reliable against npx's stale tag cache) — but ONLY when it is
    // newer than the running build: right after a release the cache can lag the version the
    // user is already on, and pinning would instruct a downgrade. Anything else (cold cache,
    // unknown own version, cache ≤ current) falls back to @latest, always safe to type.
    const cached = await readCachedLatest({ now: deps.now, cachePath: deps.cachePath });
    const current = deps.currentVersion !== undefined ? deps.currentVersion : ownVersion();
    const pin = cached !== null && current !== null && isNewer(cached, current) ? cached : null;
    console.log(
      message(
        `This run came from a package runner cache (npx-style), so there is no install to update.\n` +
          `Next time run: ${c.bold}${npxInvocation(pin)}${c.reset}`,
      ),
    );
    return;
  }

  if (method === "unknown") {
    console.log(message(manualFallback("Couldn't tell how ymmv-cli was installed.")));
    return;
  }

  const cmd = UPGRADE_COMMANDS[method];
  const doSpawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const failSpawn = (): void => {
    console.error(message(manualFallback(`Couldn't run \`${cmd}\`.`)));
    process.exitCode = 1;
  };
  console.log(message(`${c.faint}running${c.reset} ${c.bold}${cmd}${c.reset}`));
  await new Promise<void>((resolve) => {
    let child: SpawnedChild;
    try {
      // cwd is pinned to the home dir: with shell:true on Windows, cmd.exe resolves a bare
      // command name from the CURRENT directory before PATH, so `ymmv update` run inside an
      // untrusted checkout containing a planted npm.cmd would execute it (CWE-427). The package
      // managers themselves don't care where a global install runs from.
      child = doSpawn(cmd, { stdio: "inherit", shell: true, cwd: homedir() });
    } catch {
      failSpawn();
      resolve();
      return;
    }
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
      resolve();
    };
    child.on("error", () => {
      settle(failSpawn);
    });
    child.on("exit", (code) => {
      settle(() => {
        if (code !== null && NOT_FOUND_CODES.has(code)) {
          failSpawn();
        } else if (code) {
          // The package manager already explained itself on the inherited stdio — pass its
          // verdict through without re-narrating.
          process.exitCode = code;
        }
      });
    });
  });
}
