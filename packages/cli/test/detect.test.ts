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
