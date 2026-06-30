/**
 * Curated key taxonomy — the comparable core of a ymmv profile.
 *
 * Order is display order (the CLI diff + the web spec sheet render in this sequence).
 * The list is locked deliberately: each key is a column the diff can compare, so it's
 * chosen for signal, not completeness. Free-form `extras` cover everything else and
 * never diff.
 */
export const CURATED_KEYS = [
  "editor",
  "os",
  "shell",
  "terminal",
  "browser",
  "window-manager",
  "font",
  "multiplexer",
  "dotfiles",
  "ai-tool",
] as const;

export type CuratedKey = (typeof CURATED_KEYS)[number];

/** Human-readable label per curated key (shared by the CLI diff + the web spec sheet). */
export const KEY_LABELS: Record<CuratedKey, string> = {
  editor: "Editor",
  os: "OS",
  shell: "Shell",
  terminal: "Terminal",
  browser: "Browser",
  "window-manager": "Window Manager",
  font: "Font",
  multiplexer: "Multiplexer",
  dotfiles: "Dotfiles",
  "ai-tool": "AI Tool",
};

const CURATED_KEY_SET: ReadonlySet<string> = new Set(CURATED_KEYS);

/** Type guard: is `value` one of the curated keys? */
export function isCuratedKey(value: string): value is CuratedKey {
  return CURATED_KEY_SET.has(value);
}
