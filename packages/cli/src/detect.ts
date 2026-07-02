import { type CuratedKey, TOOLS } from "@ymmv/shared";

// Lightweight env detector. Reads ONLY environment variables + the Node platform — no
// `systeminformation`, no process scanning, no child processes (that library solved the unreliable
// half and bloats the npx download). ONE sanctioned exception: an injected /etc/os-release read
// (see DetectOpts) so Linux profiles can name their distro. Everything here is best-effort and
// user-correctable: detection fills what it can and stays silent on the rest, and it NEVER throws —
// publish must not block on it. In a TTY the user confirms/edits every value before anything is
// sent; a non-interactive publish takes these as defaults (existing published values still win).
//
// Accepted limit: env vars inherit into nested sessions (a shell launched from another terminal or
// IDE keeps the parent's markers, tmux server env pins the first client's; cmd-from-pwsh reads as
// PowerShell and pwsh-from-cmd can read as cmd), so a probe can name the outer host. Explicit host declarations ($TERM_PROGRAM, $TERMINAL_EMULATOR) therefore outrank
// presence vars, and presence vars outrank $TERM. Markers source-verified 2026-07; notable traps:
// kitty refuses $TERM_PROGRAM (probe KITTY_WINDOW_ID), foot UNSETS it (probe $TERM=foot), Amp sets
// CLAUDECODE=1 too (check AGENT=amp first), POWERSHELL_DISTRIBUTION_CHANNEL is a machine-wide
// installer var visible in cmd.exe (NOT a PowerShell marker — use PSModulePath's first segment).

type Env = Record<string, string | undefined>;

/**
 * Optional host capabilities. `readTextFile` is the ONE sanctioned exception to env-only
 * detection: a guarded read of /etc/os-release (a stable freedesktop path) so Linux profiles can
 * say "Arch Linux" instead of "Linux". Injected by the caller so this module stays fs-free and
 * fully unit-testable; omitted (the default) means strictly env + platform, as before.
 */
export interface DetectOpts {
  readTextFile?: (path: string) => string;
}

/** Last path segment, with a trailing `.exe` stripped (`/usr/bin/zsh` → `zsh`, `pwsh.exe` → `pwsh`). */
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return name.replace(/\.exe$/i, "");
}

/** First whitespace-delimited token (`code --wait` → `code`). */
function firstToken(s: string): string {
  return s.trim().split(/\s+/)[0] ?? "";
}

// Detector name maps derived from the shared TOOLS catalog (single source of truth — see
// tools.ts): envToken (lowercased) → canonical display name. Exact equivalence to the previous
// hardcoded maps is pinned by detect.test.ts, so a TOOLS edit can't silently drop a mapping.
const namesFor = (key: CuratedKey): Record<string, string> => {
  // Null prototype: these maps are indexed with RAW env-derived strings, and on a plain object a
  // value like "__proto__"/"constructor" would resolve a truthy Object.prototype member — set()
  // then throws on .trim() and the module catch silently aborts every later probe. Same defense
  // normalize.ts ships for the diff-side alias lookup.
  const map: Record<string, string> = Object.create(null);
  for (const tool of TOOLS) {
    if (tool.key !== key) continue;
    for (const token of tool.envTokens ?? []) map[token] = tool.canonical;
  }
  return map;
};

const SHELL_NAMES = namesFor("shell");
const EDITOR_NAMES = namesFor("editor");
const TERM_PROGRAMS = namesFor("terminal");
const BROWSER_NAMES = namesFor("browser");
const WM_NAMES = namesFor("window-manager");

// The one $TERM carve-out, checked DEAD LAST. Generic terminfo names (xterm-256color, screen…)
// stay banned — they name a protocol, not a terminal anyone would put on a profile. These exact
// values are different: each is set by one specific terminal about itself, and over SSH they're
// the only surviving signal (and still truthfully name the LOCAL terminal). foot is here because
// it has no other footprint — it deliberately UNSETS $TERM_PROGRAM (≥1.14) rather than set one.
const TERM_EXACT: Record<string, string> = Object.assign(Object.create(null), {
  "xterm-kitty": "kitty",
  "xterm-ghostty": "Ghostty",
  foot: "foot",
  alacritty: "Alacritty",
});

// $BROWSER values that are launchers/dispatchers, not browsers — publishing "xdg-open" as
// someone's browser would be nonsense. browser.sh/.cmd are VS Code Remote's port-forward helpers.
const BROWSER_DISPATCHERS = new Set([
  "xdg-open",
  "wslview",
  "sensible-browser",
  "x-www-browser",
  "www-browser",
  "open",
  "gio",
  "browser.sh",
  "browser.cmd",
]);

