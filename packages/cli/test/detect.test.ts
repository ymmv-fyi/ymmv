import { TOOLS } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import { detectStack } from "../src/detect.js";

// The lightweight env detector (env + Node built-ins only, no `systeminformation`). Best-effort
// and never throwing: it fills what it can recognize and stays silent on the rest.
describe("detectStack", () => {
  it("macOS + zsh + iTerm + Neovim from a typical mac env", () => {
    const s = detectStack(
      { SHELL: "/bin/zsh", TERM_PROGRAM: "iTerm.app", EDITOR: "nvim" },
      "darwin",
    );
    expect(s.get("os")).toBe("macOS");
    expect(s.get("shell")).toBe("zsh");
    expect(s.get("terminal")).toBe("iTerm2");
    expect(s.get("editor")).toBe("Neovim");
  });

  it("Windows Terminal + PowerShell + VS Code from a Windows env", () => {
    const s = detectStack({ WT_SESSION: "x", PSModulePath: "C:\\m", EDITOR: "code" }, "win32");
    expect(s.get("os")).toBe("Windows");
    expect(s.get("terminal")).toBe("Windows Terminal");
    expect(s.get("shell")).toBe("PowerShell");
    expect(s.get("editor")).toBe("VS Code");
  });

  it("VISUAL beats EDITOR, and editor args are stripped", () => {
    expect(detectStack({ VISUAL: "code --wait", EDITOR: "vim" }, "linux").get("editor")).toBe(
      "VS Code",
    );
  });

  it("a WSL distro labels the OS", () => {
    expect(detectStack({ WSL_DISTRO_NAME: "Ubuntu" }, "linux").get("os")).toBe("Ubuntu (WSL)");
  });

  it("detects the multiplexer from $TMUX", () => {
    expect(detectStack({ TMUX: "/tmp/s" }, "linux").get("multiplexer")).toBe("tmux");
  });

  it("TERM_PROGRAM=tmux defers the terminal to the multiplexer (no mislabel)", () => {
    const s = detectStack({ TERM_PROGRAM: "tmux", TMUX: "/tmp/s" }, "linux");
    expect(s.has("terminal")).toBe(false);
    expect(s.get("multiplexer")).toBe("tmux");
  });

  it("detects Zellij, and passes an unknown platform through as the OS", () => {
    expect(detectStack({ ZELLIJ: "0" }, "linux").get("multiplexer")).toBe("Zellij");
    expect(detectStack({}, "freebsd").get("os")).toBe("freebsd");
  });

  it("a bare env never throws and leaves unreliable fields unset", () => {
    const s = detectStack({}, "linux");
    expect(s.get("os")).toBe("Linux");
    expect(s.has("terminal")).toBe(false);
    expect(s.has("editor")).toBe(false);
    expect(s.has("shell")).toBe(false);
    expect(s.has("window-manager")).toBe(false);
    expect(s.has("browser")).toBe(false);
    expect(s.has("ai-tool")).toBe(false);
  });
});

describe("Windows shell inference", () => {
  // PowerShell (either flavor) prepends the user's Documents module dir; cmd.exe only ever sees
  // the machine-wide HKLM default, which starts at Program Files.
  const PS7_MODULES =
    "C:\\Users\\b\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules";
  const PS51_MODULES =
    "C:\\Users\\b\\Documents\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules";
  const MACHINE_MODULES =
    "C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules";
  const COMSPEC = "C:\\WINDOWS\\system32\\cmd.exe";

  it("cmd.exe no longer misdetects as PowerShell (machine PSModulePath + PROMPT → cmd)", () => {
    const s = detectStack(
      { PSModulePath: MACHINE_MODULES, PROMPT: "$P$G", ComSpec: COMSPEC },
      "win32",
    );
    expect(s.get("shell")).toBe("cmd");
  });

  it("pwsh 7 wins over an inherited PROMPT (Documents\\PowerShell first segment)", () => {
    const s = detectStack({ PSModulePath: PS7_MODULES, PROMPT: "$P$G" }, "win32");
    expect(s.get("shell")).toBe("PowerShell");
  });

  it("Windows PowerShell 5.1 via Documents\\WindowsPowerShell first segment", () => {
    expect(detectStack({ PSModulePath: PS51_MODULES }, "win32").get("shell")).toBe("PowerShell");
  });

  it("OneDrive-redirected Documents still matches", () => {
    const od = "C:\\Users\\b\\OneDrive\\Documents\\PowerShell\\Modules;C:\\x";
    expect(detectStack({ PSModulePath: od }, "win32").get("shell")).toBe("PowerShell");
  });

  it("$SHELL (e.g. Git Bash) beats every Windows heuristic", () => {
    const s = detectStack(
      { SHELL: "/usr/bin/bash", PSModulePath: MACHINE_MODULES, PROMPT: "$P$G" },
      "win32",
    );
    expect(s.get("shell")).toBe("bash");
  });
});

