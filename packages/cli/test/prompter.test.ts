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
});
