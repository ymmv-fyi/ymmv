import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Spied, not replaced: every interface is real. makePrompter's tests below hand it one on in-memory
// streams, since the real one reads process.stdin.
vi.mock("node:readline/promises", { spy: true });

import { createInterface } from "node:readline/promises";
import {
  clearIdleInput,
  makePrompter,
  matchChoice,
  muteOutput,
  PromptAborted,
  promptLine,
  type Schedule,
  SETTLE_CAP_MS,
  SETTLE_QUIET_MS,
} from "../src/prompt.js";

const ESC = String.fromCharCode(0x1b); // explicit code point, never a raw literal
const CR = String.fromCharCode(13);

// Prompt defaults carry env-detected and wire-fetched values — the one print path that used to
// skip the UNTRUSTED rule. Pin that the rendered line is stripped like every other surface.
describe("promptLine", () => {
  it("renders label + default", () => {
    expect(promptLine("Editor", "Neovim")).toBe("  Editor [Neovim]: ");
  });
  it("omits the bracket when there is no default", () => {
    expect(promptLine("Font")).toBe("  Font: ");
    expect(promptLine("Font", "")).toBe("  Font: ");
  });
  it("strips ANSI/control sequences from the default before display", () => {
    const line = promptLine("Editor", `Neo${ESC}[31mvim`);
    expect(line).toBe("  Editor [Neovim]: ");
    expect(line).not.toContain(ESC);
  });
  it("a default that is ONLY control characters renders as no default", () => {
    expect(promptLine("Editor", `${ESC}[2J`)).toBe("  Editor: ");
  });
  it("a hint follows the default in parentheses, before the colon", () => {
    expect(promptLine("Editor", "Zed", false, "detected: Neovim")).toBe(
      "  Editor [Zed] (detected: Neovim): ",
    );
    expect(promptLine("Editor", undefined, false, "detected: Neovim")).toBe(
      "  Editor (detected: Neovim): ",
    );
  });
  it("the hint is env-derived: sanitized, and one with nothing left prints no parentheses", () => {
    expect(promptLine("Editor", "Zed", false, `detected: Neo${ESC}[2Jvim`)).toBe(
      "  Editor [Zed] (detected: Neovim): ",
    );
    expect(promptLine("Editor", "Zed", false, `${ESC}[2J`)).toBe("  Editor [Zed]: ");
    expect(promptLine("Editor", "Zed", false, "")).toBe("  Editor [Zed]: ");
  });
  it("color mode dims the hint like the card's note, never amber", () => {
    expect(promptLine("Editor", "Zed", true, "detected: Neovim")).toBe(
      `  ${ESC}[90mEditor${ESC}[0m [Zed] ${ESC}[90m(detected: Neovim)${ESC}[0m: `,
    );
  });
  it("color mode dims the label only — default and punctuation stay plain ink", () => {
    expect(promptLine("Editor", "Neovim", true)).toBe(`  ${ESC}[90mEditor${ESC}[0m [Neovim]: `);
  });
});