describe("terminal presence probes + $TERM carve-out", () => {
  it.each([
    [{ KITTY_WINDOW_ID: "1" }, "kitty"],
    [{ KITTY_PID: "42" }, "kitty"],
    [{ GNOME_TERMINAL_SERVICE: ":1.99" }, "GNOME Terminal"],
    [{ TILIX_ID: "uuid" }, "Tilix"],
    [{ TERMINATOR_UUID: "urn:uuid:x" }, "Terminator"],
    [{ ConEmuANSI: "ON" }, "ConEmu"],
    [{ XTERM_VERSION: "XTerm(397)" }, "xterm"],
    [{ TERMINAL_EMULATOR: "JetBrains-JediTerm" }, "JetBrains"],
  ] as [Record<string, string>, string][])("%o → %s", (env, expected) => {
    expect(detectStack(env, "linux").get("terminal")).toBe(expected);
  });

  it("exact self-identifying $TERM values are allowed, dead last", () => {
    expect(detectStack({ TERM: "xterm-kitty" }, "linux").get("terminal")).toBe("kitty");
    expect(detectStack({ TERM: "foot" }, "linux").get("terminal")).toBe("foot");
    expect(detectStack({ TERM: "xterm-ghostty" }, "linux").get("terminal")).toBe("Ghostty");
    expect(detectStack({ TERM: "alacritty" }, "linux").get("terminal")).toBe("Alacritty");
  });

  it("generic terminfo names stay banned (the policy pin)", () => {
    expect(detectStack({ TERM: "xterm-256color" }, "linux").has("terminal")).toBe(false);
    expect(detectStack({ TERM: "screen-256color" }, "linux").has("terminal")).toBe(false);
  });

  it("inside tmux the host terminal's own vars still win over $TERM", () => {
    const s = detectStack(
      { TERM_PROGRAM: "tmux", TMUX: "/tmp/s", TERM: "tmux-256color", KITTY_WINDOW_ID: "1" },
      "linux",
    );
    expect(s.get("terminal")).toBe("kitty");
    expect(s.get("multiplexer")).toBe("tmux");
  });

  it("Cursor keeps TERM_PROGRAM=vscode; CURSOR_TRACE_ID discriminates", () => {
    expect(
      detectStack({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "t" }, "linux").get("terminal"),
    ).toBe("Cursor");
    expect(detectStack({ TERM_PROGRAM: "vscode" }, "linux").get("terminal")).toBe("VS Code");
  });
});

