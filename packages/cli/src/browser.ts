import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, win32 } from "node:path";

// The sign-in's browser offer (#78): which program opens a URL and which puts text on the
// clipboard, and how each one runs. Every spawn is argv-only, never a shell: cmd.exe would read
// `&` or `^` in an argument as syntax (and device-flow.ts hands the opener only a constant URL,
// since some openers re-parse theirs). Every program is named by an ABSOLUTE path: libuv on
// Windows looks for a bare name in the current directory before PATH, so a clip.exe planted in a
// checkout would run instead of System32's. That is the whole claim: PATH entries and the
// SystemRoot the user's own environment names are trusted, as they are for their shell. cwd is
// the home directory: a detached opener can outlive the CLI, and on Windows a running process's
// cwd cannot be deleted.
//
// rundll32 url.dll,FileProtocolHandler is what gh's cli/browser runs on Windows too. Some EDR
// products flag rundll32 process creation (a known living-off-the-land binary), so a "blocked"
// report from a locked-down machine most likely starts here.

/** How long an opener may run before it counts as launched. A missing browser makes xdg-open (and
 *  open) exit non-zero well inside this; a working one may keep running until the browser does. */
const OPEN_SETTLE_MS = 500;
/** How long a clipboard helper gets. xclip against a dead X socket can hang. */
const COPY_TIMEOUT_MS = 2000;
/** How long finding the programs may take. PATH lookups can hang on a dead network mount; they
 *  run alongside the code request, and the offer (with the poll behind it) waits for them. The
 *  deadline frees the sign-in only: Node cannot cancel a filesystem call, so a lookup hung in the
 *  kernel still holds the process open after the login until the mount answers, as it would any
 *  command run in that shell. */
const DISCOVERY_DEADLINE_MS = 1000;

/** Minimal structural slice of a spawned child: what open and copy need, injectable for tests. */
export interface LaunchedChild {
  stdin: {
    on(event: "error", listener: (err: Error) => void): unknown;
    end(chunk: string): unknown;
    destroy(): unknown;
  } | null;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
  unref(): void;
}
export interface LaunchOptions {
  stdio: "ignore" | ["pipe", "ignore", "ignore"];
  cwd: string;
  windowsHide: true;
  detached?: true;
}
type LaunchSpawn = (
  command: string,
  args: readonly string[],
  options: LaunchOptions,
) => LaunchedChild;

/** The absolute path a program name resolves to on PATH, or null. */
type Which = (name: string) => Promise<string | null>;

export interface LaunchDeps {
  spawn?: LaunchSpawn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  which?: Which;
}

/** The two things the offer does after Enter. Both resolve to whether they worked; neither
 *  rejects. `copy` is null when this machine has no clipboard program to run. */
export interface Launcher {
  open(url: string): Promise<boolean>;
  copy: ((text: string) => Promise<boolean>) | null;
}

interface Program {
  path: string;
  args: readonly string[];
}

/** A program name on PATH, as an absolute path. Relative entries (`.`, an empty one) are skipped:
 *  they resolve against the current directory, the plant the absolute paths exist to avoid. */
export async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      // A directory passes the X_OK check too, and would then fail to spawn.
      if ((await stat(candidate)).isFile()) {
        await access(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // not here, or not executable: try the next entry
    }
  }
  return null;
}

/** The first of `candidates` (name, then fixed args) found on PATH. */
async function firstOnPath(
  which: Which,
  candidates: readonly (readonly [string, ...string[]])[],
): Promise<Program | null> {
  for (const [name, ...args] of candidates) {
    const path = await which(name);
    if (path !== null) return { path, args };
  }
  return null;
}