describe("matchChoice", () => {
  const KEYS = ["y", "n", "e"] as const;
  it("empty input returns the default", () => {
    expect(matchChoice("", KEYS, "y")).toBe("y");
    expect(matchChoice("   ", KEYS, "y")).toBe("y");
  });
  it("matches on the first letter, case-insensitively, full words included", () => {
    expect(matchChoice("y", KEYS, "y")).toBe("y");
    expect(matchChoice("YES", KEYS, "y")).toBe("y");
    expect(matchChoice("no", KEYS, "y")).toBe("n");
    expect(matchChoice("EDIT", KEYS, "y")).toBe("e");
  });
  it("unmatched input returns null (the prompter re-asks)", () => {
    expect(matchChoice("q", KEYS, "y")).toBeNull();
    expect(matchChoice("-", KEYS, "y")).toBeNull();
    expect(matchChoice("publish", KEYS, "y")).toBeNull();
  });
  it("d matches only while it is offered; unoffered it re-asks like any other letter", () => {
    expect(matchChoice("d", ["y", "n", "e", "d"], "y")).toBe("d");
    expect(matchChoice("Detected", ["y", "n", "e", "d"], "y")).toBe("d");
    expect(matchChoice("", ["y", "n", "e", "d"], "y")).toBe("y");
    expect(matchChoice("d", KEYS, "y")).toBeNull();
  });
  it("exact: only the letter or yes/no match, so a tool name typed back at a take question re-asks", () => {
    const YN = ["y", "n"];
    expect(matchChoice("n", YN, "y", true)).toBe("n");
    expect(matchChoice(" NO ", YN, "y", true)).toBe("n");
    expect(matchChoice("Yes", YN, "y", true)).toBe("y");
    expect(matchChoice("", YN, "y", true)).toBe("y");
    expect(matchChoice("neovim", YN, "y", true)).toBeNull(); // not "n"
    expect(matchChoice("nvim", YN, "y", true)).toBeNull();
    expect(matchChoice("yazi", YN, "y", true)).toBeNull(); // not "y"
    expect(matchChoice("neovim", YN, "y")).toBe("n"); // the loose default, unchanged
  });

  it("throws loudly on colliding or multi-letter keys (programming error)", () => {
    expect(() => matchChoice("y", ["y", "y"], "y")).toThrow(/unique single letters/);
    expect(() => matchChoice("y", ["yes", "no"], "yes")).toThrow(/unique single letters/);
  });
});

describe("PromptAborted", () => {
  it("is an Error with a stable name for instanceof checks across the command layer", () => {
    const e = new PromptAborted();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PromptAborted");
  });
});

const tick = () => new Promise<void>((r) => setImmediate(r));
const CURSOR_UP = new RegExp(`${ESC}\\[\\d+A`);

/** In-memory streams readline drives as a terminal. Input written before an interface reads it
 *  waits in the stream, as keys wait in a terminal nothing reads. */
function terminalStreams(columns = 80) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns, rows: 24 });
  return { input, output };
}

