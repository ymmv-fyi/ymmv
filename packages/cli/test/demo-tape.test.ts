import { execFile, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// docs/demo/demo.tape types `ymmv` for an account that has never published, then waits for each
// question with a regex (`Wait /Font \(e\.g\./`) before answering it, and VHS fails the recording
// when a Wait never matches. This replays that first publish in-process: detection sees only the
// environment docs/demo/shell.sh gives the CLI, every question goes through the real prompter
// (readline mocked, as in prompter.test.ts), and each one is checked against the tape's Wait for
// it the way VHS checks the terminal's current line. The network and the login are mocked as in
// commands.test.ts.
//
// The rest pins what keeps a recording off the real account and off ymmv.fyi: shell.sh's ymmv() and
// reroute.mjs are run for real, against a stand-in for the CLI, and record.sh's token.json goes
// through the real loadToken.
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));
vi.mock("../src/token-store.js");
// The real token store (reached with importActual below) keeps token.json under env-paths' config
// dir, which is fixed to the real home when env-paths loads. This sends it to a temp directory.
const paths = vi.hoisted(() => ({ config: "" }));
vi.mock("env-paths", () => ({ default: () => ({ config: paths.config }) }));
vi.mock("../src/device-flow.js");
vi.mock("../src/detect.js");

import { createInterface } from "node:readline/promises";
import { publish } from "../src/commands.js";
import { detectStack } from "../src/detect.js";
import { makePrompter, type Schedule } from "../src/prompt.js";
import { loadCredential } from "../src/token-store.js";

const { detectStack: realDetectStack } =
  await vi.importActual<typeof import("../src/detect.js")>("../src/detect.js");

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const demoFile = (name: string) =>
  readFileSync(new URL(`../../../docs/demo/${name}`, import.meta.url), "utf8");
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Step {
  /** The Wait's regex: what the current line must match before the tape answers. */
  wait: RegExp;
  /** What the tape types after that Wait, before its Enter ("" is Enter alone). */
  answer: string;
  /** Enters after that Wait. Each question takes exactly one: none stalls the recording, and a
   *  second answers the next question before its Wait. */
  enters: number;
}

/** The tape's commands, comments dropped: `#` starts one, on its own line or after a command (the
 *  tape marks its skips that way). */
