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
    expect(resolveArg(["update"]).kind).toBe("update");
    expect(resolveArg(["help"]).kind).toBe("help");
    expect(resolveArg(["--help"]).kind).toBe("help");
    expect(resolveArg(["--version"]).kind).toBe("version");
  });

  it("`update` rejects trailing tokens with usage (never silently dropped)", () => {
    const cmd = resolveArg(["update", "now"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toBe("usage: ymmv update");
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

  it('`set -e "Label=Value"` works like --extra (the documented shorthand)', () => {
    expect(resolveArg(["set", "-e", "Launcher=Raycast"])).toEqual({
      kind: "set",
      target: { kind: "extra", label: "Launcher", value: "Raycast" },
    });
  });

  it("`set --extra` without `=` → error", () => {
    expect(resolveArg(["set", "--extra", "Launcher"]).kind).toBe("error");
  });

  it("`set <key>` with an over-cap value → local cap error naming lengths only, no network", () => {
    // Pre-flight of the shared write cap: the server would 422 this anyway, but the CLI must say
    // so before any login/round-trip — and echo the LENGTH, never the value itself.
    const cmd = resolveArg(["set", "editor", "x".repeat(300)]);
    expect(cmd).toEqual({
      kind: "error",
      message: "That value is 300 characters; the cap is 256.",
    });
  });

  it("`set <key>` with a value exactly at the cap still parses as a set", () => {
    const value = "x".repeat(256);
    expect(resolveArg(["set", "editor", value])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "editor", value },
    });
  });

  it("`set --extra` with an over-cap label → local cap error", () => {
    const cmd = resolveArg(["set", "--extra", `${"l".repeat(65)}=v`]);
    expect(cmd).toEqual({
      kind: "error",
      message: "That label is 65 characters; the cap is 64.",
    });
  });

  it("`set --extra` with an over-cap value → local cap error", () => {
    const cmd = resolveArg(["set", "--extra", `Keyboard=${"v".repeat(257)}`]);
    expect(cmd).toEqual({
      kind: "error",
      message: "That value is 257 characters; the cap is 256.",
    });
  });

  it("`set --extra` at both caps exactly (64-char label, 256-char value) still parses", () => {
    const label = "l".repeat(64);
    const value = "v".repeat(256);
    expect(resolveArg(["set", "--extra", `${label}=${value}`])).toEqual({
      kind: "set",
      target: { kind: "extra", label, value },
    });
  });

  it('`set --extra "over-cap-label=-"` still unsets — the "-" sentinel outranks the cap check', () => {
    // Unsetting by an over-long label is a harmless no-op lookup; only STORES are capped.
    expect(resolveArg(["set", "--extra", `${"l".repeat(65)}=-`])).toEqual({
      kind: "unset",
      target: { kind: "extra", label: "l".repeat(65) },
    });
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

  it("`-y <anything>` → error, never a publish (consent stays scoped to the intended command)", () => {
    // `ymmv -y delete` used to publish unconfirmed detection — the -y was consent for delete.
    const cmd = resolveArg(["-y", "delete"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/ymmv delete -y/);
    expect(resolveArg(["--yes", "set", "editor", "x"]).kind).toBe("error");
  });

  it("the -y ordering hint never offers delete to a user who typed something else", () => {
    const cmd = resolveArg(["-y", "set", "editor", "vim"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") {
      expect(cmd.message).toMatch(/ymmv publish -y/);
      expect(cmd.message).not.toMatch(/delete/);
    }
  });

  it("`delete <handle> -y` → usage error, never an unprompted delete of the caller's profile", () => {
    const cmd = resolveArg(["delete", "oldname", "-y"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/usage: ymmv delete/);
  });

  it("`delete --yes` keeps working (regression: the guard rewrite touches exactly this path)", () => {
    expect(resolveArg(["delete", "--yes"])).toEqual({ kind: "delete", yes: true });
  });

  it("`delete -y -y` → error (exactly one consent token)", () => {
    expect(resolveArg(["delete", "-y", "-y"]).kind).toBe("error");
  });

  it("login/logout reject trailing tokens", () => {
    expect(resolveArg(["login", "--scopes", "x"]).kind).toBe("error");
    expect(resolveArg(["logout", "--all"]).kind).toBe("error");
  });

  it("`view <handle> <extra>` → usage error (second handle never silently dropped)", () => {
    expect(resolveArg(["view", "a", "b"]).kind).toBe("error");
  });

  it("a bare handle rejects trailing tokens", () => {
    expect(resolveArg(["antfu", "--json"]).kind).toBe("error");
  });

  it("`version` word works like the flags; trailing tokens error", () => {
    expect(resolveArg(["version"])).toEqual({ kind: "version" });
    expect(resolveArg(["version", "extra"]).kind).toBe("error");
  });

  it("the version flag forms also reject trailing tokens", () => {
    expect(resolveArg(["--version", "extra"]).kind).toBe("error");
    expect(resolveArg(["-v", "extra"]).kind).toBe("error");
    expect(resolveArg(["-V", "extra"]).kind).toBe("error");
  });

  it("`publish` word is the explicit default command; -y is its only extra token", () => {
    expect(resolveArg(["publish"])).toEqual({ kind: "publish", yes: false });
    expect(resolveArg(["publish", "-y"])).toEqual({ kind: "publish", yes: true });
    expect(resolveArg(["publish", "--yes"])).toEqual({ kind: "publish", yes: true });
    expect(resolveArg(["publish", "x"]).kind).toBe("error");
  });

  it("`help` deliberately ignores trailing tokens (future `ymmv help <command>` stays open)", () => {
    expect(resolveArg(["help", "extra"]).kind).toBe("help");
  });

  it("a capitalized verb hints the lowercase command", () => {
    for (const [typed, verb] of [
      ["Login", "login"],
      ["Set", "set"],
      ["Publish", "publish"],
      ["Version", "version"],
    ] as const) {
      const cmd = resolveArg([typed]);
      expect(cmd.kind).toBe("error");
      if (cmd.kind === "error") expect(cmd.message).toContain(`Did you mean: ymmv ${verb}?`);
    }
  });

  it("`Set editor vim` hints the verb, not a bland trailing-args error", () => {
    const cmd = resolveArg(["Set", "editor", "vim"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toContain("Did you mean: ymmv set?");
  });

  it("non-verb reserved names get no command hint", () => {
    const cmd = resolveArg(["API"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).not.toMatch(/Did you mean/);
  });

  it("`view <reserved>` gets no hint (the user asked to view, not to run a command)", () => {
    const cmd = resolveArg(["view", "login"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") {
      expect(cmd.message).toMatch(/reserved name/);
      expect(cmd.message).not.toMatch(/Did you mean/);
    }
  });

  it("an unknown option → error", () => {
    expect(resolveArg(["--bogus"]).kind).toBe("error");
  });

  it("an invalid handle (underscore) → error", () => {
    expect(resolveArg(["not_valid"]).kind).toBe("error");
  });

  it("invalid-handle errors strip escape bytes before echoing argv", () => {
    // Every rejection path that echoes argv: bare-handle, view, unknown option, and the
    // set/unset invalid-key error. ESC would let crafted argv retitle the terminal or recolor
    // the line; sanitizeValue must strip it before the message prints.
    const junk = "]0;pwned_x";
    for (const argv of [
      [junk],
      ["view", junk],
      [`-${junk}`],
      ["set", junk, "x"],
      ["unset", junk],
    ]) {
      const cmd = resolveArg(argv);
      expect(cmd.kind).toBe("error");
      if (cmd.kind === "error") {
        expect(cmd.message).not.toContain("");
        expect(cmd.message).not.toContain("");
      }
    }
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