// What an open readline does with keys typed while no question is pending (the command's start, the
// sign-in's device flow, a POST). A whole line it drops by itself. An unfinished one stays until
// clearIdleInput (what discardTypeahead runs after a wait) removes it; left, it would join the next
// answer and erase the card. prompter.test.ts mocks readline away; THIS is where those behaviors
// are pinned against the real interface, each reset case with the uncleared half showing what it
// prevents, along with the abort, ^C, ^D and error behavior the prompter's handlers assume.
describe("readline contract behind the idle prompter", () => {
  /** A readline on in-memory streams that readline drives as a terminal, plus what it wrote. */
  function fakeTerminal(columns = 80) {
    const { input, output } = terminalStreams(columns);
    let written = "";
    output.on("data", (c: Buffer) => {
      written += String(c);
    });
    const rl = createInterface({ input, output, terminal: true, prompt: "" });
    return {
      rl,
      input,
      take() {
        const w = written;
        written = "";
        return w;
      },
    };
  }

  /** Answer one question, then type `idle` with no question pending. */
  async function leaveIdleText(t: ReturnType<typeof fakeTerminal>, idle: string): Promise<void> {
    const first = t.rl.question("Sign in? ");
    await tick();
    t.input.write(`y${CR}`);
    await first;
    t.input.write(idle);
    await tick();
    expect(t.rl.line).toBe(idle);
  }

  it("drops a whole line typed while no question was pending: a double-tapped Enter answers once", async () => {
    const t = fakeTerminal();
    const first = t.rl.question("Sign in? ");
    await tick();
    t.input.write(`y${CR}${CR}`); // the second Enter arrives with no question pending
    expect(await first).toBe("y");
    const pending = t.rl.question("Publish? ");
    await tick();
    t.input.write(`n${CR}`);
    // Queued, the stray Enter would have answered "" (the default) before the n was typed.
    expect(await pending).toBe("n");
    t.rl.close();
  });

  it("drops text typed while no question was pending, instead of joining the next answer", async () => {
    for (const clear of [false, true]) {
      const t = fakeTerminal();
      await leaveIdleText(t, "y");
      if (clear) clearIdleInput(t.rl);
      const pending = t.rl.question("Publish? ");
      await tick();
      t.input.write(CR);
      // Uncleared, the leftover IS the answer; the cursor sits before it, so a typed "n" would
      // arrive as "ny" and the first letter would decide the publish.
      expect(await pending).toBe(clear ? "" : "y");
      t.rl.close();
    }
  });

  it("leaves output printed since the idle text on screen", async () => {
    for (const clear of [false, true]) {
      const t = fakeTerminal();
      await leaveIdleText(t, "x".repeat(240)); // three wrapped rows at 80 columns
      if (clear) clearIdleInput(t.rl);
      t.take();
      const pending = t.rl.question("Publish to ymmv.fyi/me? ");
      await tick();
      // Uncleared, readline still counts those rows: it moves the cursor up over them and erases
      // downward, taking the card publish printed in between with it.
      expect(t.take()).toStrictEqual(
        clear ? expect.not.stringMatching(CURSOR_UP) : expect.stringMatching(CURSOR_UP),
      );
      t.input.write(CR);
      await pending;
      t.rl.close();
    }
  });

  it("echoes nothing it reads while muted, and draws the next question once unmuted", async () => {
    // An Enter pressed while a command starts: readline drops the line, but unmuted it still
    // writes the line end, a blank line above the first question. Muted, nothing reaches the
    // terminal, and no wrapped rows are counted that the question would move the cursor up over.
    for (const mute of [false, true]) {
      const t = fakeTerminal();
      const unmute = mute ? muteOutput(t.rl) : () => {};
      t.input.write(`${CR}${"x".repeat(240)}`); // the Enter, then three rows' worth at 80 columns
      await tick();
      expect(t.take()).toStrictEqual(mute ? "" : expect.stringMatching(/^\r\nx/));
      const rows = (t.rl as unknown as { prevRows: number }).prevRows;
      expect(rows > 0).toBe(!mute);
      clearIdleInput(t.rl);
      unmute();
      const pending = t.rl.question("Publish? ");
      await tick();
      expect(t.take()).toContain("Publish? ");
      t.input.write(`n${CR}`);
      expect(await pending).toBe("n");
      t.rl.close();
    }
  });

  // What makePrompter's questions, offers and handlers lean on (prompt.ts), all the same on
  // Node 22 and 26 when pinned. A release that changes one fails here, not in a user's terminal.

  it("a withdrawn question ends its line, rejects, and forgets a partial answer", async () => {
    // The sign-in's offer is withdrawn by its signal once the wait behind it ends. The terminal
    // gets a line end, the await an AbortError (PromptAborted, read as "not taken"), and readline
    // drops what was typed, wrapped rows included, so the next question starts clean.
    const t = fakeTerminal();
    const ac = new AbortController();
    const offered = t.rl.question("Q? ", { signal: ac.signal });
    await tick();
    t.input.write("x".repeat(237)); // with the prompt, three full rows at 80 columns
    await tick();
    const state = t.rl as unknown as { prevRows: number };
    expect(state.prevRows).toBeGreaterThan(0);
    t.take();
    ac.abort();
    await expect(offered).rejects.toMatchObject({ name: "AbortError" });
    expect(t.take()).toBe("\r\n");
    expect([t.rl.line, t.rl.cursor, state.prevRows]).toStrictEqual(["", 0, 0]);
    const next = t.rl.question("Publish? ");
    await tick();
    t.input.write(`n${CR}`);
    expect(await next).toBe("n");
    t.rl.close();
  });

  it("^C with a SIGINT listener fires it and leaves the question pending", async () => {
    // The prompter's listener decides: abort the pending question, or exit 130 when idle. Readline
    // itself must neither settle the question nor pause.
    const t = fakeTerminal();
    const sigint = vi.fn();
    t.rl.on("SIGINT", sigint);
    let settled = false;
    const pending = t.rl.question("Publish? ").finally(() => {
      settled = true;
    });
    await tick();
    t.input.write(String.fromCharCode(3));
    await tick();
    await tick();
    expect(sigint).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    t.input.write(`y${CR}`);
    expect(await pending).toBe("y");
    t.rl.close();
  });

  it("^D on an empty line rejects the pending question", async () => {
    // With a signal or without: the prompter's close handler aborts its own question too, and
    // reads either rejection as PromptAborted.
    for (const withSignal of [false, true]) {
      const t = fakeTerminal();
      const opts = withSignal ? { signal: new AbortController().signal } : {};
      const pending = t.rl.question("Publish? ", opts);
      await tick();
      t.input.write(String.fromCharCode(4));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    }
  });

  it("an input that ends, or a close() from code, leaves the pending question unsettled", async () => {
    // Why the prompter's close handler still aborts its own question: the terminal going away,
    // and the close its 'error' handler runs, would otherwise leave the await hanging.
    for (const how of ["end", "close"]) {
      const t = fakeTerminal();
      let settled = false;
      const pending = t.rl.question("Publish? ").finally(() => {
        settled = true;
      });
      pending.catch(() => {});
      await tick();
      if (how === "end") t.input.end();
      else t.rl.close();
      await tick();
      await tick();
      expect(t.rl.closed).toBe(true);
      expect(settled).toBe(false);
    }
  });

  it("a withdrawal after the question was answered writes nothing", async () => {
    // The offer's signal still fires once its wait ends, after an Enter already took it. That must
    // leave no stray line end under the output that follows.
    const t = fakeTerminal();
    const ac = new AbortController();
    const offered = t.rl.question("Q? ", { signal: ac.signal });
    await tick();
    t.input.write(CR);
    await offered;
    t.take();
    ac.abort();
    await tick();
    expect(t.take()).toBe("");
    t.rl.close();
  });

  it("an input error is re-emitted as the interface's 'error', which throws with no listener", () => {
    // Why the prompter listens: EIO from a terminal that went away would otherwise crash the run.
    const err = new Error("EIO");
    const heard = fakeTerminal();
    const onError = vi.fn();
    heard.rl.on("error", onError);
    heard.input.emit("error", err);
    expect(onError).toHaveBeenCalledWith(err);
    heard.rl.close();
    const unheard = fakeTerminal();
    expect(() => unheard.input.emit("error", err)).toThrow(err);
    unheard.rl.close();
  });

  it("close() resets raw mode before it counts as closed, so a close from 'error' re-enters", () => {
    // A tty stream reports a failed setRawMode as an 'error' event, and readline re-emits it from
    // inside close(). The interface is not closed yet, so an 'error' handler that closes at once
    // runs close() again, which fails the same way: unbounded, a stack overflow. The prompter
    // defers its close by a tick for this. The handler here stops after a few rounds, which is
    // enough to show each close() got past the closed check.
    const t = fakeTerminal();
    let failRawReset = false;
    Object.assign(t.input, {
      setRawMode(on: boolean) {
        if (!on && failRawReset) t.input.emit("error", new Error("EIO"));
      },
    });
    const ROUNDS = 5;
    let rounds = 0;
    t.rl.on("error", () => {
      rounds++;
      if (rounds < ROUNDS) t.rl.close();
    });
    failRawReset = true;
    t.rl.close();
    expect(rounds).toBe(ROUNDS);
    // Once closed, a further close() returns early: the prompter's deferred close raises nothing.
    t.rl.close();
    expect(rounds).toBe(ROUNDS);
  });
});