/**
 * Distro name from /etc/os-release (`NAME=`, quotes stripped) — "Arch Linux", "NixOS", "Fedora
 * Linux". NAME over PRETTY_NAME deliberately: PRETTY_NAME carries point versions ("Ubuntu 24.04.2
 * LTS") that go stale and make diffs noisy; the catalog rule is tool names, no versions.
 */
function linuxDistro(read: DetectOpts["readTextFile"]): string | undefined {
  if (!read) return undefined;
  try {
    const line = read("/etc/os-release")
      .split("\n")
      .find((l) => l.startsWith("NAME="));
    // The os-release spec allows single- OR double-quoted values.
    const name = line
      ?.slice("NAME=".length)
      .trim()
      .replace(/^["']|["']$/g, "");
    return name?.trim() || undefined;
  } catch {
    return undefined; // missing/unreadable file → fall back to the coarse label
  }
}

function detectOS(env: Env, platform: NodeJS.Platform, opts: DetectOpts): string | undefined {
  // A WSL distro is more useful than a bare "Linux" (and beats os-release — the env var names the
  // running distro). Gated on linux: WSL_DISTRO_NAME leaks into WINDOWS processes launched from a
  // WSL shell via interop, and those are running on Windows, not in the distro.
  if (platform === "linux" && env.WSL_DISTRO_NAME) return `${env.WSL_DISTRO_NAME} (WSL)`;
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return linuxDistro(opts.readTextFile) ?? "Linux";
    default:
      return platform;
  }
}

function detectShell(env: Env, platform: NodeJS.Platform): string | undefined {
  const raw = env.SHELL ?? env.STARSHIP_SHELL;
  if (raw) {
    const key = basename(raw).toLowerCase();
    return SHELL_NAMES[key] ?? basename(raw);
  }
  // Windows rarely sets $SHELL; infer from what the session exposes. PSModulePath alone proves
  // nothing — its machine-wide default (an HKLM var) is visible even in cmd.exe. What IS a session
  // marker: PowerShell (5.1 and 7+) prepends the user's Documents module dir at startup, so the
  // FIRST segment names the running shell. (POWERSHELL_DISTRIBUTION_CHANNEL is likewise an MSI
  // installer var, machine-wide — deliberately unused.)
  if (platform === "win32") {
    const firstSeg = env.PSModulePath?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (/[\\/]documents[\\/](windows)?powershell[\\/]modules$/.test(firstSeg)) return "PowerShell";
    // cmd.exe defines PROMPT ($P$G) in its own environment block; a fresh PowerShell doesn't.
    if (env.PROMPT) return env.ComSpec ? basename(env.ComSpec) : "cmd";
    if (env.PSModulePath) return "PowerShell"; // redirected-Documents PowerShell lands here
    if (env.ComSpec) return basename(env.ComSpec);
  }
  return undefined;
}

function detectTerminal(env: Env): string | undefined {
  const tp = env.TERM_PROGRAM?.trim();
  // TERM_PROGRAM=tmux means we're inside tmux (≥3.2 REPLACES the host terminal's value) — the real
  // terminal is unknown via TERM_PROGRAM, so fall through to the presence probes below, which the
  // host terminal's own vars survive into.
  if (tp && tp.toLowerCase() !== "tmux") {
    // Cursor's integrated terminal keeps the fork's TERM_PROGRAM=vscode; CURSOR_TRACE_ID is the
    // ecosystem-standard discriminator (gh, turborepo, bun all key on it).
    if (tp.toLowerCase() === "vscode" && env.CURSOR_TRACE_ID) return "Cursor";
    return TERM_PROGRAMS[tp.toLowerCase()] ?? tp;
  }
  // JediTerm is the terminal of every JetBrains IDE — same value for all of them, so the display
  // name stays the family name.
  if (env.TERMINAL_EMULATOR === "JetBrains-JediTerm") return "JetBrains";
  if (env.WT_SESSION) return "Windows Terminal";
  if (env.KONSOLE_VERSION) return "Konsole";
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return "Alacritty";
  if (env.KITTY_WINDOW_ID || env.KITTY_PID) return "kitty"; // kitty refuses TERM_PROGRAM (its #3317)
  if (env.GNOME_TERMINAL_SERVICE || env.GNOME_TERMINAL_SCREEN) return "GNOME Terminal";
  if (env.TILIX_ID) return "Tilix";
  if (env.TERMINATOR_UUID) return "Terminator";
  if (env.ConEmuANSI || env.ConEmuPID) return "ConEmu";
  if (env.XTERM_VERSION) return "xterm";
  // Deliberately NOT falling back to $TERM in general (e.g. "xterm-256color") — that's a terminfo
  // name, not a terminal anyone would put on their profile. Exact self-identifying values only:
  const t = env.TERM?.trim().toLowerCase();
  if (t && TERM_EXACT[t]) return TERM_EXACT[t];
  return undefined;
}

function detectEditor(env: Env): string | undefined {
  const raw = env.VISUAL ?? env.EDITOR; // VISUAL is the "full-screen" editor by convention.
  if (raw) {
    const bin = basename(firstToken(raw));
    return EDITOR_NAMES[bin.toLowerCase()] ?? bin;
  }
  // No $VISUAL/$EDITOR: publishing from INSIDE an editor's terminal is itself a strong signal.
  // Order matters — Neovim exports VIM/VIMRUNTIME to :terminal children too, so NVIM (its server
  // socket, ≥0.8) must win before Vim's own marker; VIM_TERMINAL (not bare VIM/VIMRUNTIME, which
  // any `:!` child inherits ambiguously) is the Vim :terminal marker.
  if (env.NVIM) return "Neovim";
  if (env.VIM_TERMINAL) return "Vim";
  if (env.INSIDE_EMACS) return "Emacs";
  if (env.CURSOR_TRACE_ID) return "Cursor"; // before vscode — Cursor keeps TERM_PROGRAM=vscode
  const tp = env.TERM_PROGRAM?.trim().toLowerCase();
  if (tp === "vscode") return "VS Code";
  if (tp === "zed" || env.ZED_TERM === "true") return "Zed"; // ZED_TERM predates its TERM_PROGRAM (~0.145)
  return undefined;
}

function detectMultiplexer(env: Env): string | undefined {
  if (env.TMUX) return "tmux";
  if (env.ZELLIJ) return "Zellij"; // literal value is "0" — presence check, never truthy-parse it
  if (env.STY) return "GNU Screen";
  return undefined;
}

function detectPrompt(env: Env): string | undefined {
  // Prompt RENDERERS only — frameworks (oh-my-zsh) deliberately unmapped: an omz user's actual
  // prompt is usually one of these anyway, and "framework" isn't what the field asks.
  if (env.STARSHIP_SHELL || env.STARSHIP_SESSION_KEY) return "Starship";
  // POSH_THEME died in Oh My Posh v27; kept as a legacy corroborator behind the current pair.
  if (env.POSH_SHELL || env.POSH_SESSION_ID || env.POSH_THEME) return "Oh My Posh";
  if (env.P9K_TTY || env._P9K_TTY) return "Powerlevel10k";
  if (env.SPACESHIP_VERSION) return "Spaceship";
  if (Object.keys(env).some((k) => k.startsWith("_tide_"))) return "Tide"; // fish's Tide caches via exported _tide_* vars
  return undefined; // Pure exports nothing — stays manual
}

function detectVersionManager(env: Env): string | undefined {
  // Polyglot managers outrank per-runtime ones: an activated mise plus a lingering NVM_DIR from
  // old dotfiles means mise. Shims-in-PATH covers the modes that set no vars at all (mise shims
  // mode; asdf ≥0.16, whose Go rewrite dropped ASDF_DIR).
  const path = env.PATH ?? "";
  if (env.MISE_SHELL || env.__MISE_ORIG_PATH || /[\\/]mise[\\/]shims/i.test(path)) return "mise";
  if (env.ASDF_DIR || env.ASDF_DATA_DIR || /\.asdf[\\/]shims/i.test(path)) return "asdf";
  if (env.PROTO_HOME) return "proto";
  if (env.VOLTA_HOME) return "Volta"; // Unix-only marker; the Windows installer sets no var
  if (env.FNM_MULTISHELL_PATH || env.FNM_DIR) return "fnm";
  if (env.NVM_DIR) return "nvm";
  if (env.PYENV_SHELL || env.PYENV_ROOT) return "pyenv";
  if (env.RBENV_SHELL || env.RBENV_ROOT) return "rbenv";
  return undefined;
}

function detectWindowManager(env: Env): string | undefined {
  // Compositor sockets first — session-scoped and unambiguous. Sway also sets I3SOCK for i3-msg
  // compatibility, so SWAYSOCK must win before I3SOCK.
  if (env.HYPRLAND_INSTANCE_SIGNATURE) return "Hyprland";
  if (env.NIRI_SOCKET) return "niri";
  if (env.SWAYSOCK) return "Sway";
  if (env.I3SOCK) return "i3";
  // XDG_CURRENT_DESKTOP is a COLON-SEPARATED list ("ubuntu:GNOME", "Budgie:GNOME",
  // "Unity:Unity7:ubuntu") — match entries left-to-right, never the whole string. Values map to DE
  // names (GNOME, KDE Plasma), which is what people put on profiles — not the compositor (Mutter).
  for (const part of env.XDG_CURRENT_DESKTOP?.split(":") ?? []) {
    const hit = WM_NAMES[part.trim().toLowerCase()];
    if (hit) return hit;
  }
  // DESKTOP_SESSION can be a bare name or a full xsession path; unlike editor/browser there is NO
  // raw passthrough — session names ("ubuntu", "default") aren't tool names, so a miss stays blank.
  const ds = env.DESKTOP_SESSION;
  if (ds) {
    const hit = WM_NAMES[basename(ds).toLowerCase()];
    if (hit) return hit;
  }
  if (env.KDE_FULL_SESSION || env.KDE_SESSION_VERSION) return "KDE Plasma";
  // macOS/Windows tilers (yabai, AeroSpace, komorebi, GlazeWM) export nothing into ordinary
  // shells — env-based WM detection is effectively Linux/BSD-only. Leave blank, let the user fill.
  return undefined;
}

function detectBrowser(env: Env): string | undefined {
  // Pure user convention — nothing sets $BROWSER automatically (except VS Code Remote's helper
  // script, which the dispatcher set filters out). Rarely present, but free signal when it is.
  const raw = env.BROWSER;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  // A Windows path is ONE candidate: its drive-letter colon is not a list separator, and its
  // spaces ("Program Files") are path characters, not argument separators — basename the whole
  // value instead of token-splitting it.
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes("\\")) {
    const bin = basename(trimmed);
    if (!bin || BROWSER_DISPATCHERS.has(bin.toLowerCase())) return undefined;
    return BROWSER_NAMES[bin.toLowerCase()] ?? bin;
  }
  // Otherwise $BROWSER may be a colon-separated fallback LIST ("xdg-open:firefox") — take the
  // first entry that names an actual browser.
  for (const candidate of trimmed.split(":")) {
    const bin = basename(firstToken(candidate)); // "firefox %s" → "firefox"
    if (!bin) continue;
    if (BROWSER_DISPATCHERS.has(bin.toLowerCase())) continue;
    const hit = BROWSER_NAMES[bin.toLowerCase()];
    if (hit) return hit;
    // POSIX paths carry spaces too ("/Applications/Google Chrome.app/…/Google Chrome"): when the
    // token parse missed the map, retry the whole candidate (placeholder args stripped) so the
    // binary's real name survives instead of a word fragment ("Google").
    if (candidate.startsWith("/") && /\s/.test(candidate.trim())) {
      const whole = basename(candidate.trim().replace(/\s+%[a-zA-Z].*$/, ""));
      if (whole && !whole.includes("/")) return BROWSER_NAMES[whole.toLowerCase()] ?? whole;
    }
    return bin;
  }
  return undefined;
}

