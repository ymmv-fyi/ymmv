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
};

describe("detector maps derived from TOOLS match the pinned mappings", () => {
  const editorOf = (t: string) => detectStack({ EDITOR: t }, "linux").get("editor");
  const shellOf = (t: string) => detectStack({ SHELL: `/bin/${t}` }, "linux").get("shell");
  const terminalOf = (t: string) => detectStack({ TERM_PROGRAM: t }, "linux").get("terminal");

  it.each(Object.entries(EDITOR_EXPECTED))("editor $EDITOR=%s → %s", (token, canonical) => {
    expect(editorOf(token)).toBe(canonical);
  });
  it.each(Object.entries(SHELL_EXPECTED))("shell $SHELL=/bin/%s → %s", (token, canonical) => {
    expect(shellOf(token)).toBe(canonical);
  });
  it.each(Object.entries(TERM_EXPECTED))("terminal $TERM_PROGRAM=%s → %s", (token, canonical) => {
    expect(terminalOf(token)).toBe(canonical);
  });

  // No EXTRA tokens sneaked in: the count of TOOLS envTokens per field equals the pinned set.
  it("TOOLS contributes exactly the pinned envTokens per field (no additions/removals)", () => {
    const tokenCount = (key: string) =>
      TOOLS.filter((t) => t.key === key).reduce((n, t) => n + (t.envTokens?.length ?? 0), 0);
    expect(tokenCount("editor")).toBe(Object.keys(EDITOR_EXPECTED).length);
    expect(tokenCount("shell")).toBe(Object.keys(SHELL_EXPECTED).length);
    expect(tokenCount("terminal")).toBe(Object.keys(TERM_EXPECTED).length);
  });
});
