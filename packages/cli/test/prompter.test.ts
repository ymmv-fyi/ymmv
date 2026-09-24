import { describe, expect, it, vi } from "vitest";

// Mock readline so the REAL makePrompter machinery (per-question AbortController, SIGINT/close
// handlers, AbortError → PromptAborted translation) runs without a terminal. The scripted-prompter
// tests in commands.test.ts bypass this layer entirely; these are the only tests that exercise it.
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

import { createInterface } from "node:readline/promises";
import { makePrompter, PromptAborted, PrompterMisuse } from "../src/prompt.js";

type Handler = () => void;

function fakeRl() {
  const handlers: Record<string, Handler> = {};
  const resolvers: Array<(value: string) => void> = [];
  const question = vi.fn(
    (_q: string, opts: { signal: AbortSignal }) =>
      new Promise<string>((resolve, reject) => {
        resolvers.push(resolve);
        opts.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  );
  const rl = {
    question,
    on: vi.fn((ev: string, h: Handler) => {
      handlers[ev] = h;
    }),
    closed: false,
    // Real readline returns early once closed, and emits 'close' from close().
    close: vi.fn(function (this: { closed: boolean }) {
      if (this.closed) return;
      handlers.close?.();
      this.closed = true;
    }),
    resume: vi.fn(),
  };
  // answer() resolves the NEWEST pending question — earlier ones may have died by abort.
  return {
    rl,
    fire: (ev: string) => handlers[ev]?.(),
    answer: (v: string) => resolvers.pop()?.(v),
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("makePrompter abort machinery", () => {
  it("mid-question SIGINT surfaces as PromptAborted", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const p = makePrompter().ask("Editor");
    await tick(); // let ask() reach the pending question
    f.fire("SIGINT");
    await expect(p).rejects.toBeInstanceOf(PromptAborted);
  });

  it("mid-question EOF (close) surfaces as PromptAborted — never an unsettled exit-0", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const p = makePrompter().confirm("Delete?", false);
    await tick();
    f.fire("close");
    await expect(p).rejects.toBeInstanceOf(PromptAborted);
  });

  it("an aborted question's controller does not poison the next question", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const prompter = makePrompter();
    const p1 = prompter.ask("Editor");
    await tick();
    f.fire("SIGINT");
    await expect(p1).rejects.toBeInstanceOf(PromptAborted);
    // Second question gets a FRESH controller: it must stay pending, then resolve normally.
    const p2 = prompter.ask("OS");
    await tick();
    f.answer("Windows");
    await expect(p2).resolves.toBe("Windows");
  });

  it("EOF while no question is pending aborts the next question, not a raw readline error", async () => {
    // Ctrl+D during a POST or the sign-in's device flow: readline closes with nothing to abort,
    // and a real closed interface rejects every later question with ERR_USE_AFTER_CLOSE.
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const prompter = makePrompter();
    const p1 = prompter.choice("Publish?", ["y", "n"], "y", "Y/n");
    await tick();
    f.answer("y");
    await expect(p1).resolves.toBe("y");
    f.fire("close");
    f.rl.question.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" }),
      ),
    );
    await expect(prompter.choice("Publish?", ["y", "n"], "y", "Y/n")).rejects.toBeInstanceOf(
      PromptAborted,
    );
  });

  it("an input error (EIO: the terminal went away) reads like EOF, never an uncaught throw", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const p = makePrompter().confirm("Delete?", false);
    await tick();
    const aborted = expect(p).rejects.toBeInstanceOf(PromptAborted); // attached before it rejects
    f.fire("error"); // with no listener, readline's re-emit would throw
    await tick();
    expect(f.rl.close).toHaveBeenCalledTimes(1);
    await aborted;
  });

  it("an error raised by close() itself (a failed setRawMode) cannot recurse into close()", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const prompter = makePrompter();
    prompter.open();
    // Like Node's close(): the raw-mode reset errors before `closed` is set.
    const realClose = f.rl.close.getMockImplementation();
    f.rl.close.mockImplementation(function (this: { closed: boolean }) {
      if (!this.closed) f.fire("error");
      return realClose?.call(this);
    });
    expect(() => prompter.close()).not.toThrow();
    await tick();
    expect(f.rl.close).toHaveBeenCalledTimes(2); // the deferred one found it closed
  });

  it("a question that fails for any other reason is not turned into an abort", async () => {
    // Only a closed interface is the user's Ctrl+D; a real stdin error must surface as itself.
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const boom = Object.assign(new Error("read EIO"), { code: "EIO" });
    f.rl.question.mockImplementationOnce(() => Promise.reject(boom));
    await expect(makePrompter().ask("Font")).rejects.toBe(boom);
  });

  it("^C while no question is pending (a POST, the sign-in's device flow) exits 130 directly", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const prompter = makePrompter();
      const p = prompter.choice("Publish?", ["y", "n"], "y", "Y/n");
      await tick();
      f.answer("y");
      await expect(p).resolves.toBe("y");
      f.fire("SIGINT");
      expect(write).toHaveBeenCalledWith("\n");
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      exit.mockRestore();
      write.mockRestore();
    }
  });

  it("fg after Ctrl+Z resumes the input readline paused, so ^C works again", async () => {
    // readline pauses its input on SIGCONT and leaves the resume to its owner.
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const p = makePrompter().ask("Editor");
    await tick();
    f.answer("Zed");
    await p;
    f.fire("SIGCONT");
    expect(f.rl.resume).toHaveBeenCalledTimes(1);
  });

  it("discardTypeahead forgets an unfinished line, and does nothing before the first question", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const prompter = makePrompter();
    expect(() => prompter.discardTypeahead()).not.toThrow(); // no interface open yet
    const p = prompter.ask("Editor");
    await tick();
    f.answer("Zed");
    await p;
    Object.assign(f.rl, { line: "y", cursor: 1, prevRows: 3 });
    prompter.discardTypeahead();
    expect(f.rl).toMatchObject({ line: "", cursor: 0, prevRows: 0 });
  });

  it("idles on an empty prompt, so a resize between questions redraws nothing", async () => {
    // readline redraws its own prompt on a terminal resize even with no question pending; its
    // default "> " would appear under "waiting for GitHub approval".
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const p = makePrompter().ask("Editor");
    await tick();
    f.answer("Zed");
    await p;
    expect(vi.mocked(createInterface).mock.lastCall?.[0]).toMatchObject({ prompt: "" });
  });
});

