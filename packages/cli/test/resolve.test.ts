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

  it("`unset <key>` → curated unset target", () => {
    expect(resolveArg(["unset", "editor"])).toEqual({
      kind: "unset",
      target: { kind: "curated", key: "editor" },
    });
  });

  it("`unset` with no key → usage error", () => {
    const cmd = resolveArg(["unset"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/usage: ymmv unset/);
  });

  it("`unset <non-curated-key>` → error naming curated keys", () => {
    const cmd = resolveArg(["unset", "hairstyle"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/curated key/);
  });

  it("`unset <key> <value>` (trailing args) → usage error, never a silent unset", () => {
    const cmd = resolveArg(["unset", "editor", "vim"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/usage: ymmv unset editor/);
  });

  it("`unset --extra <label>` / `-e` → extra unset target", () => {
    expect(resolveArg(["unset", "--extra", "Keyboard"])).toEqual({
      kind: "unset",
      target: { kind: "extra", label: "Keyboard" },
    });
    expect(resolveArg(["unset", "-e", "Keyboard"])).toEqual({
      kind: "unset",
      target: { kind: "extra", label: "Keyboard" },
    });
  });

  it("`unset --extra` joins a multi-word label", () => {
    expect(resolveArg(["unset", "--extra", "mech", "keyboard"])).toEqual({
      kind: "unset",
      target: { kind: "extra", label: "mech keyboard" },
    });
  });

  it("`unset --extra` with no label → error", () => {
    expect(resolveArg(["unset", "--extra"]).kind).toBe("error");
  });

  it('`unset --extra "Label=Value"` → just-the-label hint', () => {
    const cmd = resolveArg(["unset", "--extra", "Keyboard=HHKB"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/just the label/);
  });

  it("`set <key> -` rewrites to unset (dash clears, like the publish prompt)", () => {
    expect(resolveArg(["set", "window-manager", "-"])).toEqual({
      kind: "unset",
      target: { kind: "curated", key: "window-manager" },
    });
  });

  it('`set --extra "Label=-"` rewrites to unset extra', () => {
    expect(resolveArg(["set", "--extra", "Keyboard=-"])).toEqual({
      kind: "unset",
      target: { kind: "extra", label: "Keyboard" },
    });
  });

  it('`set --extra "Label= -"` trims to the dash sentinel → unset extra', () => {
    expect(resolveArg(["set", "--extra", "Keyboard=", "-"])).toEqual({
      kind: "unset",
      target: { kind: "extra", label: "Keyboard" },
    });
  });

  it("`set <key> - foo` stays a literal set (only a lone dash clears)", () => {
    expect(resolveArg(["set", "os", "-", "foo"])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "os", value: "- foo" },
    });
  });

  it("an unknown option → error", () => {
    expect(resolveArg(["--bogus"]).kind).toBe("error");
  });

  it("an invalid handle (underscore) → error", () => {
    expect(resolveArg(["not_valid"]).kind).toBe("error");
  });

  it("a reserved name → local error naming the reason, never a round-trip", () => {
    // `ymmv 404` used to make a network call and misreport "no profile yet" for a name that can
    // never have a profile. The baked list is a hint; the API stays the trust boundary.
    const cmd = resolveArg(["404"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/"404" is a reserved name/);
  });

  it("`view <reserved>` errors the same way (verb-colliding profiles cannot exist)", () => {
    const cmd = resolveArg(["view", "api"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/reserved name/);
  });

  it("the reserved check is case-insensitive, matching handle comparison rules", () => {
    const cmd = resolveArg(["API"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/reserved name/);
  });

  it("shape is checked before reservation — malformed input reads as invalid, not reserved", () => {
    const cmd = resolveArg(["view", "bad_handle"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/not a valid GitHub handle/);
  });
});
