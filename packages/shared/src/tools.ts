/**
 * Tool catalog — the single source of truth for tool identity across the monorepo.
 *
 * Two very different consumers derive their own lookup shape from ONE list, so the tool-name
 * knowledge lives in exactly one place (no drift between the CLI detector and the diff):
 *
 *     TOOLS ──┬─► detect.ts  : envToken(lowercased) → canonical   (publish-time default fill)
 *             └─► normalize.ts: fold(alias|canonical) → fold(canonical)  (diff-time identity)
 *
 * Per entry:
 *  - `canonical`  the display name — what the detector emits as a default and what a value
 *                 folds toward for diffing.
 *  - `envTokens`  environment identifiers the DETECTOR recognizes ($SHELL/$TERM_PROGRAM/$EDITOR
 *                 basenames, lowercased). DETECTOR-ONLY: an env heuristic is not proof two users
 *                 mean the same tool, so these are NOT diff aliases (`vi`≠`Vim` at diff time).
 *  - `aliases`    curated human spelling variants the DIFF treats as the same tool. A token may
 *                 also appear in `envTokens` when it is genuinely both (e.g. "nvim", "pwsh").
 *
 * RULES (guarded by tests):
 *  - ONE entry per DISTINCT tool. Never group distinct tools: Vim ≠ Neovim, Chrome ≠ Chromium,
 *    VS Code ≠ VS Code Insiders. No version numbers (macOS 15.2 ≠ 15.4 stays a real difference).
 *  - `envTokens` here must reproduce detect.ts's current maps exactly (pinned by detect.test.ts).
 */
import type { CuratedKey } from "./keys.js";

export interface Tool {
  key: CuratedKey;
  canonical: string;
  envTokens?: string[];
  aliases?: string[];
}

export const TOOLS: Tool[] = [
  // ── editor (envTokens mirror EDITOR_NAMES) ────────────────────────────────
  { key: "editor", canonical: "Neovim", envTokens: ["nvim"], aliases: ["nvim"] },
  { key: "editor", canonical: "Vim", envTokens: ["vim", "vi"] }, // `vi` is a detector default only, not a diff alias
  {
    key: "editor",
    canonical: "VS Code",
    envTokens: ["code"],
    // NOT "code": elementary OS ships a distinct editor literally named "Code", so bare "code"
    // is ambiguous as a diff alias (it stays an envToken — detecting $EDITOR=code as VS Code is fine).
    aliases: ["vscode", "vsc", "visual studio code"],
  },
  { key: "editor", canonical: "VS Code Insiders", envTokens: ["code-insiders"] },
  { key: "editor", canonical: "VSCodium", envTokens: ["codium"] },
  { key: "editor", canonical: "Emacs", envTokens: ["emacs"] },
  { key: "editor", canonical: "Nano", envTokens: ["nano"] },
  { key: "editor", canonical: "Helix", envTokens: ["hx", "helix"], aliases: ["hx"] },
  { key: "editor", canonical: "Sublime Text", envTokens: ["subl"], aliases: ["subl", "sublime"] },
  { key: "editor", canonical: "Micro", envTokens: ["micro"] },
  { key: "editor", canonical: "IntelliJ IDEA", envTokens: ["idea"], aliases: ["idea", "intellij"] },
  { key: "editor", canonical: "Zed", envTokens: ["zed"] },
  { key: "editor", canonical: "Pico", envTokens: ["pico"] },

  // ── shell (envTokens mirror SHELL_NAMES) ──────────────────────────────────
  { key: "shell", canonical: "zsh", envTokens: ["zsh"] },
  { key: "shell", canonical: "bash", envTokens: ["bash"] },
  { key: "shell", canonical: "fish", envTokens: ["fish"] },
  { key: "shell", canonical: "sh", envTokens: ["sh"] },
  { key: "shell", canonical: "dash", envTokens: ["dash"] },
  { key: "shell", canonical: "ksh", envTokens: ["ksh"] },
  { key: "shell", canonical: "tcsh", envTokens: ["tcsh"] },
  { key: "shell", canonical: "csh", envTokens: ["csh"] },
  { key: "shell", canonical: "Nushell", envTokens: ["nu", "nushell"], aliases: ["nu"] },
  { key: "shell", canonical: "PowerShell", envTokens: ["pwsh", "powershell"], aliases: ["pwsh"] },
  { key: "shell", canonical: "Elvish", envTokens: ["elvish"] },
  { key: "shell", canonical: "xonsh", envTokens: ["xonsh"] },

  // ── terminal (envTokens mirror TERM_PROGRAMS) ─────────────────────────────
  { key: "terminal", canonical: "iTerm2", envTokens: ["iterm.app"], aliases: ["iterm"] },
  { key: "terminal", canonical: "Terminal", envTokens: ["apple_terminal"] }, // "terminal" too generic to alias
  { key: "terminal", canonical: "VS Code", envTokens: ["vscode"] }, // integrated terminal ($TERM_PROGRAM=vscode)
  { key: "terminal", canonical: "WezTerm", envTokens: ["wezterm"] },
  { key: "terminal", canonical: "Ghostty", envTokens: ["ghostty"] },
  { key: "terminal", canonical: "Hyper", envTokens: ["hyper"] },
  { key: "terminal", canonical: "Rio", envTokens: ["rio"] },
  { key: "terminal", canonical: "kitty", envTokens: ["kitty"] },
  { key: "terminal", canonical: "Tabby", envTokens: ["tabby"] },
  { key: "terminal", canonical: "Warp", envTokens: ["warpterminal"] }, // `warpterminal` env id ≠ typed "Warp"

  // ── diff-only synonyms (no detector for these fields) ─────────────────────
  { key: "browser", canonical: "Firefox", aliases: ["ff"] },
  { key: "browser", canonical: "Chrome", aliases: ["google chrome"] }, // NOT Chromium — distinct browser
  { key: "browser", canonical: "Edge", aliases: ["microsoft edge"] },
  { key: "os", canonical: "macOS", aliases: ["osx", "os x", "mac"] },
  { key: "os", canonical: "Windows", aliases: ["win"] },
  { key: "multiplexer", canonical: "GNU Screen", aliases: ["screen"] }, // matches detector's "GNU Screen"
];
