import { CURATED_KEYS, KEY_LABELS, MAX_LABEL, MAX_VALUE } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import { FIELD_ALIASES, fieldName, resolveArg, resolveField } from "../src/resolve.js";

// The argument resolution table: bare-handle primary, reserved verbs, `view` fallback.
describe("resolveArg", () => {
  it("bare `ymmv` → publish (the default magic)", () => {
    expect(resolveArg([])).toEqual({ kind: "publish", yes: false, resetMarks: false });
  });

  it("`-y` / `--yes` → publish without the confirm", () => {
    expect(resolveArg(["-y"])).toEqual({ kind: "publish", yes: true, resetMarks: false });
    expect(resolveArg(["--yes"])).toEqual({ kind: "publish", yes: true, resetMarks: false });
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

  it("`set <normalized-key>` accepts uppercase, underscores, spaces, and KEY_LABELS forms", () => {
    expect(resolveArg(["set", "Editor", "Zed"])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "editor", value: "Zed" },
    });
    expect(resolveArg(["set", "window_manager", "yabai"])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "window-manager", value: "yabai" },
    });
    expect(resolveArg(["set", "window manager", "yabai"])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "window-manager", value: "yabai" },
    });
    expect(resolveArg(["set", "Window Manager", "yabai"])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "window-manager", value: "yabai" },
    });
    expect(resolveArg(["set", "AI Tool", "Claude"])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "ai-tool", value: "Claude" },
    });
    expect(resolveArg(["set", "ai_tool", "Claude"])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "ai-tool", value: "Claude" },
    });
  });

  it("`set <key> -` with a normalized key unsets the curated key", () => {
    expect(resolveArg(["set", "Editor", "-"])).toEqual({
      kind: "unset",
      target: { kind: "curated", key: "editor", typed: "Editor" },
    });
    expect(resolveArg(["set", "Window Manager", "-"])).toEqual({
      kind: "unset",
      target: { kind: "curated", key: "window-manager", typed: "Window Manager" },
    });
  });

  it("`set <non-curated-key>` suggests close typos or prefixes with 'Did you mean'", () => {
    const aitool = resolveArg(["set", "aitool", "Claude"]);
    expect(aitool.kind).toBe("error");
    if (aitool.kind === "error") {
      expect(aitool.message).toContain('Did you mean "ai-tool"?');
      expect(aitool.message).toContain('"aitool" is not a curated key.');
    }

    const wmLong = resolveArg(["set", "windowmanager", "yabai"]);
    expect(wmLong.kind).toBe("error");
    if (wmLong.kind === "error") {
      expect(wmLong.message).toContain('Did you mean "window-manager"?');
    }

    const edit = resolveArg(["set", "edit", "vim"]);
    expect(edit.kind).toBe("error");
    if (edit.kind === "error") {
      expect(edit.message).toContain('Did you mean "editor"?');
    }

    const term = resolveArg(["set", "teminal", "ghostty"]);
    expect(term.kind).toBe("error");
    if (term.kind === "error") {
      expect(term.message).toContain('Did you mean "terminal"?');
    }
  });

  it("`set <non-curated-key>` keeps an unrelated input as a plain miss (no suggestion)", () => {
    const hair = resolveArg(["set", "hairstyle", "mohawk"]);
    expect(hair.kind).toBe("error");
    if (hair.kind === "error") {
      expect(hair.message).not.toContain("Did you mean");
    }
  });

  it("an alias is a suggestion on a write, never the write itself", () => {
    // `ymmv set vm UTM` may be about a virtual machine, which is an extra.
    for (const [alias, key] of [
      ["wm", "window-manager"],
      ["vm", "version-manager"],
      ["mux", "multiplexer"],
      ["ai tools", "ai-tool"],
    ]) {
      for (const argv of [
        ["set", alias, "x"],
        ["set", alias, "-"],
        ["unset", alias],
      ]) {
        const cmd = resolveArg(argv);
        expect(cmd.kind, argv.join(" ")).toBe("error");
        if (cmd.kind === "error") {
          expect(cmd.message, argv.join(" ")).toContain(
            `"${alias}" is not a curated key. Did you mean "${key}"?`,
          );
        }
      }
    }
    const manager = resolveArg(["set", "manager", "yabai"]);
    expect(manager.kind).toBe("error");
    if (manager.kind === "error") {
      expect(manager.message).toContain('Did you mean "window-manager" or "version-manager"?');
    }
  });

  it("`set` and `unset` take only a whole name: a prefix is a suggestion, never a write", () => {
    // Unquoted `ymmv set Window Manager yabai`: taking the prefix would save "Manager yabai".
    const unquoted = resolveArg(["set", "Window", "Manager", "yabai"]);
    expect(unquoted.kind).toBe("error");
    if (unquoted.kind === "error") {
      expect(unquoted.message).toContain(
        '"Window" is not a curated key. Did you mean "window-manager"?',
      );
    }
    // "ai" answers the "Which field" prompt, where a wrong guess costs one prompt, not a row.
    for (const verb of ["set", "unset"]) {
      const cmd = resolveArg([verb, "ai", ...(verb === "set" ? ["Claude"] : [])]);
      expect(cmd.kind, verb).toBe("error");
      if (cmd.kind === "error") expect(cmd.message).toContain('Did you mean "ai-tool"?');
    }
  });

  it("a prefix that fits two keys suggests both, and the key list still follows", () => {
    const cmd = resolveArg(["set", "t", "x"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") {
      expect(cmd.message).toBe(
        `"t" is not a curated key. Did you mean "terminal" or "theme"? Valid keys: ${CURATED_KEYS.join(", ")}.\nFor anything else, use: ymmv set --extra "Label=Value".`,
      );
    }
  });

  it("the edit-distance fallback never offers the two-letter `os`, nor anything for two letters", () => {
    for (const head of ["oss", "ox", "xy", "zsh"]) {
      const cmd = resolveArg(["set", head, "x"]);
      expect(cmd.kind, head).toBe("error");
      if (cmd.kind === "error") expect(cmd.message, head).not.toContain("Did you mean");
    }
  });

  it("a key typed like a flag is refused, with the key it folds to as the suggestion", () => {
    for (const argv of [
      ["set", "--theme", "Nord"],
      ["set", "-os", "-"],
      ["unset", "--theme"],
    ]) {
      const cmd = resolveArg(argv);
      expect(cmd.kind, argv.join(" ")).toBe("error");
      if (cmd.kind === "error") {
        const key = argv[1]?.replace(/^-+/, "");
        expect(cmd.message, argv.join(" ")).toContain(
          `"${argv[1]}" is not a curated key. Did you mean "${key}"?`,
        );
      }
    }
  });

  it("a key with an escape sequence in it is echoed without the \x1b byte", () => {
    for (const verb of ["set", "unset"]) {
      const cmd = resolveArg([verb, "\x1b[31meditr", "x"]);
      expect(cmd.kind, verb).toBe("error");
      if (cmd.kind === "error") {
        expect(cmd.message, verb).not.toContain("\x1b");
        expect(cmd.message, verb).toContain("is not a curated key.");
      }
    }
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

  // Zero-width space, spelled out so nothing invisible hides in the test source. It survives
  // trim(), so without the pre-flight it would be the server's 422 after login and a round trip.
  const zwsp = String.fromCodePoint(0x200b);

  it("`set <key>` with an invisible-only value → local error, nothing echoed", () => {
    expect(resolveArg(["set", "editor", zwsp])).toEqual({
      kind: "error",
      message: "That value has no visible text.",
    });
  });

  it("`set --extra` with an invisible-only label or value → local error", () => {
    expect(resolveArg(["set", "--extra", `${zwsp}=v`])).toEqual({
      kind: "error",
      message: "That label has no visible text.",
    });
    expect(resolveArg(["set", "--extra", `Keyboard=${zwsp}`])).toEqual({
      kind: "error",
      message: "That value has no visible text.",
    });
  });

  it("`set <key>` with a control-character-only value → the same local error", () => {
    expect(resolveArg(["set", "editor", String.fromCodePoint(0x01)])).toEqual({
      kind: "error",
      message: "That value has no visible text.",
    });
  });

  it("`set <key>` with an ANSI-only value → local error (it would render as a blank on the card)", () => {
    // ESC[31m has visible bytes by the shared rule (the server would store it) but sanitizes to
    // nothing on every CLI render, so the user would confirm a blank; the CLI judges what it shows.
    const esc = String.fromCharCode(0x1b);
    expect(resolveArg(["set", "editor", `${esc}[31m`])).toEqual({
      kind: "error",
      message: "That value has no visible text.",
    });
    expect(resolveArg(["set", "editor", `${esc}[31mvim`])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "editor", value: `${esc}[31mvim` },
    });
  });

  it("an invisible char decorating real text is the user's data: still parses, kept verbatim", () => {
    expect(resolveArg(["set", "editor", `${zwsp}vim`])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "editor", value: `${zwsp}vim` },
    });
    expect(resolveArg(["set", "--extra", `Key${zwsp}board=Moonlander`])).toEqual({
      kind: "set",
      target: { kind: "extra", label: `Key${zwsp}board`, value: "Moonlander" },
    });
  });

  it("a value failing both rules is refused as invisible, not as over-cap", () => {
    // Ordering pin: the visibility test runs before the cap test, so the note names the rule the
    // user can act on. A longer invisible-only value is still "no visible text".
    expect(resolveArg(["set", "editor", zwsp.repeat(MAX_VALUE + 1)])).toEqual({
      kind: "error",
      message: "That value has no visible text.",
    });
  });

  it("`set --extra` with both halves invisible reports the label first", () => {
    expect(resolveArg(["set", "--extra", `${zwsp}=${zwsp}`])).toEqual({
      kind: "error",
      message: "That label has no visible text.",
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

  it('`set --extra "<invisible>=-"` still unsets — the "-" sentinel outranks the visibility check', () => {
    // Same order as the cap below: a clear is a match-only lookup, and it is the one CLI-side way
    // to drop an extra whose label was stored invisible before the server refused them.
    expect(resolveArg(["set", "--extra", `${zwsp}=-`])).toEqual({
      kind: "unset",
      target: { kind: "extra", label: zwsp },
    });
  });

  it('`set --extra "over-cap-label=-"` still unsets — the "-" sentinel outranks the cap check', () => {
    // Unsetting by an over-long label is a harmless no-op lookup; only STORES are capped.
    expect(resolveArg(["set", "--extra", `${"l".repeat(65)}=-`])).toEqual({
      kind: "unset",
      target: { kind: "extra", label: "l".repeat(65) },
    });
  });

  it("`unset --extra <invisible>` still resolves: it is the removal path for a label stored before the rule", () => {
    // Deliberately asymmetric with parseSet (which refuses an invisible-only label): the server
    // has refused such labels only since the rule shipped, and unset is how an older one goes.
    expect(resolveArg(["unset", "--extra", zwsp])).toEqual({
      kind: "unset",
      target: { kind: "extra", label: zwsp },
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

  it("`unset <normalized-key>` accepts uppercase, underscores, and spaces", () => {
    expect(resolveArg(["unset", "Editor"])).toEqual({
      kind: "unset",
      target: { kind: "curated", key: "editor", typed: "Editor" },
    });
    expect(resolveArg(["unset", "window_manager"])).toEqual({
      kind: "unset",
      target: { kind: "curated", key: "window-manager", typed: "window_manager" },
    });
    expect(resolveArg(["unset", "Window Manager"])).toEqual({
      kind: "unset",
      target: { kind: "curated", key: "window-manager", typed: "Window Manager" },
    });
    // The exact key carries no `typed`: it is the one spelling that can only mean the field.
    expect(resolveArg(["unset", "window-manager"])).toEqual({
      kind: "unset",
      target: { kind: "curated", key: "window-manager" },
    });
  });

  it("`unset <non-curated-key>` suggests close matches with 'Did you mean'", () => {
    const cmd = resolveArg(["unset", "aitool"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") {
      expect(cmd.message).toContain('Did you mean "ai-tool"?');
      expect(cmd.message).toContain('"aitool" is not a curated key.');
    }
  });

  it("`unset <normalized-key> <value>` uses normalized key in usage error", () => {
    const cmd = resolveArg(["unset", "Window Manager", "yabai"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toBe("usage: ymmv unset window-manager");
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

  it("`unset --extra` over the label cap → cap error before any login or GET", () => {
    const cmd = resolveArg(["unset", "--extra", "x".repeat(MAX_LABEL + 1)]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(new RegExp(`the cap is ${MAX_LABEL}`));
  });

  it('`unset --extra "Label=Value"` parses as a label (curl-written labels may contain "=")', () => {
    expect(resolveArg(["unset", "--extra", "Keyboard=HHKB"])).toEqual({
      kind: "unset",
      target: { kind: "extra", label: "Keyboard=HHKB" },
    });
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

  it("`login -y` skips the already-logged-in question; one consent token, nothing else", () => {
    expect(resolveArg(["login"])).toEqual({ kind: "login", yes: false });
    expect(resolveArg(["login", "-y"])).toEqual({ kind: "login", yes: true });
    expect(resolveArg(["login", "--yes"])).toEqual({ kind: "login", yes: true });
    for (const argv of [
      ["login", "x"],
      ["login", "-y", "-y"],
    ]) {
      expect(resolveArg(argv)).toEqual({ kind: "error", message: "usage: ymmv login [-y]" });
    }
    expect(resolveArg(["logout", "-y"]).kind).toBe("error");
  });

  it("`-y login` points at `ymmv login -y`", () => {
    const cmd = resolveArg(["-y", "login"]);
    expect(cmd.kind).toBe("error");
    if (cmd.kind === "error") expect(cmd.message).toMatch(/ymmv login -y/);
  });

  it("`view <handle> <extra>` → usage error (second handle never silently dropped)", () => {
    expect(resolveArg(["view", "a", "b"]).kind).toBe("error");
  });

  it("a bare handle rejects trailing tokens", () => {
    expect(resolveArg(["antfu", "--json"]).kind).toBe("error");
  });

  it("`<a> vs <b>` and `view <a> vs <b>` → compare, sides as typed", () => {
    const compare = { kind: "compare", theirs: "antfu", mine: "Bardisty" };
    expect(resolveArg(["antfu", "vs", "Bardisty"])).toEqual(compare);
    expect(resolveArg(["view", "antfu", "vs", "Bardisty"])).toEqual(compare);
  });

  it("a user named vs: `ymmv vs` views them, and `vs vs x` compares them", () => {
    expect(resolveArg(["vs"])).toEqual({ kind: "view", handle: "vs" });
    expect(resolveArg(["vs", "vs", "x"])).toEqual({ kind: "compare", theirs: "vs", mine: "x" });
    expect(resolveArg(["x", "vs", "vs"])).toEqual({ kind: "compare", theirs: "x", mine: "vs" });
  });

  it("any other tail keeps the handle's own error", () => {
    const unexpected = {
      kind: "error",
      message: 'Unexpected arguments after "antfu". Run `ymmv help`.',
    };
    expect(resolveArg(["antfu", "b"])).toEqual(unexpected);
    expect(resolveArg(["antfu", "vs"])).toEqual(unexpected);
    expect(resolveArg(["antfu", "versus", "b"])).toEqual(unexpected);
    expect(resolveArg(["antfu", "VS", "b"])).toEqual(unexpected);
    expect(resolveArg(["antfu", "vs", "b", "c"])).toEqual(unexpected);
    expect(resolveArg(["view", "antfu", "vs"])).toEqual({
      kind: "error",
      message: "usage: ymmv view <handle> [vs <handle>]",
    });
  });

  it("the second side is checked like the first: shape, then reserved", () => {
    const esc = String.fromCharCode(27);
    expect(resolveArg(["antfu", "vs", `b${esc}[31m!`])).toEqual({
      kind: "error",
      message: '"b!" is not a valid GitHub handle.',
    });
    expect(resolveArg(["antfu", "vs", "login"])).toEqual({
      kind: "error",
      message: `"login" is a reserved name; it can't have a profile.`,
    });
    // The first side keeps its bare-path checks: a reserved verb still hints the command.
    expect(resolveArg(["Set", "vs", "b"]).kind).toBe("error");
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
    expect(resolveArg(["publish"])).toEqual({ kind: "publish", yes: false, resetMarks: false });
    expect(resolveArg(["publish", "-y"])).toEqual({
      kind: "publish",
      yes: true,
      resetMarks: false,
    });
    expect(resolveArg(["publish", "--yes"])).toEqual({
      kind: "publish",
      yes: true,
      resetMarks: false,
    });
    expect(resolveArg(["publish", "x"]).kind).toBe("error");
  });

  it("`help` still prints general help for an unknown topic (trailing tokens stay non-breaking)", () => {
    expect(resolveArg(["help", "extra"])).toEqual({ kind: "help" });
  });

  it("`help <verb>` and `<verb> --help` print that verb's usage and stay help (exit 0)", () => {
    const setUsage = `usage: ymmv set <key> <value>  |  ymmv set --extra "Label=Value"\nValid keys: ${CURATED_KEYS.join(", ")}.`;
    const viewUsage = "usage: ymmv view <handle> [vs <handle>]";
    const deleteUsage = "usage: ymmv delete [-y] (deletes your own profile; takes no handle)";
    expect(resolveArg(["help", "set"])).toEqual({ kind: "help", usage: setUsage });
    expect(resolveArg(["set", "--help"])).toEqual({ kind: "help", usage: setUsage });
    expect(resolveArg(["set", "-h"])).toEqual({ kind: "help", usage: setUsage });
    expect(resolveArg(["view", "--help"])).toEqual({ kind: "help", usage: viewUsage });
    expect(resolveArg(["delete", "--help"])).toEqual({ kind: "help", usage: deleteUsage });
    expect(resolveArg(["help", "delete"])).toEqual({ kind: "help", usage: deleteUsage });
    expect(resolveArg(["login", "--help"])).toEqual({
      kind: "help",
      usage: "usage: ymmv login [-y]",
    });
    expect(resolveArg(["publish", "-h"])).toEqual({
      kind: "help",
      usage: "usage: ymmv publish [-y | --reset-marks]",
    });
    expect(resolveArg(["unset", "--help"])).toEqual({
      kind: "help",
      usage: `usage: ymmv unset <key>  |  ymmv unset --extra "Label"\nValid keys: ${CURATED_KEYS.join(", ")}.`,
    });
    expect(resolveArg(["update", "--help"])).toEqual({
      kind: "help",
      usage: "usage: ymmv update",
    });
    expect(resolveArg(["logout", "-h"])).toEqual({ kind: "help", usage: "usage: ymmv logout" });
  });

  it.each(["login", "logout", "update", "publish", "delete", "set", "unset", "view", "version"])(
    "%s supports both help flags and help <verb>",
    (verb) => {
      const expected = resolveArg(["help", verb]);
      expect(expected.kind).toBe("help");
      expect(resolveArg([verb, "--help"])).toEqual(expected);
      expect(resolveArg([verb, "-h"])).toEqual(expected);
    },
  );

  it.each(["login", "logout", "update", "publish", "delete", "set", "unset", "view", "version"])(
    "%s prints its usage for a help flag anywhere after the verb",
    (verb) => {
      const expected = resolveArg(["help", verb]);
      for (const tail of [
        ["x", "--help"],
        ["-y", "-h"],
        ["--extra", "K=V", "--help"],
        ["x", "-h", "y"],
      ]) {
        expect(resolveArg([verb, ...tail])).toEqual(expected);
      }
    },
  );

  it("a late help flag wins over the argv it would otherwise complete or reject", () => {
    const help = (verb: string) => resolveArg(["help", verb]);
    // would have published "--help" / "vim --help" / an extra valued "Moonlander --help"
    expect(resolveArg(["set", "editor", "--help"])).toEqual(help("set"));
    expect(resolveArg(["set", "editor", "vim", "--help"])).toEqual(help("set"));
    expect(resolveArg(["set", "--extra", "Keyboard=Moonlander", "--help"])).toEqual(help("set"));
    expect(resolveArg(["set", "editor", "-h"])).toEqual(help("set"));
    // consent never slips through beside a help flag
    expect(resolveArg(["delete", "-y", "--help"])).toEqual(help("delete"));
    expect(resolveArg(["publish", "-y", "-h"])).toEqual(help("publish"));
    expect(resolveArg(["login", "-y", "--help"])).toEqual(help("login"));
    expect(resolveArg(["unset", "editor", "--help"])).toEqual(help("unset"));
    expect(resolveArg(["unset", "--extra", "--help"])).toEqual(help("unset"));
    expect(resolveArg(["view", "antfu", "--help"])).toEqual(help("view"));
  });

  it("the bare-handle view takes a late help flag as view's usage", () => {
    expect(resolveArg(["antfu", "--help"])).toEqual(resolveArg(["help", "view"]));
    expect(resolveArg(["antfu", "vs", "bardisty", "-h"])).toEqual(resolveArg(["help", "view"]));
    // the shape and reserved checks still answer first
    expect(resolveArg(["Set", "editor", "--help"])).toEqual({
      kind: "error",
      message: `"Set" is a reserved name; it can't have a profile. Did you mean: ymmv set?`,
    });
    expect(resolveArg(["a!b", "--help"]).kind).toBe("error");
  });

  it("flag-first argv keeps its own error when a help flag trails it", () => {
    expect(resolveArg(["-y", "--help"]).kind).toBe("error");
    expect(resolveArg(["--reset-marks", "--help"]).kind).toBe("error");
    expect(resolveArg(["--version", "--help"]).kind).toBe("error");
  });

  it("only a whole -h/--help token is help; one inside a value stays data", () => {
    expect(resolveArg(["set", "--extra", "Flags=-h"])).toEqual({
      kind: "set",
      target: { kind: "extra", label: "Flags", value: "-h" },
    });
    expect(resolveArg(["set", "editor", "vim-h"])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "editor", value: "vim-h" },
    });
    expect(resolveArg(["set", "editor", "--helpful"])).toEqual({
      kind: "set",
      target: { kind: "curated", key: "editor", value: "--helpful" },
    });
    // An extra labeled "--help" (the token is "--help=x", not a help flag) can still be set,
    // and cleared through the "-" value; `unset --extra --help` prints help instead.
    expect(resolveArg(["set", "--extra", "--help=x"])).toEqual({
      kind: "set",
      target: { kind: "extra", label: "--help", value: "x" },
    });
    expect(resolveArg(["set", "--extra", "--help=-"])).toEqual({
      kind: "unset",
      target: { kind: "extra", label: "--help" },
    });
  });

  it("version help describes the command instead of printing its version", () => {
    expect(resolveArg(["version", "--help"])).toEqual({
      kind: "help",
      usage: "usage: ymmv version",
    });
    expect(resolveArg(["help", "__proto__"])).toEqual({ kind: "help" });
  });

  it("a real argv error still returns usage as an error (exit 1), not help", () => {
    expect(resolveArg(["set"])).toEqual({
      kind: "error",
      message: 'usage: ymmv set <key> <value>  |  ymmv set --extra "Label=Value"',
    });
    expect(resolveArg(["delete", "oldname", "-y"]).kind).toBe("error");
    expect(resolveArg(["unset", "editor", "vim"])).toEqual({
      kind: "error",
      message: "usage: ymmv unset editor",
    });
  });

  it("`--reset-marks` → an interactive publish that forgets dismissed marks; never with -y", () => {
    const reset = { kind: "publish", yes: false, resetMarks: true };
    expect(resolveArg(["--reset-marks"])).toEqual(reset);
    expect(resolveArg(["publish", "--reset-marks"])).toEqual(reset);
    // -y shows no marks, so there is nothing for the pair to mean: refuse instead of picking one.
    for (const argv of [
      ["--reset-marks", "-y"],
      ["-y", "--reset-marks"],
      ["publish", "-y", "--reset-marks"],
      ["publish", "--reset-marks", "-y"],
      ["--reset-marks", "octocat"],
    ]) {
      expect(resolveArg(argv).kind).toBe("error");
    }
    // Either order names the exclusive pair; "put -y after the command" would lead to a second error.
    for (const argv of [
      ["--reset-marks", "-y"],
      ["-y", "--reset-marks"],
    ]) {
      expect(resolveArg(argv)).toEqual({
        kind: "error",
        message: "usage: ymmv publish [-y | --reset-marks]",
      });
    }
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

// The one matcher behind `set`, `unset` and the "Which field" prompt.
describe("resolveField", () => {
  it("every key and every label names its own field", () => {
    for (const key of CURATED_KEYS) {
      expect(resolveField(key)).toBe(key);
      expect(resolveField(KEY_LABELS[key])).toBe(key);
      expect(resolveField(`  ${KEY_LABELS[key].toUpperCase()} `)).toBe(key);
    }
  });

  // resolveField and the write path compare against the key alone. That covers the label only
  // while each label folds to its key: one that stops doing so fails here, and the label has to
  // be matched as a name of its own again.
  it("every label folds to its key", () => {
    for (const key of CURATED_KEYS) expect(fieldName(KEY_LABELS[key]), key).toBe(fieldName(key));
  });

  // The whole-name pass changes no answer for a name while no name prefixes another. This is the
  // tripwire: a new key that breaks it fails here, instead of silently depending on that pass to
  // keep a whole name from reading as "ambiguous, re-ask".
  it("no curated name is a proper prefix of another", () => {
    const names = CURATED_KEYS.map(fieldName);
    for (const name of names) {
      expect(
        names.filter((other) => other !== name && other.startsWith(name)),
        name,
      ).toEqual([]);
    }
  });

  // An alias matches whole and wins over a prefix, so one that is the start of another key's name
  // would take that answer away from it (and the start of its own key's name is a prefix already:
  // it needs no alias). One shared by two keys would go to whichever key comes first. Aliases may
  // prefix each other: none matches by prefix.
  it("no alias is a name, the start of a name, `all`, or another key's alias", () => {
    const aliases = CURATED_KEYS.flatMap((key) => FIELD_ALIASES[key] ?? []);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const alias of aliases) {
      expect(fieldName(alias), alias).toBe(alias);
      expect(alias, alias).not.toBe("all");
      expect(
        CURATED_KEYS.filter((key) => fieldName(key).startsWith(alias)),
        alias,
      ).toEqual([]);
    }
  });

  it("every prefix of a name resolves to the names that start with it, aliases or not", () => {
    for (const key of CURATED_KEYS) {
      const name = fieldName(key);
      for (let end = 1; end <= name.length; end++) {
        const prefix = name.slice(0, end);
        // "ai " folds to "ai": the fold is what gets compared.
        const fits = CURATED_KEYS.filter((k) => fieldName(k).startsWith(fieldName(prefix)));
        expect(resolveField(prefix), prefix).toEqual(fits.length === 1 ? fits[0] : fits);
      }
    }
  });

  it("an alias names its field, in any case and with any separator", () => {
    expect(resolveField("wm")).toBe("window-manager");
    expect(resolveField(" WM ")).toBe("window-manager");
    expect(resolveField("vm")).toBe("version-manager");
    expect(resolveField("mux")).toBe("multiplexer");
    expect(resolveField("ai tools")).toBe("ai-tool");
    expect(resolveField("AI-Tools")).toBe("ai-tool");
    expect(resolveField("ai_tools")).toBe("ai-tool");
    // Whole only: an alias is not a prefix to extend or cut short.
    expect(resolveField("wmx")).toBeUndefined();
    expect(resolveField("mu")).toBe("multiplexer");
  });

  it("the start of a later word names the field, or every field it fits", () => {
    expect(resolveField("manager")).toEqual(["window-manager", "version-manager"]);
    expect(resolveField("man")).toEqual(["window-manager", "version-manager"]);
    expect(resolveField("tool")).toBe("ai-tool");
    // A name that starts with the answer outranks a later word: "m" stays Multiplexer.
    expect(resolveField("m")).toBe("multiplexer");
    expect(resolveField("anager")).toBeUndefined();
  });

  it("`a` is AI Tool, `al` is nothing, and `all` is the prompt's keyword, not a field", () => {
    expect(resolveField("a")).toBe("ai-tool");
    expect(resolveField("al")).toBeUndefined();
    expect(resolveField("all")).toBeUndefined();
  });

  it("an exact name beats a prefix, a shared prefix returns every fit", () => {
    expect(resolveField("os")).toBe("os");
    expect(resolveField("ai")).toBe("ai-tool");
    expect(resolveField("version manager")).toBe("version-manager");
    expect(resolveField("t")).toEqual(["terminal", "theme"]);
    // A half-typed hyphenated key: the hyphen folds to a space that must not survive.
    expect(resolveField("os-")).toBe("os");
    expect(resolveField("theme-")).toBe("theme");
    expect(resolveField("-editor")).toBe("editor");
    expect(resolveField("window-")).toBe("window-manager");
    expect(resolveField("keyboard")).toBeUndefined();
    expect(resolveField("   ")).toBeUndefined();
  });
});
