import { spawn as nodeSpawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { colorEnabled, message, palette, sanitizeValue } from "./render.js";
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
// the user's setup — so doubt always prints. A global install still isn't enough to spawn: the
// package manager first on PATH has to be the one that owns the running copy (WSL running the
// Windows npm's ymmv finds the Linux npm; a system Node next to nvm does the same), or the update
// lands in a copy nothing runs. So the manager is asked where it installs, and only an answer
// that holds the running copy spawns. No network here: the ephemeral hint reads the update
// check's cache for an exact pin and falls back to @latest when the cache is cold.

/** The full upgrade command per confident install method — static strings, which is what makes
 *  `shell: true` safe (nothing user-controlled is ever interpolated). */
const UPGRADE_COMMANDS = {
  "npm-global": "npm i -g ymmv-cli@latest",
  "pnpm-global": "pnpm add -g ymmv-cli@latest",
  "bun-global": "bun add -g ymmv-cli@latest",
} as const;

/** How each manager is asked where its global installs live. Static strings, for the same reason
 *  as UPGRADE_COMMANDS. bun has no `root -g`; its global bin dir is the one location it prints. */
const WHERE_COMMANDS = {
  "npm-global": "npm root -g",
  "pnpm-global": "pnpm root -g",
  "bun-global": "bun pm bin -g",
} as const;

/** A package manager that hangs must not hang `ymmv update`: past this the lookup counts as
 *  failed and the manual commands print. Generous, since a cold npm on Windows takes seconds. */
const WHERE_TIMEOUT_MS = 15_000;

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

/** Runs a WHERE_COMMANDS entry and resolves with its stdout. Rejects on a spawn error, a nonzero
 *  exit or the timeout. A separate seam from SpawnFn because this one captures output. */
export type WhereFn = (
  command: string,
  options: { shell: true; cwd: string; timeout: number },
) => Promise<string>;

const runWhere: WhereFn = (command, { cwd, timeout }) =>
  new Promise((resolve, reject) => {
    // stdin is closed so the manager can't sit on a prompt, and stderr is dropped: npm writes
    // its notices there, and only the path on stdout is wanted.
    const child = nodeSpawn(command, {
      stdio: ["ignore", "pipe", "ignore"],
      shell: true,
      cwd,
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    // kill() reaches only the shell. On Windows the manager under cmd.exe can outlive it and
    // keep the pipe open, so the pipe is dropped and the child unref'd for the process to exit.
    const timer = setTimeout(() => {
      child.kill();
      child.stdout.destroy();
      child.unref();
      reject(new Error("timed out"));
    }, timeout);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}`));
    });
  });

/** A drive-letter or UNC path. Judged by shape, not process.platform, so both kinds get their
 *  own separator and case rules wherever the comparison runs. */
const WINDOWS_PATH_RE = /^[a-z]:[\\/]|^\\\\/i;
const pathLib = (p: string): typeof posix => (WINDOWS_PATH_RE.test(p) ? win32 : posix);

/** The one absolute path in a lookup's stdout, or null. Anything else on stdout (a notice, a
 *  blank line, `\r` from a Windows shell) is dropped; no path or several is doubt. */
function printedDir(stdout: string): string | null {
  const dirs = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => win32.isAbsolute(line)); // true for /posix paths as well as C:\ and UNC
  return dirs.length === 1 ? (dirs[0] as string) : null;
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The directory every global install of this manager lives under, from what its lookup printed:
 *   npm   `<prefix>/lib/node_modules` (`%APPDATA%\npm\node_modules` on Windows), used as printed
 *   pnpm  9 and 10 print `…/pnpm/global/5/node_modules`, but the real package sits beside it in
 *         `…/global/5/.pnpm/…`, so the trailing node_modules comes off. 12 prints
 *         `…/pnpm/global/v11` and installs into `<that>/<hash>/node_modules/…`: used as printed.
 *         (11 prints the same but keeps the package in its store, which detectInstallMethod
 *         answers `unknown` for, so an 11 install never gets here.)
 *   bun   prints `$BUN_INSTALL/bin`; packages are in `$BUN_INSTALL/install/global`, so its parent
 */
function installBase(method: keyof typeof WHERE_COMMANDS, printed: string): string {
  const lib = pathLib(printed);
  if (method === "bun-global") return lib.dirname(printed);
  if (method === "pnpm-global" && lib.basename(printed).toLowerCase() === "node_modules") {
    return lib.dirname(printed);
  }
  return printed;
}

/** Compared by segment, so a trailing separator or a doubled one doesn't matter. Windows paths
 *  also ignore case and take either separator: `C:\Users` and `c:/users` are one directory. */
function isInside(dir: string, path: string): boolean {
  const segments = (p: string): string[] =>
    WINDOWS_PATH_RE.test(p)
      ? p
          .toLowerCase()
          .split(/[\\/]+/)
          .filter(Boolean)
      : p.split("/").filter(Boolean);
  // npm redacts anything UUID-shaped in what it prints, so a prefix under such a directory comes
  // back with `***` in that segment. It stands for any text there; the other segments still
  // have to match.
  const same = (seg: string, other = ""): boolean =>
    seg === other ||
    (seg.includes("***") &&
      new RegExp(
        `^${seg
          .split("***")
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".+")}$`,
      ).test(other));
  const outer = segments(dir);
  const inner = segments(path);
  return outer.length > 0 && outer.every((seg, i) => same(seg, inner[i]));
}

export interface UpdateRunDeps {
  spawn?: SpawnFn;
  /** Asks the package manager where its global installs live. */
  where?: WhereFn;
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
  const binPath = deps.binPath ?? binRealpath();
  const method = detectInstallMethod(binPath);
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

  if (method === "unknown" || !binPath) {
    console.log(message(manualFallback("Couldn't tell how ymmv-cli was installed.")));
    return;
  }

  const cmd = UPGRADE_COMMANDS[method];
  const doSpawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const fail = (text: string): void => {
    console.error(message(text));
    process.exitCode = 1;
  };
  const failSpawn = (): void => fail(manualFallback(`Couldn't run \`${cmd}\`.`));

  // Same shell and cwd as the install below, so the lookup resolves the very manager the install
  // would run. Any failure, and any answer that isn't one absolute path, is doubt: print.
  let printed: string | null = null;
  try {
    const stdout = await (deps.where ?? runWhere)(WHERE_COMMANDS[method], {
      shell: true,
      cwd: homedir(),
      timeout: WHERE_TIMEOUT_MS,
    });
    printed = printedDir(stdout);
  } catch {
    // printed stays null
  }
  if (printed === null) {
    fail(manualFallback(`Couldn't check where \`${cmd}\` would install.`));
    return;
  }
  // Both sides are realpaths: binPath already is, and a prefix can be a symlink itself
  // (Homebrew, nvm's `current`).
  const real = realOr(printed);
  const base = installBase(method, real);
  // bun's bin dir can be moved away from $BUN_INSTALL (BUN_INSTALL_BIN). Its `ymmv` there is a
  // symlink to the copy it owns, so that match also counts. Windows has no symlink to follow: a
  // moved bin dir is refused there.
  const owned =
    isInside(base, binPath) || (method === "bun-global" && realOr(join(real, "ymmv")) === binPath);
  if (!owned) {
    const pkgDir = pathLib(binPath).dirname(pathLib(binPath).dirname(binPath)); // …/dist/cli.js
    const pm = cmd.slice(0, cmd.indexOf(" "));
    // Paths are printed, and a directory name can hold anything.
    fail(
      `This ymmv runs from ${sanitizeValue(pkgDir)}, but \`${cmd}\` installs under ${sanitizeValue(base)}.\n` +
        (/^\/mnt\/[a-z]\//i.test(binPath)
          ? "This copy is a Windows install, so run `ymmv update` from Windows."
          : `Run the update with the ${pm} that installed this copy.`),
    );
    return;
  }

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
