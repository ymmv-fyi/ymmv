import { type CuratedKey, type Profile, SCHEMA_VERSION } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import { applySet, buildDefaults, entriesFromMap } from "../src/profile-ops.js";

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
  it("does not mutate the input profile", () => {
    const original = prof([{ key: "editor", value: "Vim" }]);
    applySet(original, { kind: "curated", key: "editor", value: "Neovim" });
    expect(original.entries).toEqual([{ key: "editor", value: "Vim" }]);
  });
});
