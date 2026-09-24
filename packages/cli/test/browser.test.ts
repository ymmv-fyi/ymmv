import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findLauncher,
  type LaunchDeps,
  type LaunchedChild,
  type LaunchOptions,
  onPath,
} from "../src/browser.js";

// The browser offer's platform layer: which programs, spawned how. Every test injects spawn,
// platform, env and the PATH lookup, so nothing here starts a real process or reads the real PATH.

const URL_ = "https://github.com/login/device";

/** A spawned child the test drives: emit 'exit'/'error' on it, or on its stdin. */
class FakeChild extends EventEmitter {
  readonly unref = vi.fn();
  readonly kill = vi.fn();
  /** Every stdin call in order, so the EPIPE handler can be proven to precede the write. */
  readonly stdinCalls: string[] = [];
  readonly stdin: (EventEmitter & { end(chunk: string): void; destroy(): void }) | null;
  constructor(withStdin = true) {
    super();
    if (!withStdin) {
      this.stdin = null;
      return;
    }
    const calls = this.stdinCalls;
    const stdin = Object.assign(new EventEmitter(), {
      end(chunk: string) {
        calls.push(`end:${chunk}`);
      },
      destroy() {
        calls.push("destroy");
      },
    });
    const on = stdin.on.bind(stdin);
    stdin.on = ((event: string, listener: (...a: unknown[]) => void) => {
      calls.push(`on:${event}`);
      return on(event, listener);
    }) as typeof stdin.on;
    this.stdin = stdin;
  }
}

function spawnReturning(child: FakeChild) {
  return vi.fn(
    (_cmd: string, _args: readonly string[], _opts: LaunchOptions) =>
      child as unknown as LaunchedChild,
  );
}

/** A PATH lookup that knows exactly these names. */
const onPathOf =
  (have: Record<string, string>) =>
  async (name: string): Promise<string | null> =>
    have[name] ?? null;

const LINUX_TOOLS = {
  "xdg-open": "/usr/bin/xdg-open",
  "wl-copy": "/usr/bin/wl-copy",
  xclip: "/usr/bin/xclip",
  wslview: "/usr/bin/wslview",
  "rundll32.exe": "/mnt/c/Windows/System32/rundll32.exe",
  "clip.exe": "/mnt/c/Windows/System32/clip.exe",
};

