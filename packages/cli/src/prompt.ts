import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";

// Thin readline wrapper. The commands depend on the `Prompter` INTERFACE (not readline directly),
// so tests inject a scripted prompter and never touch stdin. The real one is created lazily and
// only on a TTY — non-interactive runs (pipes, CI) skip it entirely and publish detected values.

export interface Prompter {
  /** Ask for a value, offering `def` as the default; empty input returns `def`. */
  ask(label: string, def?: string): Promise<string>;
  /** Yes/no question; empty input returns `defYes`. */
  confirm(question: string, defYes: boolean): Promise<boolean>;
  close(): void;
}

export function makePrompter(): Prompter {
  let rl: Interface | null = null;
  const io = (): Interface => {
    rl ??= createInterface({ input: stdin, output: stdout });
    return rl;
  };
  return {
    async ask(label, def) {
      const answer = (await io().question(`  ${label}${def ? ` [${def}]` : ""}: `)).trim();
      return answer === "" ? (def ?? "") : answer;
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
