import { type CuratedKey, type Entry, type Profile, SCHEMA_VERSION } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import {
  applySet,
  applyUnset,
  buildDefaults,
  entriesFromMap,
  unknownEntries,
} from "../src/profile-ops.js";

function prof(entries: Profile["entries"] = [], extras: Profile["extras"] = []): Profile {
  return { schema_version: SCHEMA_VERSION, handle: "me", entries, extras, updated_at: "x" };
}
const map = (pairs: [CuratedKey, string][]): Map<CuratedKey, string> => new Map(pairs);

describe("buildDefaults", () => {
  it("an existing published value wins over a fresh detection", () => {
    const d = buildDefaults(prof([{ key: "editor", value: "Vim" }]), map([["editor", "Neovim"]]));
    expect(d.get("editor")).toBe("Vim");
  });
  it("detection fills the keys the profile lacks", () => {
    const d = buildDefaults(prof([{ key: "editor", value: "Vim" }]), map([["os", "Arch"]]));
    expect(d.get("os")).toBe("Arch");
  });
  it("null existing → pure detection", () => {
    expect(buildDefaults(null, map([["shell", "zsh"]])).get("shell")).toBe("zsh");
  });
});

describe("entriesFromMap", () => {
  it("emits entries in canonical CURATED_KEYS order", () => {
    const out = entriesFromMap(
      map([
        ["shell", "zsh"],
        ["editor", "Vim"],
      ]),
    );
    expect(out.map((e) => e.key)).toEqual(["editor", "shell"]);
  });
});

// A newer CLI/server taxonomy can publish keys this build doesn't know. Bare publish is a full
// replace, so those keys must ride through verbatim or an old CLI silently deletes them.
describe("unknownEntries", () => {
  const foreign = [
    { key: "launcher", value: "Raycast" } as unknown as Entry,
    { key: "hairstyle", value: "mohawk" } as unknown as Entry,
  ];
  it("null profile → []", () => {
    expect(unknownEntries(null)).toEqual([]);
  });
  it("all-curated profile → []", () => {
    expect(unknownEntries(prof([{ key: "editor", value: "Vim" }]))).toEqual([]);
  });
  it("returns only the foreign entries, verbatim, order preserved", () => {
    const p = prof([foreign[0] as Entry, { key: "editor", value: "Vim" }, foreign[1] as Entry]);
    expect(unknownEntries(p)).toEqual([foreign[0], foreign[1]]);
  });
  it("buildDefaults never leaks a foreign key into the prompt defaults", () => {
    const d = buildDefaults(prof([foreign[0] as Entry, { key: "editor", value: "Vim" }]), map([]));
    expect([...d.keys()]).toEqual(["editor"]);
  });
  // set/unset republish the full profile too — pin that their preservation of newer-taxonomy
  // keys is a contract, not an accident of copying existing.entries verbatim.
  it("applySet keeps foreign entries through the full-replace republish", () => {
    const { entries } = applySet(prof([foreign[0] as Entry]), {
      kind: "curated",
      key: "editor",
      value: "Vim",
    });
    expect(entries).toContainEqual(foreign[0]);
  });
  it("applyUnset keeps foreign entries when removing another key", () => {
    const { entries } = applyUnset(prof([foreign[0] as Entry, { key: "editor", value: "Vim" }]), {
      kind: "curated",
      key: "editor",
    });
    expect(entries).toEqual([foreign[0]]);
  });
});

