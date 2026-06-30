import { describe, expect, it } from "vitest";
import { resolveArg } from "../src/resolve.js";

// The argument resolution table: bare-handle primary, reserved verbs, `view` fallback.
describe("resolveArg", () => {
  it("bare `ymmv` → publish (the default magic)", () => {
    expect(resolveArg([])).toEqual({ kind: "publish", yes: false });
  });

  it("`-y` / `--yes` → publish without the confirm", () => {
    expect(resolveArg(["-y"])).toEqual({ kind: "publish", yes: true });
    expect(resolveArg(["--yes"])).toEqual({ kind: "publish", yes: true });
  });

  it("a bare handle → view that handle", () => {
    expect(resolveArg(["antfu"])).toEqual({ kind: "view", handle: "antfu" });
  });

  it("`view <handle>` is the explicit fallback", () => {
    expect(resolveArg(["view", "antfu"])).toEqual({ kind: "view", handle: "antfu" });
  });

  it("`view` with no handle → error", () => {
    expect(resolveArg(["view"]).kind).toBe("error");
  });

  it("reserved verbs dispatch as verbs", () => {
    expect(resolveArg(["login"]).kind).toBe("login");
    expect(resolveArg(["logout"]).kind).toBe("logout");
    expect(resolveArg(["help"]).kind).toBe("help");
    expect(resolveArg(["--help"]).kind).toBe("help");
    expect(resolveArg(["--version"]).kind).toBe("version");
  });

  it("`delete` carries the -y flag", () => {
    expect(resolveArg(["delete"])).toEqual({ kind: "delete", yes: false });
    expect(resolveArg(["delete", "-y"])).toEqual({ kind: "delete", yes: true });
  });

  it("`set <key> <value>` → curated target", () => {
    expect(resolveArg(["set", "editor", "Neovim"])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "editor", value: "Neovim" },
    });
  });

  it("`set` joins a multi-word value", () => {
    expect(resolveArg(["set", "os", "Arch", "Linux"])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "os", value: "Arch Linux" },
    });
  });

  it("`set <key>` with no value → error", () => {
    expect(resolveArg(["set", "editor"]).kind).toBe("error");
  });

  it("`set <non-curated-key>` → error naming curated keys", () => {
    const cmd = resolveArg(["set", "hairstyle", "mohawk"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/curated key/);
  });

  it('`set --extra "Label=Value"` → extra target', () => {
    expect(resolveArg(["set", "--extra", "Launcher=Raycast"])).toEqual({
      kind: "set",
      target: { kind: "extra", label: "Launcher", value: "Raycast" },
    });
  });

  it("`set --extra` without `=` → error", () => {
    expect(resolveArg(["set", "--extra", "Launcher"]).kind).toBe("error");
  });

  it("an unknown option → error", () => {
    expect(resolveArg(["--bogus"]).kind).toBe("error");
  });

  it("an invalid handle (underscore) → error", () => {
    expect(resolveArg(["not_valid"]).kind).toBe("error");
  });
});
