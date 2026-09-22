import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { type Codes, colorEnabled, palette, sanitizeValue } from "./render.js";

// Thin readline wrapper. The commands depend on the `Prompter` INTERFACE (not readline directly),
// so tests inject a scripted prompter and never touch stdin. The real one is created lazily and
// only on a TTY — non-interactive runs (pipes, CI) skip it entirely, and publishing there
// requires an explicit -y (the flag IS the consent when there's no confirm step).
//
// Ctrl+C: readline swallows SIGINT and merely PAUSES unless an 'SIGINT' listener exists (and a
// bare abort leaves the question() promise unsettled — nodejs/node#53497). So every question runs
// with an AbortSignal: mid-question ^C aborts it (the await rejects → PromptAborted, and the
// command prints its own "nothing happened" line + exit code 130); between questions (readline
// open but idle, e.g. during the POST or the sign-in's device flow) there is nothing to settle, so
// exit 130 directly.

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Drop what was typed while no question was pending, exported for the contract test in
 * prompt.test.ts. Called only at the waits a command announces (the sign-in's device flow, a POST
 * in flight), never between two prompts: readline hands over a whole stdin chunk at once, so a
 * paste of "Lilex<Enter>Catppuccin" leaves the second answer sitting here, and clearing before
 * every question would drop it. Left alone:
 *   • `line`/`cursor` — the text would sit after the next prompt with the cursor BEFORE it, so
 *     what the user types there joins it ("y" left over, "n" typed, answer "ny").
 *   • `prevRows` — readline's own row bookkeeping. Once idle text has wrapped, the next question
 *     moves the cursor up that many rows and erases downward, taking whatever was printed since
 *     with it (the profile card, right before the publish confirm).
 * `line` and `cursor` are documented readline state that readline reassigns itself; `prevRows` is
 * internal and absent from @types/node, so the cast goes through unknown. The `Pick` keeps the two
 * public names bound to Interface (a rename upstream fails typecheck); the untyped third is what
 * the behavioral test in prompt.test.ts is for.
 */
export function clearIdleInput(face: Interface): void {
  const state = face as unknown as Mutable<Pick<Interface, "line" | "cursor">> & {
    prevRows: number;
  };
  state.line = "";
  state.cursor = 0;
  state.prevRows = 0;
}

/** Thrown from ask/confirm/choice on Ctrl+C or Ctrl+D at the prompt, or when an earlier Ctrl+D
 *  already closed the input. */
export class PromptAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "PromptAborted";
  }
}

export interface Prompter {
  /** Ask for a value, offering `def` as the default; empty input returns `def`. `hint` is a faint
   *  parenthetical after the default, display only: it never changes what Enter returns. */
  ask(label: string, def?: string, hint?: string): Promise<string>;
  /** Yes/no question; empty input returns `defYes`. */
  confirm(question: string, defYes: boolean): Promise<boolean>;
  /** Single-letter choice: empty input returns `def`; unmatched input re-asks. `tight` skips the
   *  unit's opening blank line, for a question that continues a unit the caller already opened.
   *  `exact` takes only the letter itself or yes/no, for a question that shows words the user
   *  might type back: at `Zed → Neovim [Y/n]`, "neovim" must re-ask, never count as "n". */
  choice(
    question: string,
    keys: readonly string[],
    def: string,
    hint: string,
    opts?: { tight?: boolean; exact?: boolean },
  ): Promise<string>;
  /** Forget what was typed since the last question. Called after a wait the command announced
   *  (the device flow, a POST), so a key pressed there cannot answer the next question. */
  discardTypeahead(): void;
  close(): void;
}

/**
 * The rendered question line, exported for tests. Defaults carry env-detected or wire-fetched
 * values — the same UNTRUSTED rule as every other print path (render.ts) applies, and this was
 * the one print that skipped it: strip ANSI/control/bidi before the terminal sees the default.
 * With color off the line is byte-identical to the unstyled original. The hint is env-derived too
 * (a detected value), so it gets the same strip; one that sanitizes to nothing prints nothing,
 * never a bare `()`.
 */
export function promptLine(label: string, def?: string, color = false, hint?: string): string {
  const c = palette(color);
  const clean = def ? sanitizeValue(def) : def;
  const note = hint ? sanitizeValue(hint).trim() : "";
  return (
    `  ${c.faint}${label}${c.reset}${clean ? ` [${clean}]` : ""}` +
    `${note ? ` ${c.faint}(${note})${c.reset}` : ""}: `
  );
}

