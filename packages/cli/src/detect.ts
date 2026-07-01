import { type CuratedKey, TOOLS } from "@ymmv/shared";

// Lightweight env detector. Reads ONLY environment variables + the Node platform — no
// `systeminformation`, no process scanning, no child processes (that library solved the unreliable
// half and bloats the npx download). Everything here is best-effort and user-correctable: detection
// fills what it can and stays silent on the rest, and it NEVER throws — publish must not block on it.
// The user confirms/edits every value before anything is sent.

type Env = Record<string, string | undefined>;

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
  const map: Record<string, string> = {};
  for (const tool of TOOLS) {
    if (tool.key !== key) continue;
    for (const token of tool.envTokens ?? []) map[token] = tool.canonical;
  }
  return map;
};

const SHELL_NAMES = namesFor("shell");
const EDITOR_NAMES = namesFor("editor");
const TERM_PROGRAMS = namesFor("terminal");

function detectOS(env: Env, platform: NodeJS.Platform): string | undefined {
  // A WSL distro is more useful than a bare "Linux".
  if (env.WSL_DISTRO_NAME) return `${env.WSL_DISTRO_NAME} (WSL)`;
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
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
  // Windows rarely sets $SHELL; infer from what the session exposes.
  if (platform === "win32") {
    if (env.PSModulePath) return "PowerShell";
    if (env.ComSpec) return basename(env.ComSpec);
  }
  return undefined;
}

function detectTerminal(env: Env): string | undefined {
  const tp = env.TERM_PROGRAM?.trim();
  // TERM_PROGRAM=tmux means we're inside tmux — the real terminal is unknown, so defer to the
  // multiplexer field rather than mislabel it.
  if (tp && tp.toLowerCase() !== "tmux") {
    return TERM_PROGRAMS[tp.toLowerCase()] ?? tp;
  }
  if (env.WT_SESSION) return "Windows Terminal";
  if (env.KONSOLE_VERSION) return "Konsole";
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return "Alacritty";
  // Deliberately NOT falling back to $TERM (e.g. "xterm-256color") — that's a terminfo name, not a
  // terminal anyone would put on their profile. Better to leave it blank and let the user fill it.
  return undefined;
}

function detectEditor(env: Env): string | undefined {
  const raw = env.VISUAL ?? env.EDITOR; // VISUAL is the "full-screen" editor by convention.
  if (!raw) return undefined;
  const bin = basename(firstToken(raw));
  return EDITOR_NAMES[bin.toLowerCase()] ?? bin;
}

function detectMultiplexer(env: Env): string | undefined {
  if (env.TMUX) return "tmux";
  if (env.ZELLIJ) return "Zellij";
  if (env.STY) return "GNU Screen";
  return undefined;
}

/**
 * Best-effort curated-key values from the environment. Returns only the keys it could detect with
 * confidence (os/shell/terminal/editor/multiplexer); the rest (browser, font, dotfiles, …) are
 * prompted. Wrapped so a surprise from any probe can never block publish.
 */
export function detectStack(env: Env, platform: NodeJS.Platform): Map<CuratedKey, string> {
  const out = new Map<CuratedKey, string>();
  const set = (key: CuratedKey, value: string | undefined): void => {
    if (value?.trim()) out.set(key, value.trim());
  };
  try {
    set("os", detectOS(env, platform));
    set("shell", detectShell(env, platform));
    set("terminal", detectTerminal(env));
    set("editor", detectEditor(env));
    set("multiplexer", detectMultiplexer(env));
  } catch {
    // Detection is a convenience, never a gate — return whatever we got.
  }
  return out;
}
