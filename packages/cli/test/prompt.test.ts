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
  PromptAborted,
  promptLine,
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
// prevents.
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
});

// Keys typed before the first question: the command's own wait (detection, the profile read) runs
// with the input open (index.ts), and the first question clears what that wait left.
describe("makePrompter: keys typed before the first question", () => {
  /** The prompter's next interface reads these in-memory streams instead of process.stdin. */
  function nextInterface() {
    const streams = terminalStreams();
    vi.mocked(createInterface).mockImplementationOnce((opts) =>
      createInterface({ ...opts, ...streams, terminal: true }),
    );
    return streams;
  }

  it("open: a line typed while nothing is asked is dropped, so a double Enter leaves the Publish confirm up", async () => {
    const { input } = nextInterface();
    const prompter = makePrompter();
    prompter.open();
    input.write(`${CR}${CR}`); // a double Enter during detection
    await tick();
    const pending = prompter.confirm("Publish to ymmv.fyi/me?", true);
    await tick();
    input.write(`n${CR}`);
    expect(await pending).toBe(false);
    prompter.close();
  });

  it("the first question waits a turn, so held keys that reach readline in it are dropped", async () => {
    // An open interface reads the terminal only from the next tick. A first question asked in the
    // same tick would open before a held Enter reaches readline, and the Enter would answer it.
    // The in-memory stream delivers on that next tick; a real terminal can take longer (Windows
    // reads it on a helper thread), which this cannot model.
    const { input } = nextInterface();
    input.write(`${CR}${CR}`); // typed at launch, held while nothing reads
    const prompter = makePrompter();
    prompter.open();
    const pending = prompter.confirm("Sign in with GitHub to claim ymmv.fyi/me?", true);
    await tick();
    await tick();
    input.write(`n${CR}`);
    expect(await pending).toBe(false);
    prompter.close();
  });

  it("^C or ^D held until the first question's turn aborts that question, never exits from under it", async () => {
    // Read inside the turn, with the question already counted as pending: the question aborts
    // (the command's own "nothing happened" path) instead of the idle exit.
    for (const key of [3, 4]) {
      const { input } = nextInterface();
      input.write(String.fromCharCode(key));
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const prompter = makePrompter();
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

  it("the first question clears an unfinished line typed before it", async () => {
    const { input } = nextInterface();
    const prompter = makePrompter();
    prompter.open();
    input.write("abc");
    await tick();
    const pending = prompter.ask("Font");
    await tick();
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
      let written = "";
      output.on("data", (c: Buffer) => {
        written += String(c);
      });
      let ask: () => Promise<boolean | string>;
      let close: () => void;
      if (viaPrompter) {
        const prompter = makePrompter();
        prompter.open();
        ask = () => prompter.confirm("Publish to ymmv.fyi/me?", true);
        close = () => prompter.close();
      } else {
        const rl = createInterface({ input, output, terminal: true, prompt: "" });
        ask = () => rl.question("Publish to ymmv.fyi/me? ");
        close = () => rl.close();
      }
      input.write("x".repeat(240)); // three wrapped rows at 80 columns
      await tick();
      written = ""; // the echo of the typing, then the card
      const pending = ask();
      await tick();
      expect(written).toStrictEqual(
        viaPrompter ? expect.not.stringMatching(CURSOR_UP) : expect.stringMatching(CURSOR_UP),
      );
      input.write(CR);
      await pending;
      close();
    }
  });

  it("only the first question clears: a paste still answers two in a row", async () => {
    const { input } = nextInterface();
    const prompter = makePrompter();
    prompter.open();
    input.write("zz");
    await tick();
    const first = prompter.ask("Font");
    await tick();
    input.write(`Lilex${CR}Catppuccin`);
    expect(await first).toBe("Lilex");
    const second = prompter.ask("Theme");
    await tick();
    input.write(CR);
    // Cleared again here, the second half of the paste would be lost and Enter would answer "".
    expect(await second).toBe("Catppuccin");
    prompter.close();
  });

  it("each interface clears once: after close(), the next one's first question clears again", async () => {
    const prompter = makePrompter();
    const { input: before } = nextInterface();
    prompter.open();
    const pending = prompter.ask("Font");
    await tick();
    before.write(`Lilex${CR}`);
    await pending;
    prompter.close();
    const { input } = nextInterface();
    prompter.open();
    input.write("y");
    await tick();
    const again = prompter.ask("Theme");
    await tick();
    input.write(CR);
    expect(await again).toBe("");
    prompter.close();
  });

  it("an offer as the first read clears too: the sign-in's browser offer opens on a clean line", async () => {
    // An offer counts as the interface's first read and clears the same way (pollWithOffer also
    // discards right before its offer). Left, "abc" would be redrawn after the offer's text.
    const { input, output } = nextInterface();
    let written = "";
    output.on("data", (c: Buffer) => {
      written += String(c);
    });
    const prompter = makePrompter();
    prompter.open();
    input.write("abc");
    await tick();
    written = ""; // the echo of the typing itself
    const LINE = "Press Enter to open github.com in your browser.";
    const offered = prompter.offer(LINE, new AbortController().signal);
    await tick();
    expect(written).toContain(LINE);
    expect(written).not.toContain("abc");
    input.write(CR);
    expect(await offered).toBe(true);
    prompter.close();
  });

  it("^D typed before the first question: that question is the abort, never a raw readline error", async () => {
    // EOF on an empty line closes the interface with nothing pending. The first question then
    // clears a closed interface and finds it closed: PromptAborted, the "nothing happened" path.
    const { input } = nextInterface();
    const prompter = makePrompter();
    prompter.open();
    input.write(String.fromCharCode(4));
    await tick();
    await expect(prompter.confirm("Publish to ymmv.fyi/me?", true)).rejects.toBeInstanceOf(
      PromptAborted,
    );
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