describe("window manager", () => {
  it("sway sets I3SOCK too — SWAYSOCK wins", () => {
    const s = detectStack({ SWAYSOCK: "/run/sway.sock", I3SOCK: "/run/i3.sock" }, "linux");
    expect(s.get("window-manager")).toBe("Sway");
    expect(detectStack({ I3SOCK: "/run/i3.sock" }, "linux").get("window-manager")).toBe("i3");
  });

  it("XDG_CURRENT_DESKTOP is a colon list — entries match, whole strings don't", () => {
    expect(
      detectStack({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, "linux").get("window-manager"),
    ).toBe("GNOME");
    expect(
      detectStack({ XDG_CURRENT_DESKTOP: "Unity:Unity7:ubuntu" }, "linux").get("window-manager"),
    ).toBe("Unity");
    expect(detectStack({ XDG_CURRENT_DESKTOP: "COSMIC" }, "linux").get("window-manager")).toBe(
      "COSMIC",
    );
  });

  it("compositor sockets outrank the XDG value", () => {
    const s = detectStack(
      { HYPRLAND_INSTANCE_SIGNATURE: "abc_1_2", XDG_CURRENT_DESKTOP: "GNOME" },
      "linux",
    );
    expect(s.get("window-manager")).toBe("Hyprland");
  });

  it("DESKTOP_SESSION: xsession paths map, session names never pass through raw", () => {
    expect(
      detectStack({ DESKTOP_SESSION: "/usr/share/xsessions/plasma" }, "linux").get(
        "window-manager",
      ),
    ).toBe("KDE Plasma");
    expect(detectStack({ DESKTOP_SESSION: "default" }, "linux").has("window-manager")).toBe(false);
    expect(detectStack({ DESKTOP_SESSION: "ubuntu" }, "linux").has("window-manager")).toBe(false);
  });

  it("KDE session vars as a last resort", () => {
    expect(detectStack({ KDE_SESSION_VERSION: "6" }, "linux").get("window-manager")).toBe(
      "KDE Plasma",
    );
  });
});

describe("browser from $BROWSER", () => {
  it("maps known binaries and strips paths/args", () => {
    expect(detectStack({ BROWSER: "/usr/bin/firefox" }, "linux").get("browser")).toBe("Firefox");
    expect(detectStack({ BROWSER: "firefox %s" }, "linux").get("browser")).toBe("Firefox");
    expect(detectStack({ BROWSER: "brave-browser" }, "linux").get("browser")).toBe("Brave");
  });
  it("unknown browsers pass through as typed binaries", () => {
    expect(detectStack({ BROWSER: "firefox-nightly" }, "linux").get("browser")).toBe(
      "firefox-nightly",
    );
  });
  it("dispatchers are not browsers", () => {
    expect(detectStack({ BROWSER: "xdg-open" }, "linux").has("browser")).toBe(false);
    expect(detectStack({ BROWSER: "wslview" }, "linux").has("browser")).toBe(false);
    // VS Code Remote's port-forward helper
    expect(detectStack({ BROWSER: "/vscode/bin/helpers/browser.sh" }, "linux").has("browser")).toBe(
      false,
    );
  });
  it("colon-separated fallback lists take the first real browser", () => {
    expect(detectStack({ BROWSER: "firefox:chromium" }, "linux").get("browser")).toBe("Firefox");
    expect(detectStack({ BROWSER: "xdg-open:firefox" }, "linux").get("browser")).toBe("Firefox");
    expect(detectStack({ BROWSER: "xdg-open:sensible-browser" }, "linux").has("browser")).toBe(
      false,
    );
  });
  it("a Windows path's drive-letter colon is never a list separator", () => {
    const win = "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
    expect(detectStack({ BROWSER: win }, "win32").get("browser")).toBe("Firefox");
  });
  it("a POSIX path with spaces keeps the binary's full name", () => {
    const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(detectStack({ BROWSER: mac }, "darwin").get("browser")).toBe("Google Chrome");
    // and the args form still token-parses
    expect(detectStack({ BROWSER: "/usr/bin/firefox %s" }, "linux").get("browser")).toBe("Firefox");
  });
});

// Env values are attacker-influenceable strings used as lookup keys. On a plain object,
// "__proto__"/"constructor" would resolve truthy Object.prototype members, throw inside set(),
// and the module-wide catch would silently drop every LATER probe. Null-prototype maps make these
// clean misses instead — the halt-proof assertions below pin that later probes still run.
describe("prototype-key env values never poison or halt detection", () => {
  it("XDG_CURRENT_DESKTOP=__proto__ is a miss, and later probes survive", () => {
    const s = detectStack(
      { XDG_CURRENT_DESKTOP: "__proto__", BROWSER: "/usr/bin/firefox", CLAUDECODE: "1" },
      "linux",
    );
    expect(s.has("window-manager")).toBe(false);
    expect(s.get("browser")).toBe("Firefox");
    expect(s.get("ai-tool")).toBe("Claude Code");
  });
  it("constructor as TERM / DESKTOP_SESSION stays unset", () => {
    expect(detectStack({ TERM: "constructor" }, "linux").has("terminal")).toBe(false);
    expect(detectStack({ DESKTOP_SESSION: "constructor" }, "linux").has("window-manager")).toBe(
      false,
    );
  });
  it("__proto__ through a passthrough field stays a plain string", () => {
    expect(detectStack({ SHELL: "/bin/__proto__" }, "linux").get("shell")).toBe("__proto__");
  });
});

describe("editor host inference (only when $VISUAL/$EDITOR are unset)", () => {
  it("an explicit $EDITOR always beats the host", () => {
    expect(detectStack({ EDITOR: "vim", NVIM: "/run/nvim.sock" }, "linux").get("editor")).toBe(
      "Vim",
    );
  });
  it("Neovim exports VIM* to :terminal children too — NVIM wins", () => {
    const s = detectStack({ NVIM: "/run/nvim.sock", VIMRUNTIME: "/usr/share/nvim" }, "linux");
    expect(s.get("editor")).toBe("Neovim");
  });
  it("VIM_TERMINAL (not bare VIMRUNTIME) marks a Vim :terminal", () => {
    expect(detectStack({ VIM_TERMINAL: "901" }, "linux").get("editor")).toBe("Vim");
    expect(detectStack({ VIMRUNTIME: "/usr/share/vim" }, "linux").has("editor")).toBe(false);
  });
  it("INSIDE_EMACS, Cursor-before-VS Code, and Zed's two markers", () => {
    expect(detectStack({ INSIDE_EMACS: "30.1,vterm" }, "linux").get("editor")).toBe("Emacs");
    expect(
      detectStack({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "t" }, "linux").get("editor"),
    ).toBe("Cursor");
    expect(detectStack({ TERM_PROGRAM: "vscode" }, "linux").get("editor")).toBe("VS Code");
    expect(detectStack({ ZED_TERM: "true" }, "linux").get("editor")).toBe("Zed");
    expect(detectStack({ TERM_PROGRAM: "zed" }, "linux").get("editor")).toBe("Zed");
  });
});

describe("ai-tool markers", () => {
  it.each([
    [{ CLAUDECODE: "1" }, "Claude Code"],
    [{ CODEX_THREAD_ID: "uuid" }, "Codex"],
    [{ GEMINI_CLI: "1" }, "Gemini CLI"],
    [{ OPENCODE: "1" }, "opencode"],
    [{ COPILOT_CLI: "1" }, "GitHub Copilot"],
    [{ CURSOR_TRACE_ID: "t" }, "Cursor"],
    [{ CURSOR_AGENT: "1" }, "Cursor"],
  ] as [Record<string, string>, string][])("%o → %s", (env, expected) => {
    expect(detectStack(env, "linux").get("ai-tool")).toBe(expected);
  });

  it("Amp sets CLAUDECODE too — AGENT=amp must win; opencode's AGENT=1 must NOT read as Amp", () => {
    expect(detectStack({ AGENT: "amp", CLAUDECODE: "1" }, "linux").get("ai-tool")).toBe("Amp");
    expect(
      detectStack({ AGENT: "1", OPENCODE: "1", OPENCODE_PID: "9" }, "linux").get("ai-tool"),
    ).toBe("opencode");
  });

  it("a specific agent CLI beats the surrounding Cursor IDE terminal", () => {
    expect(detectStack({ CURSOR_TRACE_ID: "t", CLAUDECODE: "1" }, "linux").get("ai-tool")).toBe(
      "Claude Code",
    );
  });
});

describe("prompt renderer", () => {
  it.each([
    [{ STARSHIP_SHELL: "zsh" }, "Starship"],
    [{ STARSHIP_SESSION_KEY: "k" }, "Starship"],
    [{ POSH_SHELL: "pwsh" }, "Oh My Posh"],
    [{ POSH_THEME: "x.omp.json" }, "Oh My Posh"], // legacy ≤v26 corroborator
    [{ P9K_TTY: "old" }, "Powerlevel10k"],
    [{ _P9K_TTY: "/dev/pts/0" }, "Powerlevel10k"],
    [{ SPACESHIP_VERSION: "4.19.0" }, "Spaceship"],
    [{ _tide_left_items: "pwd" }, "Tide"],
  ] as [Record<string, string>, string][])("%o → %s", (env, expected) => {
    expect(detectStack(env, "linux").get("prompt")).toBe(expected);
  });

  it("Starship wins when several are present (pinned order)", () => {
    expect(detectStack({ STARSHIP_SHELL: "zsh", P9K_TTY: "old" }, "linux").get("prompt")).toBe(
      "Starship",
    );
  });

  it("empty env → unset (Pure and friends export nothing)", () => {
    expect(detectStack({}, "linux").has("prompt")).toBe(false);
  });
});

describe("version manager", () => {
  it.each([
    [{ MISE_SHELL: "zsh" }, "mise"],
    [{ __MISE_ORIG_PATH: "/usr/bin" }, "mise"],
    [{ PATH: "/home/b/.local/share/mise/shims:/usr/bin" }, "mise"], // shims mode sets no vars
    [{ ASDF_DIR: "/opt/asdf" }, "asdf"],
    [{ PATH: "/home/b/.asdf/shims:/usr/bin" }, "asdf"], // asdf ≥0.16 sets no vars
    [{ PROTO_HOME: "/home/b/.proto" }, "proto"],
    [{ VOLTA_HOME: "/home/b/.volta" }, "Volta"],
    [{ FNM_MULTISHELL_PATH: "/run/fnm" }, "fnm"],
    [{ NVM_DIR: "/home/b/.nvm" }, "nvm"],
    [{ PYENV_SHELL: "zsh" }, "pyenv"],
    [{ RBENV_SHELL: "zsh" }, "rbenv"],
  ] as [Record<string, string>, string][])("%o → %s", (env, expected) => {
    expect(detectStack(env, "linux").get("version-manager")).toBe(expected);
  });

  it("an activated polyglot manager beats a lingering per-runtime one", () => {
    expect(
      detectStack({ MISE_SHELL: "zsh", NVM_DIR: "/home/b/.nvm" }, "linux").get("version-manager"),
    ).toBe("mise");
  });

  it("a plain PATH is not a version manager", () => {
    expect(
      detectStack({ PATH: "/usr/local/bin:/usr/bin:/bin" }, "linux").has("version-manager"),
    ).toBe(false);
  });
});

describe("os: distro via injected /etc/os-release read", () => {
  const reader = (content: string) => (path: string) => {
    if (path !== "/etc/os-release") throw new Error(`unexpected read: ${path}`);
    return content;
  };

  it('NAME="Arch Linux" → Arch Linux (quotes stripped)', () => {
    const s = detectStack({}, "linux", { readTextFile: reader('NAME="Arch Linux"\nID=arch\n') });
    expect(s.get("os")).toBe("Arch Linux");
  });
  it("unquoted NAME works too", () => {
    expect(
      detectStack({}, "linux", { readTextFile: reader("NAME=NixOS\nID=nixos\n") }).get("os"),
    ).toBe("NixOS");
  });
  it("single-quoted NAME per the os-release spec", () => {
    expect(detectStack({}, "linux", { readTextFile: reader("NAME='Arch ARM'\n") }).get("os")).toBe(
      "Arch ARM",
    );
  });
  it("content without a NAME line falls back to the coarse label", () => {
    expect(
      detectStack({}, "linux", { readTextFile: reader('PRETTY_NAME="X 1.0"\nID=x\n') }).get("os"),
    ).toBe("Linux");
  });
  it("a throwing reader falls back to the coarse label", () => {
    const boom = () => {
      throw new Error("ENOENT");
    };
    expect(detectStack({}, "linux", { readTextFile: boom }).get("os")).toBe("Linux");
  });
  it("no reader injected (the default) → exactly the old behavior", () => {
    expect(detectStack({}, "linux").get("os")).toBe("Linux");
  });
  it("WSL_DISTRO_NAME beats the file, and only counts on linux (interop leak guard)", () => {
    const s = detectStack({ WSL_DISTRO_NAME: "Ubuntu" }, "linux", {
      readTextFile: reader('NAME="Ubuntu"'),
    });
    expect(s.get("os")).toBe("Ubuntu (WSL)");
    // A Windows-side process launched FROM WSL inherits the var but runs on Windows.
    expect(detectStack({ WSL_DISTRO_NAME: "Ubuntu" }, "win32").get("os")).toBe("Windows");
  });
  it("darwin/win32 never trigger the reader", () => {
    const boom = () => {
      throw new Error("should not be called");
    };
    expect(detectStack({}, "darwin", { readTextFile: boom }).get("os")).toBe("macOS");
    expect(detectStack({}, "win32", { readTextFile: boom }).get("os")).toBe("Windows");
  });
});

// Regression guard for the TOOLS refactor: the detector's editor/shell/terminal maps are now
// derived from @ymmv/shared TOOLS.envTokens instead of hardcoded literals. These fixtures are the
// exact mappings that existed before the refactor — every token drives through detectStack (the
// maps are private) and must still resolve to its canonical, and no token may be dropped or added.
const EDITOR_EXPECTED: Record<string, string> = {
  nvim: "Neovim",
  vim: "Vim",
  vi: "Vim",
  code: "VS Code",
  "code-insiders": "VS Code Insiders",
  codium: "VSCodium",
  emacs: "Emacs",
  nano: "Nano",
  hx: "Helix",
  helix: "Helix",
  subl: "Sublime Text",
  micro: "Micro",
  idea: "IntelliJ IDEA",
  zed: "Zed",
  pico: "Pico",
};
const SHELL_EXPECTED: Record<string, string> = {
  zsh: "zsh",
  bash: "bash",
  fish: "fish",
  sh: "sh",
  dash: "dash",
  ksh: "ksh",
  tcsh: "tcsh",
  csh: "csh",
  nu: "Nushell",
  nushell: "Nushell",
  pwsh: "PowerShell",
  powershell: "PowerShell",
  elvish: "Elvish",
  xonsh: "xonsh",
};
const TERM_EXPECTED: Record<string, string> = {
  "iterm.app": "iTerm2",
  apple_terminal: "Terminal",
  vscode: "VS Code",
  wezterm: "WezTerm",
  ghostty: "Ghostty",
  hyper: "Hyper",
  rio: "Rio",
  kitty: "kitty",
  tabby: "Tabby",
  warpterminal: "Warp",
  kgx: "GNOME Console",
  mintty: "mintty",
  zed: "Zed",
};
const WM_EXPECTED: Record<string, string> = {
  gnome: "GNOME",
  kde: "KDE Plasma",
  plasma: "KDE Plasma",
  hyprland: "Hyprland",
  sway: "Sway",
  i3: "i3",
  niri: "niri",
  cosmic: "COSMIC",
  cinnamon: "Cinnamon",
  "x-cinnamon": "Cinnamon",
  mate: "MATE",
  xfce: "XFCE",
  lxqt: "LXQt",
  budgie: "Budgie",
  pantheon: "Pantheon",
  unity: "Unity",
};
const BROWSER_EXPECTED: Record<string, string> = {
  firefox: "Firefox",
  chrome: "Chrome",
  "google-chrome": "Chrome",
  msedge: "Edge",
  "microsoft-edge": "Edge",
  chromium: "Chromium",
  "chromium-browser": "Chromium",
  brave: "Brave",
  "brave-browser": "Brave",
  librewolf: "LibreWolf",
  vivaldi: "Vivaldi",
  "vivaldi-stable": "Vivaldi",
  zen: "Zen",
  "zen-browser": "Zen",
  qutebrowser: "qutebrowser",
};

describe("detector maps derived from TOOLS match the pinned mappings", () => {
  const editorOf = (t: string) => detectStack({ EDITOR: t }, "linux").get("editor");
  const shellOf = (t: string) => detectStack({ SHELL: `/bin/${t}` }, "linux").get("shell");
  const terminalOf = (t: string) => detectStack({ TERM_PROGRAM: t }, "linux").get("terminal");
  const wmOf = (t: string) =>
    detectStack({ XDG_CURRENT_DESKTOP: t }, "linux").get("window-manager");
  const browserOf = (t: string) =>
    detectStack({ BROWSER: `/usr/bin/${t}` }, "linux").get("browser");

  it.each(Object.entries(EDITOR_EXPECTED))("editor $EDITOR=%s → %s", (token, canonical) => {
    expect(editorOf(token)).toBe(canonical);
  });
  it.each(Object.entries(SHELL_EXPECTED))("shell $SHELL=/bin/%s → %s", (token, canonical) => {
    expect(shellOf(token)).toBe(canonical);
  });
  it.each(Object.entries(TERM_EXPECTED))("terminal $TERM_PROGRAM=%s → %s", (token, canonical) => {
    expect(terminalOf(token)).toBe(canonical);
  });
  it.each(
    Object.entries(WM_EXPECTED),
  )("window-manager XDG_CURRENT_DESKTOP=%s → %s", (token, canonical) => {
    expect(wmOf(token)).toBe(canonical);
  });
  it.each(
    Object.entries(BROWSER_EXPECTED),
  )("browser $BROWSER=/usr/bin/%s → %s", (token, canonical) => {
    expect(browserOf(token)).toBe(canonical);
  });

  // No EXTRA tokens sneaked in: the count of TOOLS envTokens per field equals the pinned set.
  it("TOOLS contributes exactly the pinned envTokens per field (no additions/removals)", () => {
    const tokenCount = (key: string) =>
      TOOLS.filter((t) => t.key === key).reduce((n, t) => n + (t.envTokens?.length ?? 0), 0);
    expect(tokenCount("editor")).toBe(Object.keys(EDITOR_EXPECTED).length);
    expect(tokenCount("shell")).toBe(Object.keys(SHELL_EXPECTED).length);
    expect(tokenCount("terminal")).toBe(Object.keys(TERM_EXPECTED).length);
    expect(tokenCount("window-manager")).toBe(Object.keys(WM_EXPECTED).length);
    expect(tokenCount("browser")).toBe(Object.keys(BROWSER_EXPECTED).length);
    // prompt is presence-probed and theme is never detected — an envToken on either would be
    // silent dead code, so pin the zero.
    expect(tokenCount("prompt")).toBe(0);
    expect(tokenCount("theme")).toBe(0);
  });
});