async function pickPrograms(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  which: Which,
): Promise<{ open: Program; copy: Program | null } | null> {
  if (platform === "win32") {
    // Only a root with its drive (or a UNC share) keeps the path fixed: a relative one would
    // resolve from the cwd, and a driveless `\Windows` from the cwd's drive.
    const root = [env.SystemRoot, env.windir].find(
      (r) => r && win32.isAbsolute(r) && win32.parse(r).root.length > 1,
    );
    const system32 = win32.join(root ?? "C:\\Windows", "System32");
    return {
      open: { path: win32.join(system32, "rundll32.exe"), args: ["url.dll,FileProtocolHandler"] },
      copy: { path: win32.join(system32, "clip.exe"), args: [] },
    };
  }
  if (platform === "darwin") {
    return {
      open: { path: "/usr/bin/open", args: [] },
      copy: { path: "/usr/bin/pbcopy", args: [] },
    };
  }
  // WSL: the user's browser is the Windows one. rundll32.exe reaches it through interop (on PATH
  // by default); wslview needs the wslu package, and xdg-open under WSLg may start a Linux browser
  // that is not signed in to GitHub. clip.exe writes the Windows clipboard that browser pastes
  // from, and trying it first spares two full PATH walks over the slow /mnt/c entries.
  const wsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  const open = await firstOnPath(which, [
    ...(wsl ? ([["rundll32.exe", "url.dll,FileProtocolHandler"], ["wslview"]] as const) : []),
    ...(env.DISPLAY || env.WAYLAND_DISPLAY ? ([["xdg-open"]] as const) : []),
  ]);
  if (!open) return null;
  const copy = await firstOnPath(which, [
    ...(wsl ? ([["clip.exe"]] as const) : []),
    ...(env.WAYLAND_DISPLAY ? ([["wl-copy"]] as const) : []),
    ...(env.DISPLAY ? ([["xclip", "-selection", "clipboard"]] as const) : []),
  ]);
  return { open, copy };
}

function runOpener(doSpawn: LaunchSpawn, program: Program, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: LaunchedChild;
    try {
      child = doSpawn(program.path, [...program.args, url], {
        stdio: "ignore",
        detached: true,
        cwd: homedir(),
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    // Unref'd with the child: neither may keep the CLI alive once the login is done.
    const timer = setTimeout(() => resolve(true), OPEN_SETTLE_MS);
    timer.unref();
    const settle = (ok: boolean): void => {
      clearTimeout(timer);
      resolve(ok);
    };
    child.on("error", () => settle(false));
    child.on("exit", (code) => settle(code === 0));
    child.unref();
  });
}

function runCopier(doSpawn: LaunchSpawn, program: Program, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: LaunchedChild;
    try {
      // stdout and stderr ignored, not piped: xclip and wl-copy fork a process that keeps serving
      // the selection, and it would hold a piped stdout open long after the copy is done.
      child = doSpawn(program.path, [...program.args], {
        stdio: ["pipe", "ignore", "ignore"],
        cwd: homedir(),
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    const { stdin } = child;
    // Our own timer rather than spawn's `timeout` option, whose timer keeps the process alive.
    // It closes our end of the pipe as well as killing the helper: a write the helper never reads
    // (or a helper that ignores the kill) would otherwise hold the CLI open. Unref'd, so it only
    // fires while the CLI is still running; a helper hung past the CLI's exit is left behind.
    const timer = setTimeout(() => {
      stdin?.destroy();
      child.kill();
      resolve(false);
    }, COPY_TIMEOUT_MS);
    timer.unref();
    const settle = (ok: boolean): void => {
      clearTimeout(timer);
      resolve(ok);
    };
    child.on("error", () => settle(false));
    child.on("exit", (code) => settle(code === 0));
    // No stdin when Node could not create the pipe (EMFILE, ENFILE): the spawn is failing.
    if (!stdin) {
      child.kill();
      settle(false);
      return;
    }
    // Before the write: a helper that dies first turns it into EPIPE, an 'error' event that would
    // otherwise crash the CLI.
    stdin.on("error", () => {
      child.kill(); // settle() clears the kill timer: a helper that dropped its stdin goes now
      settle(false);
    });
    stdin.end(text);
    child.unref();
  });
}

/** What this machine can do for the offer, or null when it should not be offered at all, or when
 *  finding out takes longer than DISCOVERY_DEADLINE_MS (the sign-in then prints as it always has). */
export async function findLauncher(deps: LaunchDeps = {}): Promise<Launcher | null> {
  const env = deps.env ?? process.env;
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return null;
  const picking = pickPrograms(
    deps.platform ?? process.platform,
    env,
    deps.which ?? ((name) => onPath(name, env)),
  );
  const programs = await new Promise<Awaited<typeof picking>>((resolve) => {
    const timer = setTimeout(() => resolve(null), DISCOVERY_DEADLINE_MS);
    const settle = (found: Awaited<typeof picking>): void => {
      clearTimeout(timer);
      resolve(found);
    };
    picking.then(settle, () => settle(null));
  });
  if (!programs) return null;
  const doSpawn = deps.spawn ?? nodeSpawn;
  const { open, copy } = programs;
  return {
    open: (url) => runOpener(doSpawn, open, url),
    copy: copy ? (text) => runCopier(doSpawn, copy, text) : null,
  };
}