function detectAiTool(env: Env): string | undefined {
  // Fires when publishing from inside the tool's own session — common for this CLI's audience.
  // AGENT=amp must precede CLAUDECODE: Amp sets BOTH (and opencode sets AGENT=1, so only the exact
  // value "amp" means Amp — bare AGENT presence means nothing).
  if (env.AGENT?.trim().toLowerCase() === "amp") return "Amp";
  if (env.CLAUDECODE) return "Claude Code"; // first-party documented marker
  if (env.CODEX_THREAD_ID) return "Codex";
  if (env.GEMINI_CLI) return "Gemini CLI";
  if (env.OPENCODE) return "opencode";
  if (env.COPILOT_CLI) return "GitHub Copilot";
  // Last: CURSOR_TRACE_ID marks Cursor's whole IDE terminal, so any agent CLI running inside it
  // sets its own (more specific) marker above. CURSOR_AGENT is cursor-agent's own session var.
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return "Cursor";
  return undefined;
}

/**
 * Best-effort curated-key values from the environment. Returns only the keys it could detect with
 * confidence (os/shell/prompt/terminal/editor/multiplexer/version-manager/window-manager/browser/
 * ai-tool); the rest (font, theme, dotfiles) are prompted. Wrapped so a surprise from any probe
 * can never block publish.
 */
export function detectStack(
  env: Env,
  platform: NodeJS.Platform,
  opts: DetectOpts = {},
): Map<CuratedKey, string> {
  const out = new Map<CuratedKey, string>();
  const set = (key: CuratedKey, value: string | undefined): void => {
    if (value?.trim()) out.set(key, value.trim());
  };
  try {
    set("os", detectOS(env, platform, opts));
    set("shell", detectShell(env, platform));
    set("prompt", detectPrompt(env));
    set("terminal", detectTerminal(env));
    set("editor", detectEditor(env));
    set("multiplexer", detectMultiplexer(env));
    set("version-manager", detectVersionManager(env));
    set("window-manager", detectWindowManager(env));
    set("browser", detectBrowser(env));
    set("ai-tool", detectAiTool(env));
  } catch {
    // Detection is a convenience, never a gate — return whatever we got.
  }
  return out;
}
