import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { sanitizeValue } from "./render.js";

// Thin readline wrapper. The commands depend on the `Prompter` INTERFACE (not readline directly),
// so tests inject a scripted prompter and never touch stdin. The real one is created lazily and
// only on a TTY — non-interactive runs (pipes, CI) skip it entirely, and publishing there
// requires an explicit -y (the flag IS the consent when there's no confirm step).

export interface Prompter {
  /** Ask for a value, offering `def` as the default; empty input returns `def`. */
  ask(label: string, def?: string): Promise<string>;
  /** Yes/no question; empty input returns `defYes`. */
  confirm(question: string, defYes: boolean): Promise<boolean>;
  close(): void;
}

/**
 * The rendered question line, exported for tests. Defaults carry env-detected or wire-fetched
 * values — the same UNTRUSTED rule as every other print path (render.ts) applies, and this was
 * the one print that skipped it: strip ANSI/control/bidi before the terminal sees the default.
 */
export function promptLine(label: string, def?: string): string {
  const clean = def ? sanitizeValue(def) : def;
  return `  ${label}${clean ? ` [${clean}]` : ""}: `;
}

export function makePrompter(): Prompter {
  let rl: Interface | null = null;
  const io = (): Interface => {
    rl ??= createInterface({ input: stdin, output: stdout });
    return rl;
  };
  return {
    async ask(label, def) {
      // Empty input accepts the SANITIZED default — what you saw is what you accepted.
      const clean = def ? sanitizeValue(def) : def;
      const answer = (await io().question(promptLine(label, def))).trim();
      return answer === "" ? (clean ?? "") : answer;
    },
    async confirm(question, defYes) {
      const answer = (await io().question(`  ${question} ${defYes ? "[Y/n]" : "[y/N]"} `))
        .trim()
        .toLowerCase();
      if (answer === "") return defYes;
      return answer === "y" || answer === "yes";
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}