/**
 * Pure choice matcher, exported for tests: empty → `def`; otherwise the first letter of the
 * trimmed lowercased answer must be one of `keys` ("yes" matches "y", "EDIT" matches "e");
 * anything else → null (the caller re-asks). With `exact`, only the letter alone or yes/no match.
 * Keys must be unique single letters — a colliding or multi-char key is a programming error,
 * caught loudly at call time.
 */
export function matchChoice(
  answer: string,
  keys: readonly string[],
  def: string,
  exact = false,
): string | null {
  if (keys.some((k) => k.length !== 1) || new Set(keys).size !== keys.length) {
    throw new Error(`choice keys must be unique single letters: ${keys.join(",")}`);
  }
  const a = answer.trim().toLowerCase();
  if (a === "") return def;
  if (exact && a.length > 1 && a !== "yes" && a !== "no") return null;
  const first = a[0] as string;
  return keys.includes(first) ? first : null;
}

export function makePrompter(): Prompter {
  let rl: Interface | null = null;
  const color = colorEnabled();
  const c: Codes = palette(color);
  // One controller PER QUESTION (created in question(), cleared in its finally): a ^C landing in
  // the microtask gap after an answered question must not leave a flagged controller behind that
  // would instantly abort the NEXT question. `ac === null` therefore means "no question pending".
  let ac: AbortController | null = null;
  const io = (): Interface => {
    if (!rl) {
      // An idle interface (a POST, the sign-in's device flow) still redraws its prompt on a
      // terminal resize. readline's default "> " would then appear under the waiting line, so
      // idle on an empty one; each question sets its own.
      rl = createInterface({ input: stdin, output: stdout, prompt: "" });
      rl.on("SIGINT", () => {
        if (ac) ac.abort();
        else {
          stdout.write("\n");
          process.exit(130);
        }
      });
      // Ctrl+D: readline 'close' leaves a pending question() UNSETTLED (nodejs/node#53497
      // family) — the process would then exit 0 with no message, reading as success to
      // `ymmv && next`. Abort so EOF lands on the same PromptAborted path as ^C. An idle close
      // (EOF while no question is outstanding: during the POST, or the sign-in's device flow)
      // needs nothing here: a command that asks nothing more prints its own outcome, and a later
      // question finds the interface closed, which question() reads as the same abort.
      rl.on("close", () => {
        ac?.abort();
      });
      // fg after Ctrl+Z (not on Windows): readline pauses its input on SIGCONT and leaves the
      // resume to its owner. Left paused, ^C would do nothing and a held Enter would answer the
      // next question.
      rl.on("SIGCONT", () => rl?.resume());
    }
    return rl;
  };
  const question = async (query: string): Promise<string> => {
    const controller = new AbortController();
    ac = controller;
    try {
      return await io().question(query, { signal: controller.signal });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw new PromptAborted();
      // An interface an idle EOF closed (see the close handler): the same abort as EOF
      // mid-question, never a raw "readline was closed".
      if (e instanceof Error && "code" in e && e.code === "ERR_USE_AFTER_CLOSE") {
        throw new PromptAborted();
      }
      throw e;
    } finally {
      ac = null;
    }
  };
  return {
    async ask(label, def, hint) {
      // Empty input accepts the SANITIZED default — what you saw is what you accepted.
      const clean = def ? sanitizeValue(def) : def;
      const answer = (await question(promptLine(label, def, color, hint))).trim();
      return answer === "" ? (clean ?? "") : answer;
    },
    // Prompts are output units (render.ts convention): confirm/choice open with the unit's one
    // blank line here — never in the caller's question string. Field ask()s stay tight: the
    // walk is a single unit opened by its hint line. A `tight` choice skips the blank the
    // same way: publish's per-row questions are one unit, opened by the first of them.
    async confirm(q, defYes) {
      const answer = (await question(`\n  ${q} ${c.faint}[${defYes ? "Y/n" : "y/N"}]${c.reset} `))
        .trim()
        .toLowerCase();
      if (answer === "") return defYes;
      return answer === "y" || answer === "yes";
    },
    async choice(q, keys, def, hint, opts) {
      let prefix = opts?.tight ? "" : "\n";
      for (;;) {
        const hit = matchChoice(
          await question(`${prefix}  ${q} ${c.faint}[${hint}]${c.reset} `),
          keys,
          def,
          opts?.exact,
        );
        if (hit !== null) return hit;
        prefix = ""; // a re-ask continues the same question — stays tight under the failed answer
      }
    },
    discardTypeahead() {
      if (rl) clearIdleInput(rl);
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}
