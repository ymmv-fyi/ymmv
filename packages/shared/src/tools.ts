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
  { key: "terminal", canonical: "kitty", envTokens: ["kitty"] }, // kitty refuses TERM_PROGRAM (its issue #3317); detect.ts probes KITTY_WINDOW_ID instead — token kept for the day that changes
  { key: "terminal", canonical: "Tabby", envTokens: ["tabby"] },
  { key: "terminal", canonical: "Warp", envTokens: ["warpterminal"] }, // `warpterminal` env id ≠ typed "Warp"
  { key: "terminal", canonical: "GNOME Console", envTokens: ["kgx"] }, // $TERM_PROGRAM=kgx since GNOME 45
  { key: "terminal", canonical: "mintty", envTokens: ["mintty"] }, // Git Bash/MSYS2 console, ≥3.1.5
  { key: "terminal", canonical: "Zed", envTokens: ["zed"] }, // Zed's built-in terminal (~0.145+)

  // ── browser (envTokens mirror BROWSER_NAMES: $BROWSER basenames) ──────────
  { key: "browser", canonical: "Firefox", envTokens: ["firefox"], aliases: ["ff"] },
  // Hyphenated Linux binary names double as diff aliases (kde/plasma precedent): unlike `vi`,
  // each unambiguously names exactly that browser, so a TYPED "google-chrome" should diff-equal
  // a DETECTED "Chrome".
  {
    key: "browser",
    canonical: "Chrome",
    envTokens: ["chrome", "google-chrome"],
    aliases: ["google chrome", "google-chrome"], // NOT Chromium — distinct browser
  },
  {
    key: "browser",
    canonical: "Edge",
    envTokens: ["msedge", "microsoft-edge"],
    aliases: ["microsoft edge", "microsoft-edge"],
  },
  {
    key: "browser",
    canonical: "Chromium",
    envTokens: ["chromium", "chromium-browser"],
    aliases: ["chromium-browser"],
  },
  {
    key: "browser",
    canonical: "Brave",
    envTokens: ["brave", "brave-browser"],
    aliases: ["brave-browser"],
  },
  { key: "browser", canonical: "LibreWolf", envTokens: ["librewolf"] },
  {
    key: "browser",
    canonical: "Vivaldi",
    envTokens: ["vivaldi", "vivaldi-stable"],
    aliases: ["vivaldi-stable"],
  },
  { key: "browser", canonical: "Zen", envTokens: ["zen", "zen-browser"], aliases: ["zen-browser"] },
  { key: "browser", canonical: "qutebrowser", envTokens: ["qutebrowser"] },

  // ── window-manager (envTokens mirror WM_NAMES: XDG_CURRENT_DESKTOP list entries +
  //    DESKTOP_SESSION basenames, lowercased). Deliberate: canonical names are what users put on
  //    profiles — the DE name (GNOME, KDE Plasma), not its compositor (Mutter, KWin). Compositors
  //    with their own socket vars (Hyprland/Sway/i3/niri) are ALSO probed directly in detect.ts;
  //    WMs with no env footprint at all (river, bspwm, dwm, Qtile, awesome) have no tokens — a
  //    dead token would only inflate the pinned detector fixtures. ──────────
  { key: "window-manager", canonical: "GNOME", envTokens: ["gnome"] },
  {
    key: "window-manager",
    canonical: "KDE Plasma",
    envTokens: ["kde", "plasma"],
    aliases: ["kde", "plasma"],
  },
  { key: "window-manager", canonical: "Hyprland", envTokens: ["hyprland"] },
  { key: "window-manager", canonical: "Sway", envTokens: ["sway"] },
  { key: "window-manager", canonical: "i3", envTokens: ["i3"] },
  { key: "window-manager", canonical: "niri", envTokens: ["niri"] },
  { key: "window-manager", canonical: "COSMIC", envTokens: ["cosmic"] },
  { key: "window-manager", canonical: "Cinnamon", envTokens: ["cinnamon", "x-cinnamon"] },
  { key: "window-manager", canonical: "MATE", envTokens: ["mate"] },
  { key: "window-manager", canonical: "XFCE", envTokens: ["xfce"] },
  { key: "window-manager", canonical: "LXQt", envTokens: ["lxqt"] },
  { key: "window-manager", canonical: "Budgie", envTokens: ["budgie"] },
  { key: "window-manager", canonical: "Pantheon", envTokens: ["pantheon"] },
  { key: "window-manager", canonical: "Unity", envTokens: ["unity"] },

  // ── prompt (presence-detected in detect.ts — entries exist for diff aliases only; fold
  //    already equates case/space variants, so single-word tools need no entry) ──
  { key: "prompt", canonical: "Powerlevel10k", aliases: ["p10k"] }, // NOT p9k — distinct predecessor
  { key: "prompt", canonical: "Oh My Posh", aliases: ["oh-my-posh", "omp"] }, // hyphens survive fold

  // ── theme (never detected — aliases for spellings fold can't equate: hyphens + the é) ──
  { key: "theme", canonical: "Rosé Pine", aliases: ["rose pine", "rose-pine"] },
  { key: "theme", canonical: "Tokyo Night", aliases: ["tokyo-night"] },
  { key: "theme", canonical: "One Dark", aliases: ["one-dark"] },

  // ── diff-only synonyms (no detector for these fields) ─────────────────────
  { key: "os", canonical: "macOS", aliases: ["osx", "os x", "mac"] },
  { key: "os", canonical: "Windows", aliases: ["win"] },
  { key: "os", canonical: "Arch Linux", aliases: ["arch"] }, // os-release NAME= vs what people type
  { key: "multiplexer", canonical: "GNU Screen", aliases: ["screen"] }, // matches detector's "GNU Screen"
];