describe("offer: the sign-in's optional Enter, with a wait running behind it", () => {
  const LINE = "Press Enter to open github.com in your browser.";

  it("Enter answers true whatever was typed; the line is tight under the waiting line", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const p = makePrompter().offer(LINE, new AbortController().signal);
    await tick();
    f.answer("anything");
    await expect(p).resolves.toBe(true);
    expect(f.rl.question).toHaveBeenCalledWith(`  ${LINE} `, expect.anything());
  });

  it("withdrawing it answers false (the poll won), never a PromptAborted", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const withdraw = new AbortController();
    const p = makePrompter().offer(LINE, withdraw.signal);
    await tick();
    // The offer's own signal reaches readline: that is what cancels the line on screen.
    expect(f.rl.question.mock.calls[0]?.[1].signal).toBe(withdraw.signal);
    withdraw.abort();
    await expect(p).resolves.toBe(false);
  });

  it("EOF during an offer, then the withdrawal: false, no throw (an input that just ends leaves it pending until then)", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const withdraw = new AbortController();
    const p = makePrompter().offer(LINE, withdraw.signal);
    await tick();
    f.fire("close");
    withdraw.abort();
    await expect(p).resolves.toBe(false);
  });

  it("an offer on an interface an earlier EOF closed: false, not a raw readline error", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    f.rl.question.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" }),
      ),
    );
    await expect(makePrompter().offer(LINE, new AbortController().signal)).resolves.toBe(false);
  });

  it("an offer that fails for any other reason surfaces it, and frees the prompter for the next question", async () => {
    // Left marked pending, the next question (delete's confirm) would throw PrompterMisuse.
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const boom = Object.assign(new Error("read EIO"), { code: "EIO" });
    f.rl.question.mockImplementationOnce(() => Promise.reject(boom));
    const prompter = makePrompter();
    await expect(prompter.offer(LINE, new AbortController().signal)).rejects.toBe(boom);
    const q = prompter.confirm("Delete?", false);
    await tick();
    f.answer("");
    await expect(q).resolves.toBe(false);
  });

  it("a second offer while one is pending throws at once, and the first is untouched", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const prompter = makePrompter();
    const first = prompter.offer(LINE, new AbortController().signal);
    await tick();
    expect(() => prompter.offer(LINE, new AbortController().signal)).toThrow(PrompterMisuse);
    expect(f.rl.question).toHaveBeenCalledTimes(1);
    f.answer("");
    await expect(first).resolves.toBe(true);
  });

  it("^C during an offer exits 130 like any wait: the offer never becomes the question ^C aborts", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      void makePrompter().offer(LINE, new AbortController().signal);
      await tick();
      f.fire("SIGINT");
      expect(write).toHaveBeenCalledWith("\n");
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      exit.mockRestore();
      write.mockRestore();
    }
  });

  it("after an offer, a question gets its own controller, and ^C aborts that question", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const prompter = makePrompter();
    const withdraw = new AbortController();
    const offered = prompter.offer(LINE, withdraw.signal);
    await tick();
    withdraw.abort();
    await offered;
    const q = prompter.confirm("Delete?", false);
    await tick();
    f.fire("SIGINT");
    await expect(q).rejects.toBeInstanceOf(PromptAborted);
  });

  it("one pending at a time, either way round: readline would silently drop the second callback", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const prompter = makePrompter();
    const asking = prompter.ask("Editor");
    await tick();
    // Synchronous: the caller learns before it starts the wait the offer would sit in front of.
    expect(() => prompter.offer(LINE, new AbortController().signal)).toThrow(PrompterMisuse);
    f.answer("Zed");
    await asking;

    const withdraw = new AbortController();
    const offered = prompter.offer(LINE, withdraw.signal);
    await tick();
    await expect(prompter.ask("Editor")).rejects.toBeInstanceOf(PrompterMisuse);
    withdraw.abort();
    await expect(offered).resolves.toBe(false);
    expect(f.rl.question).toHaveBeenCalledTimes(2); // the refused ones never reached readline
  });

  it("open() creates the interface before any question, so keys typed during a wait reach it", () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockClear();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const prompter = makePrompter();
    expect(createInterface).not.toHaveBeenCalled(); // lazy until asked
    prompter.open();
    expect(createInterface).toHaveBeenCalledTimes(1);
    prompter.open();
    expect(createInterface).toHaveBeenCalledTimes(1); // one interface, however often
  });
});

