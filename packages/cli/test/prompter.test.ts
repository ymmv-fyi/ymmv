import { describe, expect, it, vi } from "vitest";

// Mock readline so the REAL makePrompter machinery (per-question AbortController, SIGINT/close
// handlers, AbortError → PromptAborted translation) runs without a terminal. The scripted-prompter
// tests in commands.test.ts bypass this layer entirely; these are the only tests that exercise it.
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

import { createInterface } from "node:readline/promises";
import { makePrompter, PromptAborted } from "../src/prompt.js";

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
    close: vi.fn(() => handlers.close?.()), // real readline emits 'close' from close()
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
