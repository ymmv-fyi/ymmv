import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// docs/demo/demo.tape types `ymmv` for an account that has never published, then waits for each
// question with a regex (`Wait /Font \(e\.g\./`) before answering it, and VHS fails the recording
// when a Wait never matches. This replays that first publish in-process: detection sees only the
// environment docs/demo/shell.sh gives the CLI, every question goes through the real prompter
// (readline mocked, as in prompter.test.ts), and each one is checked against the tape's Wait for
// it the way VHS checks the terminal's current line. The network and the login are mocked as in
// commands.test.ts.
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));
vi.mock("../src/token-store.js");
vi.mock("../src/device-flow.js");
vi.mock("../src/detect.js");

import { createInterface } from "node:readline/promises";
import { publish } from "../src/commands.js";
import { detectStack } from "../src/detect.js";
import { makePrompter, type Schedule } from "../src/prompt.js";
import { loadCredential } from "../src/token-store.js";

const { detectStack: realDetectStack } =
  await vi.importActual<typeof import("../src/detect.js")>("../src/detect.js");

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

/** The tape's first publish: every `Wait /regex/` from `Type "ymmv"` up to the bare `Wait` that
 *  waits for the shell prompt again, each with what the tape types after it. Throws on a step
 *  that isn't typed text plus exactly one Enter, or on any other key inside the publish. */
function publishSteps(tape: string): Step[] {
  // `#` starts a comment, on its own line or after a command: the tape marks its skips that way.
  const lines = tape.split("\n").map((l) => l.replace(/(^|\s+)#.*$/, "").trim());
  const start = lines.indexOf('Type "ymmv"');
  if (start < 0) throw new Error('demo.tape has no `Type "ymmv"` line');
  const steps: Step[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^Wait(?:\+\w+)?(?:@\S+)?$/.test(line)) break; // back at the shell prompt
    const wait = /^Wait(\+\w+)?(?:@\S+)?\s+\/(.*)\/$/.exec(line);
    if (wait?.[2] !== undefined) {
      // A question is checked on the cursor's line. A Screen wait matches anything still on
      // screen, an earlier question included, so it would never wait.
      if (wait[1] && wait[1] !== "+Line")
        throw new Error(`demo.tape: "${line}" is not a Line wait`);
      steps.push({ wait: new RegExp(wait[2]), answer: "", enters: 0 });
      continue;
    }
    const step = steps.at(-1);
    // Before the first Wait: the Enter that runs `ymmv`.
    if (!step || line === "" || /^Sleep\b/.test(line)) continue;
    const typed = /^Type(?:@\S+)?\s+(["'`])(.*)\1$/.exec(line);
    const enter = /^Enter(?:@\S+)?(?:\s+(\d+))?$/.exec(line);
    if (typed?.[2] !== undefined && step.enters === 0) step.answer += typed[2];
    else if (enter) step.enters += Number(enter[1] ?? 1);
    else throw new Error(`demo.tape: "${line}" while answering ${step.wait}`);
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

let logs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

// The tape's 960 px at FontSize 19 fits about 67 columns (840 px fit 59). A longer question wraps,
// and its Wait then reads only the wrapped tail on the cursor's row.
const TAPE_COLUMNS = 67;

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
});