/** What the launcher would run for open and copy: [path, args] each, or null for no launcher. */
async function programs(deps: LaunchDeps) {
  const child = new FakeChild();
  const spawn = spawnReturning(child);
  const launcher = await findLauncher({ ...deps, spawn });
  if (!launcher) return null;
  void launcher.open(URL_);
  child.emit("exit", 0);
  const opened = spawn.mock.calls[0];
  let copied: unknown[] | null = null;
  if (launcher.copy) {
    spawn.mockClear();
    void launcher.copy("WXYZ-1234");
    child.emit("exit", 0);
    copied = spawn.mock.calls[0] ?? null;
  }
  return {
    open: opened ? [opened[0], opened[1]] : null,
    copy: copied ? [copied[0], copied[1]] : null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("findLauncher: which programs, per platform", () => {
  it.each(["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"])(
    "%s set: no launcher at all (the browser is on the other end)",
    async (name) => {
      for (const platform of ["darwin", "win32", "linux"] as const) {
        const env = { [name]: "1", DISPLAY: ":0" };
        expect(await findLauncher({ platform, env, which: onPathOf(LINUX_TOOLS) })).toBeNull();
      }
    },
  );

  it("win32: rundll32 and clip by absolute System32 path, from SystemRoot, then windir, then C:\\Windows", async () => {
    expect(await programs({ platform: "win32", env: { SystemRoot: "D:\\Win" } })).toEqual({
      open: ["D:\\Win\\System32\\rundll32.exe", ["url.dll,FileProtocolHandler", URL_]],
      copy: ["D:\\Win\\System32\\clip.exe", []],
    });
    expect((await programs({ platform: "win32", env: { windir: "E:\\W" } }))?.open?.[0]).toBe(
      "E:\\W\\System32\\rundll32.exe",
    );
    expect((await programs({ platform: "win32", env: {} }))?.copy?.[0]).toBe(
      "C:\\Windows\\System32\\clip.exe",
    );
  });

  it("win32: a relative SystemRoot or windir is skipped, since it would resolve from the cwd", async () => {
    const env = { SystemRoot: "Windows", windir: "E:\\W" };
    expect((await programs({ platform: "win32", env }))?.open?.[0]).toBe(
      "E:\\W\\System32\\rundll32.exe",
    );
    const neither = { SystemRoot: "Windows", windir: "W" };
    expect((await programs({ platform: "win32", env: neither }))?.copy?.[0]).toBe(
      "C:\\Windows\\System32\\clip.exe",
    );
  });

  it("win32: a driveless root (\\Windows) is skipped too: it resolves on the cwd's drive", async () => {
    const env = { SystemRoot: "\\Windows", windir: "\\\\srv\\share\\Win" };
    expect((await programs({ platform: "win32", env }))?.open?.[0]).toBe(
      "\\\\srv\\share\\Win\\System32\\rundll32.exe",
    );
    expect(
      (await programs({ platform: "win32", env: { SystemRoot: "\\Windows" } }))?.copy?.[0],
    ).toBe("C:\\Windows\\System32\\clip.exe");
  });

  it("win32 never consults PATH: a bare name would resolve from the current directory first", async () => {
    const which = vi.fn(onPathOf(LINUX_TOOLS));
    await findLauncher({ platform: "win32", env: {}, which });
    expect(which).not.toHaveBeenCalled();
  });

  it("darwin: /usr/bin/open and /usr/bin/pbcopy", async () => {
    expect(await programs({ platform: "darwin", env: {} })).toEqual({
      open: ["/usr/bin/open", [URL_]],
      copy: ["/usr/bin/pbcopy", []],
    });
  });

  it("linux without a display: no launcher, even with xdg-open on PATH", async () => {
    expect(await findLauncher({ platform: "linux", env: {}, which: onPathOf(LINUX_TOOLS) })).toBe(
      null,
    );
  });

  it("linux with a display but no xdg-open: no launcher", async () => {
    const which = onPathOf({ xclip: "/usr/bin/xclip" });
    expect(await findLauncher({ platform: "linux", env: { DISPLAY: ":0" }, which })).toBeNull();
  });

  it("linux X: xdg-open, and xclip into the clipboard selection", async () => {
    const which = onPathOf(LINUX_TOOLS);
    expect(await programs({ platform: "linux", env: { DISPLAY: ":0" }, which })).toEqual({
      open: ["/usr/bin/xdg-open", [URL_]],
      copy: ["/usr/bin/xclip", ["-selection", "clipboard"]],
    });
  });

  it("linux Wayland: wl-copy first; xclip only as the XWayland fallback", async () => {
    const env = { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };
    expect(
      (await programs({ platform: "linux", env, which: onPathOf(LINUX_TOOLS) }))?.copy,
    ).toEqual(["/usr/bin/wl-copy", []]);
    const noWlCopy = onPathOf({ "xdg-open": "/usr/bin/xdg-open", xclip: "/usr/bin/xclip" });
    expect((await programs({ platform: "linux", env, which: noWlCopy }))?.copy?.[0]).toBe(
      "/usr/bin/xclip",
    );
  });

  it("Wayland with no XWayland (no DISPLAY): xclip is never a candidate", async () => {
    const which = vi.fn(onPathOf({ "xdg-open": "/usr/bin/xdg-open", xclip: "/usr/bin/xclip" }));
    const launcher = await findLauncher({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      which,
    });
    expect(launcher).not.toBeNull();
    expect(launcher?.copy).toBeNull();
    expect(which).not.toHaveBeenCalledWith("xclip");
  });

  it("linux with an opener but no clipboard program: copy is null (the offer then promises no copy)", async () => {
    const launcher = await findLauncher({
      platform: "linux",
      env: { DISPLAY: ":0" },
      which: onPathOf({ "xdg-open": "/usr/bin/xdg-open" }),
    });
    expect(launcher?.copy).toBeNull();
  });

  describe("WSL: the Windows browser first", () => {
    const wslEnv = { WSL_DISTRO_NAME: "Ubuntu", DISPLAY: ":0" };

    it("rundll32.exe through interop first, and clip.exe first too, even with a Linux clipboard program", async () => {
      // clip.exe writes the Windows clipboard the Windows browser pastes from, and finding it
      // first spares the walks over the slow /mnt/c PATH entries.
      const which = onPathOf(LINUX_TOOLS);
      expect(await programs({ platform: "linux", env: wslEnv, which })).toEqual({
        open: [LINUX_TOOLS["rundll32.exe"], ["url.dll,FileProtocolHandler", URL_]],
        copy: [LINUX_TOOLS["clip.exe"], []],
      });
    });

    it("no rundll32.exe on PATH (appendWindowsPath off): wslview", async () => {
      const which = onPathOf({ wslview: LINUX_TOOLS.wslview, "xdg-open": LINUX_TOOLS["xdg-open"] });
      expect((await programs({ platform: "linux", env: wslEnv, which }))?.open?.[0]).toBe(
        LINUX_TOOLS.wslview,
      );
    });

    it("neither: xdg-open when there is a display, and no launcher when there is not", async () => {
      const which = onPathOf({ "xdg-open": LINUX_TOOLS["xdg-open"] });
      expect((await programs({ platform: "linux", env: wslEnv, which }))?.open?.[0]).toBe(
        LINUX_TOOLS["xdg-open"],
      );
      const headless = { WSL_INTEROP: "/run/WSL/1_interop" };
      expect(await findLauncher({ platform: "linux", env: headless, which })).toBeNull();
    });

    it("no clip.exe on PATH (appendWindowsPath off): wl-copy, then xclip", async () => {
      const env = { WSL_DISTRO_NAME: "Ubuntu", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };
      const without = (...names: string[]) =>
        onPathOf(
          Object.fromEntries(Object.entries(LINUX_TOOLS).filter(([n]) => !names.includes(n))),
        );
      expect(
        (await programs({ platform: "linux", env, which: without("clip.exe") }))?.copy,
      ).toEqual(["/usr/bin/wl-copy", []]);
      expect(
        (await programs({ platform: "linux", env, which: without("clip.exe", "wl-copy") }))?.copy,
      ).toEqual(["/usr/bin/xclip", ["-selection", "clipboard"]]);
    });

    it("the Windows opener needs no display", async () => {
      const which = onPathOf({ "rundll32.exe": LINUX_TOOLS["rundll32.exe"] });
      const env = { WSL_INTEROP: "/run/WSL/1_interop" };
      expect((await programs({ platform: "linux", env, which }))?.open?.[0]).toBe(
        LINUX_TOOLS["rundll32.exe"],
      );
    });
  });
});

describe("findLauncher: a deadline on finding the programs", () => {
  it("a PATH lookup that hangs (a dead network mount) gives no launcher after 1s, not a stalled sign-in", async () => {
    vi.useFakeTimers();
    const which = vi.fn(() => new Promise<string | null>(() => {}));
    let found: unknown = "pending";
    void findLauncher({ platform: "linux", env: { DISPLAY: ":0" }, which }).then((l) => {
      found = l;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(found).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(found).toBeNull();
  });

  it("a lookup that rejects gives no launcher, never an error", async () => {
    const which = vi.fn(async () => {
      throw new Error("EIO");
    });
    expect(await findLauncher({ platform: "linux", env: { DISPLAY: ":0" }, which })).toBeNull();
  });

  it("a quick discovery leaves no deadline timer behind", async () => {
    vi.useFakeTimers();
    expect(await findLauncher({ platform: "darwin", env: {} })).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("open", () => {
  const darwin = { platform: "darwin" as const, env: {} };

  it("spawns argv-only (no shell key at all), detached, hidden, from the home directory, unref'd", async () => {
    const child = new FakeChild();
    const spawn = spawnReturning(child);
    const launcher = await findLauncher({ ...darwin, spawn });
    const done = launcher?.open(URL_);
    child.emit("exit", 0);
    expect(await done).toBe(true);
    const opts = spawn.mock.calls[0]?.[2];
    expect(opts).toEqual({ stdio: "ignore", detached: true, cwd: homedir(), windowsHide: true });
    expect(opts).not.toHaveProperty("shell");
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("false on a spawn 'error' (no such program), a fast non-zero exit (no browser), or a spawn that throws", async () => {
    const failing = new FakeChild();
    let launcher = await findLauncher({ ...darwin, spawn: spawnReturning(failing) });
    const onError = launcher?.open(URL_);
    failing.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    expect(await onError).toBe(false);

    const noBrowser = new FakeChild();
    launcher = await findLauncher({ ...darwin, spawn: spawnReturning(noBrowser) });
    const onExit = launcher?.open(URL_);
    noBrowser.emit("exit", 3); // xdg-open: no method available for opening the URL
    expect(await onExit).toBe(false);

    const throwing = vi.fn(() => {
      throw new Error("EINVAL");
    });
    launcher = await findLauncher({ ...darwin, spawn: throwing });
    expect(await launcher?.open(URL_)).toBe(false);
  });

  it("true once it has run 500ms without failing: a working opener may run as long as the browser", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const launcher = await findLauncher({ ...darwin, spawn: spawnReturning(child) });
    const done = launcher?.open(URL_);
    let settled: boolean | undefined;
    void done?.then((v) => {
      settled = v;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });
});

describe("copy", () => {
  const darwin = { platform: "darwin" as const, env: {} };

  it("writes exactly the code to the helper's stdin, handling EPIPE before the write, and settles on exit 0", async () => {
    const child = new FakeChild();
    const spawn = spawnReturning(child);
    const launcher = await findLauncher({ ...darwin, spawn });
    const done = launcher?.copy?.("WXYZ-1234");
    child.emit("exit", 0);
    expect(await done).toBe(true);
    expect(child.stdinCalls).toEqual(["on:error", "end:WXYZ-1234"]); // no newline, handler first
    const opts = spawn.mock.calls[0]?.[2];
    // stdout/stderr ignored: xclip's forked selection server would hold a pipe open.
    expect(opts).toEqual({
      stdio: ["pipe", "ignore", "ignore"],
      cwd: homedir(),
      windowsHide: true,
    });
    expect(opts).not.toHaveProperty("shell");
    expect(child.unref).toHaveBeenCalledTimes(1); // a hung helper cannot hold the CLI open
  });

  it("false on a non-zero exit, a spawn 'error', an EPIPE on stdin, or a spawn that throws", async () => {
    for (const fail of [
      (c: FakeChild) => c.emit("exit", 1),
      (c: FakeChild) => c.emit("error", new Error("spawn ENOENT")),
      (c: FakeChild) =>
        c.stdin?.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })),
    ]) {
      const child = new FakeChild();
      const launcher = await findLauncher({ ...darwin, spawn: spawnReturning(child) });
      const done = launcher?.copy?.("WXYZ-1234");
      fail(child);
      expect(await done).toBe(false);
    }
    // A stdin error settles the copy, which clears the kill timer: the helper is killed there.
    const dropped = new FakeChild();
    const copier = await findLauncher({ ...darwin, spawn: spawnReturning(dropped) });
    const copying = copier?.copy?.("WXYZ-1234");
    dropped.stdin?.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    expect(await copying).toBe(false);
    expect(dropped.kill).toHaveBeenCalledTimes(1);
    const throwing = vi.fn(() => {
      throw new Error("EINVAL");
    });
    const launcher = await findLauncher({ ...darwin, spawn: throwing });
    expect(await launcher?.copy?.("WXYZ-1234")).toBe(false);
  });

  it("a helper still running after 2s is killed, its pipe closed, and counts as a failure", async () => {
    // Closing our end matters on its own: a write the helper never reads, or a helper that
    // ignores the kill, would otherwise hold the CLI open.
    vi.useFakeTimers();
    const child = new FakeChild();
    const launcher = await findLauncher({ ...darwin, spawn: spawnReturning(child) });
    const done = launcher?.copy?.("WXYZ-1234");
    await vi.advanceTimersByTimeAsync(2000);
    expect(await done).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.stdinCalls).toContain("destroy");
  });

  it("a helper that exits in time leaves no kill timer behind: nothing is killed at 2s", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const launcher = await findLauncher({ ...darwin, spawn: spawnReturning(child) });
    const done = launcher?.copy?.("WXYZ-1234");
    child.emit("exit", 0);
    expect(await done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdinCalls).not.toContain("destroy");
  });

  it("no stdin (Node could not create the pipe: EMFILE): killed, a failure, never a crash", async () => {
    const child = new FakeChild(false);
    const launcher = await findLauncher({ ...darwin, spawn: spawnReturning(child) });
    expect(await launcher?.copy?.("WXYZ-1234")).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe("onPath", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("finds a program in an absolute PATH entry and returns its absolute path", async () => {
    dir = await mkdtemp(join(tmpdir(), "ymmv-onpath-"));
    const tool = join(dir, "xdg-open");
    await writeFile(tool, "#!/bin/sh\n");
    await chmod(tool, 0o755);
    expect(await onPath("xdg-open", { PATH: ["/nonexistent-ymmv", dir].join(delimiter) })).toBe(
      tool,
    );
    expect(await onPath("wslview", { PATH: dir })).toBeNull();
    expect(await onPath("xdg-open", {})).toBeNull();
  });

  it("skips a directory with the program's name: it passes an X_OK check but cannot be spawned", async () => {
    dir = await mkdtemp(join(tmpdir(), "ymmv-onpath-"));
    const first = join(dir, "a");
    const second = join(dir, "b");
    await mkdir(join(first, "xdg-open"), { recursive: true });
    await mkdir(second);
    const tool = join(second, "xdg-open");
    await writeFile(tool, "#!/bin/sh\n");
    await chmod(tool, 0o755);
    expect(await onPath("xdg-open", { PATH: [first, second].join(delimiter) })).toBe(tool);
  });

  it.skipIf(process.platform === "win32")(
    "skips a file without the execute bit and keeps walking",
    async () => {
      dir = await mkdtemp(join(tmpdir(), "ymmv-onpath-"));
      const [a, b] = [join(dir, "a"), join(dir, "b")];
      await mkdir(a);
      await mkdir(b);
      await writeFile(join(a, "xdg-open"), "#!/bin/sh\n");
      await chmod(join(a, "xdg-open"), 0o644);
      await writeFile(join(b, "xdg-open"), "#!/bin/sh\n");
      await chmod(join(b, "xdg-open"), 0o755);
      expect(await onPath("xdg-open", { PATH: [a, b].join(delimiter) })).toBe(join(b, "xdg-open"));
      expect(await onPath("xdg-open", { PATH: a })).toBeNull();
    },
  );

  it("findLauncher's own lookup walks the PATH of the env it was given, not the process's", async () => {
    dir = await mkdtemp(join(tmpdir(), "ymmv-onpath-"));
    const tool = join(dir, "xdg-open");
    await writeFile(tool, "#!/bin/sh\n");
    await chmod(tool, 0o755);
    const child = new FakeChild();
    const spawn = spawnReturning(child);
    const launcher = await findLauncher({
      platform: "linux",
      env: { DISPLAY: ":0", PATH: dir },
      spawn,
    });
    const opening = launcher?.open(URL_);
    child.emit("exit", 0);
    await opening;
    expect(spawn.mock.calls[0]?.[0]).toBe(tool);
    expect(launcher?.copy).toBeNull();
  });

  it("skips a relative entry: it resolves against the current directory, the plant absolute paths avoid", async () => {
    // The package's own bin dir holds a real executable (tsup), on the same drive as the cwd, so
    // the relative form of the same entry is a true relative path on every OS.
    const bin = join(fileURLToPath(new URL(".", import.meta.url)), "..", "node_modules", ".bin");
    expect(await onPath("tsup", { PATH: bin })).toBe(join(bin, "tsup")); // found when absolute
    const rel = relative(process.cwd(), bin);
    expect(isAbsolute(rel)).toBe(false);
    expect(await onPath("tsup", { PATH: rel })).toBeNull();
  });
});