const tapeLines = (tape: string): string[] =>
  tape.split("\n").map((l) => l.replace(/(^|\s+)#.*$/, "").trim());
/** A Wait with no regex waits for the shell prompt: the command before it has finished. */
const BARE_WAIT = /^Wait(?:\+\w+)?(?:@\S+)?$/;
const TYPE = /^Type(?:@\S+)?\s+(["'`])(.*)\1$/;

/** What the recorded part of the tape types at each shell prompt: the first Type after `Show` and
 *  after every bare Wait. */
function shellCommands(tape: string): string[] {
  const lines = tapeLines(tape);
  const commands: string[] = [];
  let atPrompt = true;
  for (const line of lines.slice(lines.indexOf("Show") + 1)) {
    const typed = TYPE.exec(line)?.[2];
    if (BARE_WAIT.test(line)) atPrompt = true;
    else if (typed !== undefined && atPrompt) {
      commands.push(typed);
      atPrompt = false;
    }
  }
  return commands;
}

/** The tape's first publish: every `Wait /regex/` from `Type "ymmv"` up to the bare `Wait` that
 *  waits for the shell prompt again, each with what the tape types after it. Throws on a step
 *  that isn't typed text plus exactly one Enter, or on any other key inside the publish. */
function publishSteps(tape: string): Step[] {
  const lines = tapeLines(tape);
  const start = lines.indexOf('Type "ymmv"');
  if (start < 0) throw new Error('demo.tape has no `Type "ymmv"` line');
  const steps: Step[] = [];
  let launches = 0;
  for (const line of lines.slice(start + 1)) {
    if (BARE_WAIT.test(line)) break; // back at the shell prompt
    const wait = /^Wait(\+\w+)?(?:@\S+)?\s+\/(.*)\/$/.exec(line);
    if (wait?.[2] !== undefined) {
      // A question is checked on the cursor's line. A Screen wait matches anything still on
      // screen, an earlier question included, so it would never wait.
      if (wait[1] && wait[1] !== "+Line")
        throw new Error(`demo.tape: "${line}" is not a Line wait`);
      steps.push({ wait: new RegExp(wait[2]), answer: "", enters: 0 });
      continue;
    }
    if (line === "" || /^Sleep\b/.test(line)) continue;
    const typed = TYPE.exec(line);
    const enter = /^Enter(?:@\S+)?(?:\s+(\d+))?$/.exec(line);
    const step = steps.at(-1);
    if (!step) {
      // Before the first Wait: the Enter that runs `ymmv`, and nothing else.
      if (!enter) throw new Error(`demo.tape: "${line}" before the first question's Wait`);
      launches += Number(enter[1] ?? 1);
    } else if (typed?.[2] !== undefined && step.enters === 0) step.answer += typed[2];
    else if (enter) step.enters += Number(enter[1] ?? 1);
    else throw new Error(`demo.tape: "${line}" while answering ${step.wait}`);
  }
  // None never starts the publish, and a second answers the first question before its Wait.
  if (launches !== 1) {
    throw new Error(
      `demo.tape runs \`ymmv\` with ${launches} Enters before the first Wait, not one`,
    );
  }
  for (const step of steps) {
    if (step.enters !== 1) {
      throw new Error(`demo.tape answers ${step.wait} with ${step.enters} Enters, not one`);
    }
  }
  return steps;
}

/** The environment shell.sh's ymmv() runs the CLI under: the assignments after `env -i`. A value
 *  passed through from the recording shell ("$TERM") is what that shell holds there: VHS's terminal
 *  sets TERM=xterm-256color, and the others are a path and the local Worker's URL, which no
 *  detector reads. */
function demoEnv(shell: string): Record<string, string> {
  const at = shell.indexOf("env -i");
  if (at < 0) throw new Error("shell.sh has no `env -i` command");
  const words = shell.slice(at).replace(/\\\n/g, " ").split(/\s+/).slice(2);
  const env: Record<string, string> = {};
  for (const word of words) {
    const assignment = /^([A-Za-z_]\w*)=(.*)$/.exec(word);
    if (!assignment?.[1] || assignment[2] === undefined) break; // the program env runs
    const value = assignment[2].replace(/^"(.*)"$/, "$1");
    const passed = /^\$\{?(\w+)\}?$/.exec(value)?.[1];
    env[assignment[1]] =
      passed === undefined ? value : passed === "TERM" ? "xterm-256color" : `<${passed}>`;
  }
  return env;
}

/** The line a question leaves the cursor on, as the terminal shows it: what a VHS Wait matches. */
const currentLine = (query: string): string =>
  stripVTControlCharacters(query).split("\n").at(-1)?.trimEnd() ?? "";

/** A readline that records every question the prompter asks and answers it with the tape's next
 *  answer. Past the tape's last Wait, VHS would sit until its timeout, so the question aborts as ^C
 *  would, which ends the command. */
function tapeReadline(steps: readonly Step[], asked: string[]) {
  return {
    question: vi.fn(async (query: string) => {
      asked.push(currentLine(query));
      const step = steps[asked.length - 1];
      if (!step) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return step.answer;
    }),
    on: vi.fn(),
    close: vi.fn(),
    resume: vi.fn(),
    // The stream the first read's settle watches; nothing is typed ahead here.
    input: new EventEmitter(),
  };
}

// The first read's settle runs on the next turn instead of on real timers (see prompter.test.ts).
const nextTurn: Schedule = (_ms, fn) => {
  const t = setImmediate(fn);
  return () => clearImmediate(t);
};

const execFileP = promisify(execFile);

/** A stand-in checkout for shell.sh's ymmv(): the real shell.sh and reroute.mjs, and in place of the
 *  CLI's build a script that prints what it was run with. Its request goes to a closed loopback
 *  port, so a ymmv() that lost reroute.mjs fails to connect instead of reaching anything. The
 *  directory's name has the characters a URL reads as syntax. */
function fixtureCheckout(dir: string): { root: string; home: string } {
  const root = join(dir, "a#b %41?c");
  const home = join(dir, "home");
  mkdirSync(join(root, "packages/cli/dist"), { recursive: true });
  mkdirSync(home);
  cpSync(join(repoRoot, "docs/demo"), join(root, "docs/demo"), { recursive: true });
  writeFileSync(
    join(root, "packages/cli/dist/cli.js"),
    `fetch("http://127.0.0.1:1/").then(() => "sent", (e) => e.message).then((request) =>
       console.log(JSON.stringify({ env: process.env, args: process.argv.slice(2), request })));`,
  );
  return { root, home };
}

/** Runs a script in the kind of shell VHS types into, from `cwd`, with only `env` set. */
const bash = (script: string, cwd: string, env: Record<string, string>) =>
  spawnSync("bash", ["--noprofile", "--norc", "-c", script], { cwd, env, encoding: "utf8" });

let logs: string[];
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ymmv-demo-test-"));
  // Every test, not only the token.json one: the dismissals and update-check files hang off the
  // same config dir, and an empty one would resolve them inside the checkout.
  paths.config = join(scratch, "config");
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

// The tape's 960 px at FontSize 19 fits about 67 columns (840 px fit 59). A longer question wraps,
// and its Wait then reads only the wrapped tail on the cursor's row.
const TAPE_COLUMNS = 67;
/** The settings TAPE_COLUMNS was measured at. */
const TAPE_GEOMETRY = [
  "Set Width 960",
  'Set FontFamily "IBM Plex Mono"',
  "Set FontSize 19",
  "Set Padding 24",
  "Set Margin 24",
];

// bash, and paths the demo never records on.
const posix = process.platform !== "win32";

describe("docs/demo/demo.tape", () => {
  // The platforms VHS records on (it writes no gif on Windows). The host's platform stays out of
  // it; publish's own detection options (its os-release reader) pass through.
  it.each(["linux", "darwin"] as const)(
    "waits for every question the demo's first publish asks, in order, and for no other (%s)",
    async (platform) => {
      const steps = publishSteps(demoFile("demo.tape"));
      const env = demoEnv(demoFile("shell.sh"));
      vi.mocked(detectStack).mockImplementation((_env, _platform, opts) =>
        realDetectStack(env, platform, opts),
      );
      // record.sh's demo login, for an account that has never published.
      vi.mocked(loadCredential).mockResolvedValue({
        base: "https://ymmv.fyi",
        token: "t",
        handle: "bardisty",
        github_id: 101,
        source: "file",
      });
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(jsonRes({ error: "not_found" }, 404)) // the own read: no profile yet
        .mockResolvedValueOnce(jsonRes({ ok: true, handle: "bardisty" })); // the POST
      vi.stubGlobal("fetch", fetchFn);
      const asked: string[] = [];
      vi.mocked(createInterface).mockReturnValue(tapeReadline(steps, asked) as never);

      await publish({ interactive: true, yes: false, prompter: makePrompter(nextTurn) });

      // One question per Wait, in order, each matching its Wait: an extra question would stall the
      // recording, and a missing or renamed one would time its Wait out. First, so a failure names
      // the question that changed.
      expect(asked).toEqual(steps.map((s) => expect.stringMatching(s.wait)));
      // VHS checks a Wait as soon as the Enter before it goes out, while the cursor still sits on the
      // line just answered. A Wait that also matches that line passes at once and leaves the pacing
      // to the Sleeps.
      for (const [i, step] of steps.entries()) {
        const prev = steps[i - 1];
        if (prev) expect(`${asked[i - 1]} ${prev.answer}`.trimEnd()).not.toMatch(step.wait);
      }
      for (const line of asked) expect(line.length).toBeLessThan(TAPE_COLUMNS);
      // shell.sh's header promises this count, and the gif shows the line.
      expect(logs.join("\n")).toMatch(/Detected 7 of 13 fields/);
      expect(logs.join("\n")).toContain("Published bardisty");
    },
  );

  it("is laid out as the column limit was measured", () => {
    expect(tapeLines(demoFile("demo.tape"))).toEqual(expect.arrayContaining(TAPE_GEOMETRY));
  });

  it("types only `ymmv` at a shell prompt, for handles the seed has", () => {
    const tape = demoFile("demo.tape");
    const [first, ...views] = shellCommands(tape);
    expect(first).toBe("ymmv");
    // A handle the seed lacks prints "no ymmv profile" and exits 0, and a mistyped `ymmv` is a
    // "command not found" scene. The Worker matches handles on handle_lower.
    const seeded = [...demoFile("seed.sql").matchAll(/\(\d+, '[^']+', '([^']+)',/g)].map(
      (m) => m[1],
    );
    expect(seeded).toContain("bardisty");
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      expect(view).toMatch(/^ymmv \S+$/);
      expect(seeded).toContain(view.slice("ymmv ".length).toLowerCase());
    }
    // record.sh expects one exit status of 0 per bare Wait, so each command ends in its own. Counted
    // with record.sh's own pattern, which is narrower than BARE_WAIT (no `Wait+Screen`, no indent).
    const counted = tape.split("\n").filter((l) => /^Wait\s*(#|$)/.test(l));
    expect(counted).toHaveLength(views.length + 1);
    expect(tapeLines(tape).filter((l) => BARE_WAIT.test(l))).toHaveLength(counted.length);
  });
});

describe("docs/demo/shell.sh", () => {
  const demoVars = (root: string, home: string) => ({
    YMMV_DEMO_ROOT: root,
    YMMV_DEMO_HOME: home,
    YMMV_DEMO_NODE: process.execPath,
    YMMV_DEMO_WORKER: "http://localhost:1",
  });
  // What the recording shell holds that the CLI must not see: the real HOME above all, whose
  // token.json the CLI would send to the local Worker and then delete on its 401. PATH is the
  // system's alone, so nothing here can reach a `ymmv` installed on the machine running the test.
  const recordingShell = (dir: string) => ({
    PATH: "/usr/bin:/bin",
    HOME: join(dir, "real-home"),
    TERM: "xterm-256color",
    ONLY_IN_THE_RECORDING_SHELL: "1",
  });

  it.runIf(posix)(
    "runs the checkout's build under the demo's environment, behind reroute.mjs",
    () => {
      const { root, home } = fixtureCheckout(scratch);
      const res = bash('source docs/demo/shell.sh && ymmv one "two words"', root, {
        ...recordingShell(scratch),
        ...demoVars(root, home),
      });
      expect(res.stderr).toBe("");
      const ran = JSON.parse(res.stdout) as {
        env: Record<string, string>;
        args: string[];
        request: string;
      };
      expect(ran.args).toEqual(["one", "two words"]);
      // reroute.mjs was loaded: it refused the request before anything was sent.
      expect(ran.request).toBe("demo: refused a request to http://127.0.0.1:1/");
      // Exactly the environment the publish test above detects from, with the demo's HOME. macOS
      // adds a variable of its own to every process.
      const expected = Object.fromEntries(
        Object.entries(demoEnv(demoFile("shell.sh"))).map(([name, value]) => [
          name,
          value === "<YMMV_DEMO_HOME>"
            ? home
            : value === "<YMMV_DEMO_WORKER>"
              ? "http://localhost:1"
              : value,
        ]),
      );
      expect(expected.HOME).toBe(home);
      const { __CF_USER_TEXT_ENCODING: _, ...env } = ran.env;
      expect(env).toEqual(expected);
      // record.sh reads each command's exit status from here.
      expect(readFileSync(join(home, "statuses"), "utf8")).toBe("0\n");
    },
  );

  // A bare Wait waits for the line the cursor sits on, trailing blanks trimmed, to match the tape's
  // WaitPattern. A prompt it doesn't match times out every scene. ${PS1@P} is the prompt as bash
  // draws it, its \[ and \] as the bytes 1 and 2. It needs bash 4.4, and macOS's /bin/bash is 3.2.
  const drawsPrompts = posix && bash(`x=y; printf %s "\${x@P}"`, tmpdir(), {}).stdout === "y";
  it.runIf(drawsPrompts)("draws a prompt the tape's bare Waits match", () => {
    const { root, home } = fixtureCheckout(scratch);
    const res = bash(`source docs/demo/shell.sh && printf %s "\${PS1@P}"`, root, {
      ...recordingShell(scratch),
      ...demoVars(root, home),
    });
    expect(res.stderr).toBe("");
    const drawn = [...stripVTControlCharacters(res.stdout)]
      .filter((c) => c.charCodeAt(0) > 2)
      .join("")
      .trimEnd();
    const pattern = tapeLines(demoFile("demo.tape"))
      .find((l) => l.startsWith("Set WaitPattern "))
      ?.match(/^Set WaitPattern \/(.*)\/$/)?.[1];
    if (pattern === undefined) throw new Error("demo.tape sets no WaitPattern");
    expect(drawn).toMatch(new RegExp(pattern));
  });

  it
    .runIf(posix)
    .each(["YMMV_DEMO_ROOT", "YMMV_DEMO_HOME", "YMMV_DEMO_NODE", "YMMV_DEMO_WORKER"] as const)(
    "defines no ymmv without %s, and the tape's setup then ends the shell",
    (missing) => {
      const { root, home } = fixtureCheckout(scratch);
      const { [missing]: _, ...vars } = demoVars(root, home);
      const env = { ...recordingShell(scratch), ...vars };
      const sourced = bash("source docs/demo/shell.sh; echo status=$?; declare -F ymmv", root, env);
      expect(sourced.stdout).toBe("status=1\n");
      // The hidden setup is the first thing the tape types. With no ymmv defined, the shell has to be
      // gone before the next line, or a `ymmv` typed there reaches whatever is installed.
      const setup = TYPE.exec(
        tapeLines(demoFile("demo.tape")).find((l) => TYPE.test(l)) ?? "",
      )?.[2];
      expect(setup).toContain("source docs/demo/shell.sh");
      const typed = bash(`${setup}\necho still here`, root, env);
      expect(typed.stdout).not.toContain("still here");
      expect(typed.status).toBe(1);
    },
  );
});

describe("docs/demo/reroute.mjs", () => {
  const reroute = pathToFileURL(join(repoRoot, "docs/demo/reroute.mjs")).href;
  // Loaded first, so the fetch reroute.mjs wraps can't leave this machine: a reroute.mjs that
  // stopped rerouting fails here instead of sending the request to ymmv.fyi.
  const loopbackOnly = `data:text/javascript,${encodeURIComponent(
    `const real = globalThis.fetch;
     globalThis.fetch = (url, init) =>
       String(url).startsWith("http://127.0.0.1:")
         ? real(url, init)
         : Promise.reject(new Error("left this machine: " + url));`,
  )}`;
  const run = (worker: string, script: string) =>
    execFileP(process.execPath, ["--import", loopbackOnly, "--import", reroute, "-e", script], {
      env: { ...process.env, YMMV_DEMO_WORKER: worker },
    });

  it("sends a ymmv.fyi request to the local Worker and refuses any other", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.end("from the local Worker");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const { stdout } = await run(
        `http://127.0.0.1:${port}`,
        `const said = (p) => p.then((r) => r.text(), (e) => e.message).then(console.log);
         said(fetch("https://ymmv.fyi/api/v1/profile?x=1", { headers: { authorization: "Bearer t" } }))
           .then(() => said(fetch("https://ymmv.fyi.example/api/v1/profile")))
           .then(() => said(fetch("http://127.0.0.1:${port}/direct")));`,
      );
      expect(stdout.split("\n")).toEqual([
        "from the local Worker",
        "demo: refused a request to https://ymmv.fyi.example/api/v1/profile",
        `demo: refused a request to http://127.0.0.1:${port}/direct`,
        "",
      ]);
      expect(seen).toEqual(["GET /api/v1/profile?x=1 Bearer t"]);
    } finally {
      server.close();
    }
  });

  // The demo login goes out with every request, so the Worker has to be on this machine. A value
  // that only starts like a loopback URL is another host.
  it.each([
    "http://localhost.example:8790",
    "http://localhost@example.com:8790",
    "http://127.0.0.1.example:8790",
    "https://ymmv.fyi",
  ])("refuses to load with YMMV_DEMO_WORKER=%s", async (worker) => {
    await expect(run(worker, 'console.log("loaded")')).rejects.toMatchObject({
      stdout: "",
      stderr: expect.stringContaining("not a loopback address"),
    });
  });

  it.each(["http://localhost:8790", "http://127.0.0.1:8790", "http://[::1]:8790"])(
    "loads with YMMV_DEMO_WORKER=%s",
    async (worker) => {
      expect((await run(worker, 'console.log("loaded")')).stdout).toBe("loaded\n");
    },
  );
});

describe("docs/demo/record.sh", () => {
  it.runIf(posix)("writes a token.json the CLI loads as the seed's demo login", async () => {
    const record = demoFile("record.sh");
    // The printf format record.sh writes the file with, its %s being the run's token.
    const format = /printf '(\{"base".*\})' "\$token"/.exec(record)?.[1];
    if (!format) throw new Error("record.sh no longer writes token.json with a printf format");
    paths.config = join(scratch, "config");
    mkdirSync(paths.config);
    writeFileSync(join(paths.config, "token.json"), format.replace("%s", "the-run's-token"));
    const { loadToken } =
      await vi.importActual<typeof import("../src/token-store.js")>("../src/token-store.js");
    // A field loadToken refuses reads as logged out, and the recording would stop at a sign-in.
    const login = await loadToken();
    expect(login).toEqual({
      base: "https://ymmv.fyi",
      token: "the-run's-token",
      handle: "bardisty",
      github_id: 101,
    });
    // The account the seed gives that token, with no profile yet.
    const seed = demoFile("seed.sql");
    expect(seed).toContain(
      `(${login?.github_id}, '${login?.handle}', '${login?.handle}', '[]', NULL,`,
    );
    expect(seed).toContain(`('@TOKEN_HASH@', ${login?.github_id},`);
  });

  it.runIf(posix)("puts token.json where the CLI looks under the demo's HOME", async () => {
    // env-paths itself, for this platform: record.sh has a config dir for Linux and one for macOS.
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    const { default: envPaths } = await vi.importActual<typeof import("env-paths")>("env-paths");
    const config = relative(homedir(), envPaths("ymmv", { suffix: "" }).config);
    expect(dirname(config)).not.toMatch(/^\.\./);
    expect(demoFile("record.sh")).toContain(`config=$tmp/home/${config} ;;`);
  });
});
