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
// open but idle, e.g. during the POST) there is nothing to settle, so exit 130 directly.

/** Thrown from ask/confirm/choice when the user hits Ctrl+C at the prompt. */
export class PromptAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "PromptAborted";
  }
}

export interface Prompter {
  /** Ask for a value, offering `def` as the default; empty input returns `def`. */
  ask(label: string, def?: string): Promise<string>;
  /** Yes/no question; empty input returns `defYes`. */
  confirm(question: string, defYes: boolean): Promise<boolean>;
  /** Single-letter choice: empty input returns `def`; unmatched input re-asks. */
  choice(question: string, keys: readonly string[], def: string, hint: string): Promise<string>;
  close(): void;
}

/**
 * The rendered question line, exported for tests. Defaults carry env-detected or wire-fetched
 * values — the same UNTRUSTED rule as every other print path (render.ts) applies, and this was
 * the one print that skipped it: strip ANSI/control/bidi before the terminal sees the default.
 * With color off the line is byte-identical to the unstyled original.
 */
export function promptLine(label: string, def?: string, color = false): string {
  const c = palette(color);
  const clean = def ? sanitizeValue(def) : def;
  return `  ${c.faint}${label}${c.reset}${clean ? ` [${clean}]` : ""}: `;
}

/**
 * Pure choice matcher, exported for tests: empty → `def`; otherwise the first letter of the
 * trimmed lowercased answer must be one of `keys` ("yes" matches "y", "EDIT" matches "e");
 * anything else → null (the caller re-asks). Keys must be unique single letters — a colliding
 * or multi-char key is a programming error, caught loudly at call time.
 */
export function matchChoice(answer: string, keys: readonly string[], def: string): string | null {
  if (keys.some((k) => k.length !== 1) || new Set(keys).size !== keys.length) {
    throw new Error(`choice keys must be unique single letters: ${keys.join(",")}`);
  }
  const a = answer.trim().toLowerCase();
  if (a === "") return def;
  const first = a[0] as string;
  return keys.includes(first) ? first : null;
}

export function makePrompter(): Prompter {
  let rl: Interface | null = null;
  const color = colorEnabled();
  const c: Codes = palette(color);
  const ac = new AbortController();
  let pending = false;
  const io = (): Interface => {
    if (!rl) {
      rl = createInterface({ input: stdin, output: stdout });
      rl.on("SIGINT", () => {
        if (pending) ac.abort();
        else {
          stdout.write("\n");
          process.exit(130);
        }
      });
    }
    return rl;
  };
  const question = async (query: string): Promise<string> => {
    pending = true;
    try {
      return await io().question(query, { signal: ac.signal });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw new PromptAborted();
      throw e;
    } finally {
      pending = false;
    }
  };
  return {
    async ask(label, def) {
      // Empty input accepts the SANITIZED default — what you saw is what you accepted.
      const clean = def ? sanitizeValue(def) : def;
      const answer = (await question(promptLine(label, def, color))).trim();
      return answer === "" ? (clean ?? "") : answer;
    },
    async confirm(q, defYes) {
      const answer = (await question(`  ${q} ${c.faint}[${defYes ? "Y/n" : "y/N"}]${c.reset} `))
        .trim()
        .toLowerCase();
      if (answer === "") return defYes;
      return answer === "y" || answer === "yes";
    },
    async choice(q, keys, def, hint) {
      for (;;) {
        const hit = matchChoice(await question(`  ${q} ${c.faint}[${hint}]${c.reset} `), keys, def);
        if (hit !== null) return hit;
      }
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}