/** The settle's clock: nothing fires until the test moves it, so no test sleeps in real time. */
function fakeClock() {
  let now = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  const after: Schedule = (ms, fn) => {
    const timer = { at: now + ms, fn };
    timers.add(timer);
    return () => {
      timers.delete(timer);
    };
  };
  return {
    after,
    /** Move time forward `ms`, firing what falls due on the way, in order. */
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.fn();
      }
      now = end;
    },
  };
}

// Keys typed before the first question: the command's own wait (detection, the profile read) runs
// with the input open (index.ts), and the first question clears what that wait left once stdin has
// gone quiet.
describe("makePrompter: keys typed before the first question", () => {
  /** The prompter's next interface reads these in-memory streams instead of process.stdin. */
  function nextInterface() {
    const streams = terminalStreams();
    vi.mocked(createInterface).mockImplementationOnce((opts) =>
      createInterface({ ...opts, ...streams, terminal: true }),
    );
    return streams;
  }

  /** A prompter on a fake clock, and a step that lets pending input arrive, then lets the first
   *  read's settle end on a quiet stream. */
  function clockedPrompter() {
    const clock = fakeClock();
    const prompter = makePrompter(clock.after);
    const settleQuiet = async (): Promise<void> => {
      await tick();
      clock.advance(SETTLE_QUIET_MS);
      await tick();
    };
    return { clock, prompter, settleQuiet };
  }

  /** What the output stream has shown since the last take(). */
  function capture(output: PassThrough) {
    let written = "";
    output.on("data", (c: Buffer) => {
      written += String(c);
    });
    return () => {
      const w = written;
      written = "";
      return w;
    };
  }

  it("open: a line typed while nothing is asked is dropped, so a double Enter leaves the Publish confirm up", async () => {
    const { input } = nextInterface();
    const { prompter, settleQuiet } = clockedPrompter();
    prompter.open();
    input.write(`${CR}${CR}`); // a double Enter during detection
    await tick();
    const pending = prompter.confirm("Publish to ymmv.fyi/me?", true);
    await settleQuiet();
    input.write(`n${CR}`);
    expect(await pending).toBe(false);
    prompter.close();
  });

  it("keys dropped before the first question are never echoed: no blank line above it", async () => {
    // Open early (delete, publish, login) or made at the question (`ymmv set`'s link offer, where a
    // Windows console hands held keys over during the settle): an Enter or text readline reads
    // before the first question shows nowhere, and the question itself does.
    for (const openEarly of [true, false]) {
      const { input, output } = nextInterface();
      const shown = capture(output);
      const { prompter, settleQuiet } = clockedPrompter();
      if (openEarly) {
        prompter.open();
        input.write(`${CR}abc`);
        await tick();
      }
      const pending = prompter.confirm("Delete ymmv.fyi/me?", false);
      if (!openEarly) input.write(`${CR}abc`); // arrives during the settle
      await settleQuiet();
      const drawn = shown();
      expect(drawn).not.toContain(CR);
      expect(drawn).not.toContain("abc");
      expect(drawn).toContain("\n  Delete ymmv.fyi/me? [y/N] ");
      input.write(`y${CR}`);
      expect(await pending).toBe(true);
      prompter.close();
    }
  });

  it("held keys that arrive after a turn but before stdin goes quiet are dropped, open early or not", async () => {
    // A Windows console hands over held keys on a helper thread, and an interface made at the
    // question itself (`ymmv set`'s link offer) starts reading only then: either way an Enter
    // pressed while the command started can arrive after the first turn. One turn was the whole
    // wait once, and this Enter answered the default-Y offer.
    for (const openEarly of [true, false]) {
      const { input, output } = nextInterface();
      const shown = capture(output);
      const { clock, prompter } = clockedPrompter();
      if (openEarly) prompter.open();
      const pending = prompter.confirm("use https://github.com/me/dots?", true);
      await tick();
      await tick();
      clock.advance(20);
      input.write(CR); // late, but typed before anything was asked
      await tick();
      clock.advance(SETTLE_QUIET_MS - 1);
      await tick();
      expect(shown()).not.toContain("dots?"); // the Enter restarted the quiet window
      clock.advance(1);
      await tick();
      expect(shown()).toContain("dots?");
      input.write(`n${CR}`);
      expect(await pending).toBe(false);
      prompter.close();
    }
  });

  it("on a quiet terminal the first question waits SETTLE_QUIET_MS, then one Enter answers it", async () => {
    const { input, output } = nextInterface();
    const shown = capture(output);
    const { clock, prompter } = clockedPrompter();
    prompter.open();
    const pending = prompter.confirm("Publish to ymmv.fyi/me?", true);
    await tick();
    clock.advance(SETTLE_QUIET_MS - 1);
    await tick();
    expect(shown()).toBe("");
    clock.advance(1);
    await tick();
    expect(shown()).toContain("Publish to ymmv.fyi/me?");
    input.write(CR);
    expect(await pending).toBe(true);
    prompter.close();
  });

  it("keys that never go quiet end the wait at the cap, and later ones reach the question", async () => {
    // A key held down past SETTLE_CAP_MS types into the question, as it did before the settle:
    // the cap keeps the prompt from waiting on the user's own keyboard.
    const { input, output } = nextInterface();
    const shown = capture(output);
    const { clock, prompter } = clockedPrompter();
    prompter.open();
    const readers = input.listenerCount("data");
    const pending = prompter.ask("Font");
    await tick();
    for (let t = 0; t + 30 < SETTLE_CAP_MS; t += 30) {
      clock.advance(30);
      input.write("x"); // each chunk inside the quiet window of the one before
      await tick();
    }
    expect(shown()).not.toContain("Font");
    clock.advance(SETTLE_CAP_MS);
    await tick();
    expect(shown()).toContain("Font");
    input.write(`Lilex${CR}`);
    expect(await pending).toBe("Lilex"); // what came before the cap was cleared
    expect(input.listenerCount("data")).toBe(readers); // the settle's listener is gone
    prompter.close();
  });

  it("^C or ^D held until the settle aborts that question at once, never exits from under it", async () => {
    // The question already counts as pending: it aborts (the command's own "nothing happened"
    // path) instead of the idle exit, and the settle ends without waiting out its clock.
    for (const key of [3, 4]) {
      const { input } = nextInterface();
      input.write(String.fromCharCode(key));
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const { prompter } = clockedPrompter();
      try {
        prompter.open();
        await expect(prompter.confirm("Publish to ymmv.fyi/me?", true)).rejects.toBeInstanceOf(
          PromptAborted,
        );
        expect(exit).not.toHaveBeenCalled();
      } finally {
        prompter.close();
        exit.mockRestore();
      }
    }
  });

  it("^C during an offer's settle exits 130 as in any wait; a withdrawal ends it at once", async () => {
    const { input } = nextInterface();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { prompter } = clockedPrompter();
    const LINE = "Press Enter to open github.com in your browser.";
    try {
      const withdraw = new AbortController();
      const offered = prompter.offer(LINE, withdraw.signal);
      await tick();
      input.write(String.fromCharCode(3));
      await tick();
      expect(write).toHaveBeenCalledWith("\n");
      expect(exit).toHaveBeenCalledWith(130);
      withdraw.abort(); // the poll settled while the offer still waited for quiet
      expect(await offered).toBe(false);
    } finally {
      prompter.close();
      exit.mockRestore();
      write.mockRestore();
    }
  });

  it("the first question clears an unfinished line typed before it", async () => {
    const { input } = nextInterface();
    const { prompter, settleQuiet } = clockedPrompter();
    prompter.open();
    input.write("abc");
    await tick();
    const pending = prompter.ask("Font");
    await settleQuiet();
    input.write(CR);
    // Left, "abc" would be the answer, with the cursor before it for whatever came next.
    expect(await pending).toBe("");
    prompter.close();
  });

  it("text that wrapped before the first question leaves the card printed since on screen", async () => {
    // A long line typed during detection wraps, and readline counts those rows. The first
    // question must forget them too, or it moves the cursor up over them and erases the profile
    // card publish printed in between. The raw interface is the uncleared half.
    for (const viaPrompter of [false, true]) {
      const { input, output } = viaPrompter ? nextInterface() : terminalStreams();
      const shown = capture(output);
      let ask: () => Promise<boolean | string>;
      let close: () => void;
      let reach: () => Promise<void> = tick;
      if (viaPrompter) {
        const { prompter, settleQuiet } = clockedPrompter();
        prompter.open();
        ask = () => prompter.confirm("Publish to ymmv.fyi/me?", true);
        close = () => prompter.close();
        reach = settleQuiet;
      } else {
        const rl = createInterface({ input, output, terminal: true, prompt: "" });
        ask = () => rl.question("Publish to ymmv.fyi/me? ");
        close = () => rl.close();
      }
      input.write("x".repeat(240)); // three wrapped rows at 80 columns
      await tick();
      shown(); // the echo of the typing, then the card
      const pending = ask();
      await reach();
      expect(shown()).toStrictEqual(
        viaPrompter ? expect.not.stringMatching(CURSOR_UP) : expect.stringMatching(CURSOR_UP),
      );
      input.write(CR);
      await pending;
      close();
    }
  });

  it("only the first question clears: a paste still answers two in a row", async () => {
    const { input } = nextInterface();
    const { prompter, settleQuiet } = clockedPrompter();
    prompter.open();
    input.write("zz");
    await tick();
    const first = prompter.ask("Font");
    await settleQuiet();
    input.write(`Lilex${CR}Catppuccin`);
    expect(await first).toBe("Lilex");
    const second = prompter.ask("Theme");
    await tick(); // no settle: only the first read waits for quiet
    input.write(CR);
    // Cleared again here, the second half of the paste would be lost and Enter would answer "".
    expect(await second).toBe("Catppuccin");
    prompter.close();
  });

  it("each interface clears once: after close(), the next one's first question clears again", async () => {
    const { prompter, settleQuiet } = clockedPrompter();
    const { input: before } = nextInterface();
    prompter.open();
    const pending = prompter.ask("Font");
    await settleQuiet();
    before.write(`Lilex${CR}`);
    await pending;
    prompter.close();
    const { input } = nextInterface();
    prompter.open();
    input.write("y");
    await tick();
    const again = prompter.ask("Theme");
    await settleQuiet();
    input.write(CR);
    expect(await again).toBe("");
    prompter.close();
  });

  it("an offer as the first read clears too: the sign-in's browser offer opens on a clean line", async () => {
    // An offer counts as the interface's first read and clears the same way (pollWithOffer also
    // discards right before its offer). Left, "abc" would be redrawn after the offer's text.
    const { input, output } = nextInterface();
    const shown = capture(output);
    const { prompter, settleQuiet } = clockedPrompter();
    prompter.open();
    input.write("abc");
    await tick();
    shown(); // the echo of the typing itself
    const LINE = "Press Enter to open github.com in your browser.";
    const offered = prompter.offer(LINE, new AbortController().signal);
    await settleQuiet();
    const written = shown();
    expect(written).toContain(LINE);
    expect(written).not.toContain("abc");
    input.write(CR);
    expect(await offered).toBe(true);
    prompter.close();
  });

  it("^D typed before the first question: that question is the abort, never a raw readline error", async () => {
    // EOF on an empty line closes the interface with nothing pending. The first question then
    // settles on a stream that sends nothing more, clears a closed interface and finds it closed:
    // PromptAborted, the "nothing happened" path.
    const { input } = nextInterface();
    const { prompter, settleQuiet } = clockedPrompter();
    prompter.open();
    input.write(String.fromCharCode(4));
    await tick();
    const pending = prompter.confirm("Publish to ymmv.fyi/me?", true);
    const aborted = expect(pending).rejects.toBeInstanceOf(PromptAborted);
    await settleQuiet();
    await aborted;
    prompter.close(); // the interface is already closed: a no-op, never a throw
  });

  it("^C typed before the first question exits 130 at once, as in any wait", async () => {
    // Open, the terminal is raw and ^C is a key readline reads, not a signal: without the
    // prompter's SIGINT handler, readline would only pause and detection would run on.
    const { input } = nextInterface();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prompter = makePrompter();
    try {
      prompter.open();
      input.write(String.fromCharCode(3));
      await tick();
      expect(write).toHaveBeenCalledWith("\n");
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      prompter.close();
      exit.mockRestore();
      write.mockRestore();
    }
  });
});