describe("prompt lines as output units (spacing convention)", () => {
  // Tests run piped (color off), so the rendered lines carry no ANSI codes.
  it("confirm opens with the unit's one blank line", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const p = makePrompter().confirm("Delete?", false);
    await tick();
    f.answer("n");
    await p;
    expect(f.rl.question).toHaveBeenCalledWith("\n  Delete? [y/N] ", expect.anything());
  });

  it("choice opens with a blank line; a re-ask stays tight under the failed answer", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const p = makePrompter().choice("Publish?", ["y", "n"], "y", "Y/n");
    await tick();
    f.answer("x"); // no match — re-asks
    await tick();
    f.answer("y");
    await expect(p).resolves.toBe("y");
    const queries = f.rl.question.mock.calls.map((c) => c[0]);
    expect(queries[0]).toBe("\n  Publish? [Y/n] ");
    expect(queries[1]).toBe("  Publish? [Y/n] ");
  });

  it("field ask()s stay tight — the walk is one unit opened by its hint line", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const p = makePrompter().ask("Editor");
    await tick();
    f.answer("Zed");
    await expect(p).resolves.toBe("Zed");
    expect(f.rl.question).toHaveBeenCalledWith("  Editor: ", expect.anything());
  });

  it("an ask() hint is shown, and Enter still returns the default, never the hint", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const p = makePrompter().ask("Editor", "Zed", "detected: Neovim");
    await tick();
    f.answer("");
    await expect(p).resolves.toBe("Zed");
    expect(f.rl.question).toHaveBeenCalledWith(
      "  Editor [Zed] (detected: Neovim): ",
      expect.anything(),
    );
  });

  it("a tight choice continues the caller's unit: no opening blank, and a typo re-asks", async () => {
    const f = fakeRl();
    vi.mocked(createInterface).mockReturnValue(f.rl as never);
    const p = makePrompter().choice("Shell  zsh → fish", ["y", "n"], "y", "Y/n", {
      tight: true,
      exact: true,
    });
    await tick();
    f.answer("nushell"); // starts with n, but only "n"/"no" may be the answer that gets remembered
    await tick();
    f.answer("n");
    await expect(p).resolves.toBe("n");
    const queries = f.rl.question.mock.calls.map((c) => c[0]);
    expect(queries).toEqual(["  Shell  zsh → fish [Y/n] ", "  Shell  zsh → fish [Y/n] "]);
  });
});
