import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { clearIdleInput, matchChoice, PromptAborted, promptLine } from "../src/prompt.js";

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

// What an open readline does with keys typed while no question is pending (the sign-in's device
// flow, a POST). A whole line it drops by itself. An unfinished one stays until clearIdleInput
// (what discardTypeahead runs after a wait) removes it; left, it would join the next answer and
// erase the card. prompter.test.ts mocks readline away; THIS is where those behaviors are pinned
// against the real interface, each reset case with the uncleared half showing what it prevents.
describe("readline contract behind the idle prompter", () => {
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const CURSOR_UP = new RegExp(`${ESC}\\[\\d+A`);

  /** A readline on in-memory streams that readline drives as a terminal, plus what it wrote. */
  function fakeTerminal(columns = 80) {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns, rows: 24 });
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