describe("applySet", () => {
  it("curated: replaces an existing key in place", () => {
    const { entries } = applySet(prof([{ key: "editor", value: "Vim" }]), {
      kind: "curated",
      key: "editor",
      value: "Neovim",
    });
    expect(entries).toEqual([{ key: "editor", value: "Neovim" }]);
  });
  it("curated: appends a new key", () => {
    const { entries } = applySet(prof([{ key: "editor", value: "Vim" }]), {
      kind: "curated",
      key: "shell",
      value: "zsh",
    });
    expect(entries).toEqual([
      { key: "editor", value: "Vim" },
      { key: "shell", value: "zsh" },
    ]);
  });
  it("extra: upserts by case-insensitive label", () => {
    const { extras } = applySet(prof([], [{ label: "Launcher", value: "Alfred" }]), {
      kind: "extra",
      label: "launcher",
      value: "Raycast",
    });
    expect(extras).toEqual([{ label: "launcher", value: "Raycast" }]);
  });
  it("extra: matches a whitespace-padded stored label and replaces it with the clean one", () => {
    const { extras } = applySet(prof([], [{ label: " Keyboard ", value: "HHKB" }]), {
      kind: "extra",
      label: "keyboard",
      value: "MX",
    });
    expect(extras).toEqual([{ label: "keyboard", value: "MX" }]);
  });
  it("does not mutate the input profile", () => {
    const original = prof([{ key: "editor", value: "Vim" }]);
    applySet(original, { kind: "curated", key: "editor", value: "Neovim" });
    expect(original.entries).toEqual([{ key: "editor", value: "Vim" }]);
  });
});

describe("applyUnset", () => {
  it("curated: removes the key, keeps the rest, reports the raw key + old value", () => {
    const { entries, removed } = applyUnset(
      prof([
        { key: "editor", value: "Vim" },
        { key: "shell", value: "zsh" },
      ]),
      { kind: "curated", key: "shell" },
    );
    expect(entries).toEqual([{ key: "editor", value: "Vim" }]);
    expect(removed).toEqual({ label: "shell", value: "zsh" });
  });
  it("curated: absent key → removed null, entries unchanged", () => {
    const { entries, removed } = applyUnset(prof([{ key: "editor", value: "Vim" }]), {
      kind: "curated",
      key: "multiplexer",
    });
    expect(removed).toBeNull();
    expect(entries).toEqual([{ key: "editor", value: "Vim" }]);
  });
  it("extra: removes by case-insensitive label, reporting the stored casing", () => {
    const { extras, removed } = applyUnset(prof([], [{ label: "Keyboard", value: "HHKB" }]), {
      kind: "extra",
      label: "keyboard",
    });
    expect(extras).toEqual([]);
    expect(removed).toEqual({ label: "Keyboard", value: "HHKB" });
  });
  it("extra: matches a whitespace-padded stored label (foreign clients store labels verbatim)", () => {
    const { extras, removed } = applyUnset(prof([], [{ label: " Keyboard ", value: "HHKB" }]), {
      kind: "extra",
      label: "keyboard",
    });
    expect(extras).toEqual([]);
    expect(removed).toEqual({ label: " Keyboard ", value: "HHKB" });
  });
  it("extra: absent label → removed null, extras unchanged", () => {
    const { extras, removed } = applyUnset(prof([], [{ label: "Launcher", value: "Raycast" }]), {
      kind: "extra",
      label: "keyboard",
    });
    expect(removed).toBeNull();
    expect(extras).toEqual([{ label: "Launcher", value: "Raycast" }]);
  });
  it("extra: removes ALL case-insensitive duplicates, echoing the first's stored casing", () => {
    const { extras, removed } = applyUnset(
      prof(
        [],
        [
          { label: "Keyboard", value: "HHKB" },
          { label: "Launcher", value: "Raycast" },
          { label: "keyboard", value: "MX" },
        ],
      ),
      { kind: "extra", label: "KEYBOARD" },
    );
    expect(extras).toEqual([{ label: "Launcher", value: "Raycast" }]);
    expect(removed).toEqual({ label: "Keyboard", value: "HHKB" });
  });
  it("removing the only entry leaves entries: [] (valid to publish)", () => {
    const { entries, removed } = applyUnset(prof([{ key: "editor", value: "Vim" }]), {
      kind: "curated",
      key: "editor",
    });
    expect(entries).toEqual([]);
    expect(removed).toEqual({ label: "editor", value: "Vim" });
  });
  it("does not mutate the input profile", () => {
    const original = prof(
      [{ key: "editor", value: "Vim" }],
      [{ label: "Keyboard", value: "HHKB" }],
    );
    applyUnset(original, { kind: "curated", key: "editor" });
    applyUnset(original, { kind: "extra", label: "keyboard" });
    expect(original.entries).toEqual([{ key: "editor", value: "Vim" }]);
    expect(original.extras).toEqual([{ label: "Keyboard", value: "HHKB" }]);
  });
});
