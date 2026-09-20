import { type CuratedKey, type Entry, type Profile, SCHEMA_VERSION } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import {
  applySet,
  applyUnset,
  buildDefaults,
  detectionDisagreements,
  entriesFromMap,
  profileChanges,
  sameContent,
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

describe("detectionDisagreements", () => {
  const ESC = String.fromCharCode(27);
  const RLO = String.fromCharCode(0x202e); // U+202E, a bidi control the card strips

  it("a saved value that names a different tool than the detection is reported with the detected value", () => {
    const out = detectionDisagreements(map([["editor", "Zed"]]), map([["editor", "Neovim"]]));
    expect([...out]).toEqual([["editor", "Neovim"]]);
  });
  it("same tool, different spelling is not a disagreement (the diff's canonical rule)", () => {
    const out = detectionDisagreements(
      map([
        ["editor", "nvim"],
        ["shell", "pwsh"],
        ["terminal", "VS  Code"],
      ]),
      map([
        ["editor", "Neovim"],
        ["shell", "PowerShell"],
        ["terminal", "vscode"],
      ]),
    );
    expect(out.size).toBe(0);
  });
  it("compares the SHOWN form: an invisible-char difference is not a disagreement", () => {
    expect(
      detectionDisagreements(map([["shell", "zsh"]]), map([["shell", `zsh${RLO}`]])).size,
    ).toBe(0);
    expect(
      detectionDisagreements(map([["shell", `zsh${RLO}`]]), map([["shell", "zsh"]])).size,
    ).toBe(0);
  });
  it("returns the shown (sanitized, trimmed) detected value, never the raw env string", () => {
    const out = detectionDisagreements(
      map([["editor", "Vim"]]),
      map([["editor", ` Neo${ESC}[2Jvim `]]),
    );
    expect(out.get("editor")).toBe("Neovim");
  });
  it("a detected value that sanitizes to nothing is not a disagreement", () => {
    expect(
      detectionDisagreements(map([["editor", "Vim"]]), map([["editor", `${ESC}[31m`]])).size,
    ).toBe(0);
  });
  it("a key only one side has is not a disagreement (a filled gap, or a clear, stands)", () => {
    expect(detectionDisagreements(map([]), map([["editor", "Neovim"]])).size).toBe(0);
    expect(detectionDisagreements(map([["editor", "Vim"]]), map([])).size).toBe(0);
  });
  it("a key decided this session is not a disagreement", () => {
    const out = detectionDisagreements(
      map([["editor", "Zed"]]),
      map([["editor", "Neovim"]]),
      new Set<CuratedKey>(["editor"]),
    );
    expect(out.size).toBe(0);
  });
  it("reports keys in CURATED_KEYS order regardless of input order", () => {
    const out = detectionDisagreements(
      map([
        ["shell", "zsh"],
        ["editor", "Zed"],
      ]),
      map([
        ["shell", "fish"],
        ["editor", "Neovim"],
      ]),
    );
    expect([...out.keys()]).toEqual(["editor", "shell"]);
  });
});

describe("profileChanges", () => {
  const live = prof([
    { key: "editor", value: "Zed" },
    { key: "shell", value: "zsh" },
  ]);

  it("the live values republished as they are: nothing changes", () => {
    const values = buildDefaults(live, map([]));
    expect(profileChanges(live, values).size).toBe(0);
  });
  it("changed and cleared keys carry the live value, a new key carries null, in CURATED_KEYS order", () => {
    const out = profileChanges(
      live,
      map([
        ["font", "Lilex"],
        ["editor", "Neovim"],
      ]),
    );
    expect([...out]).toEqual([
      ["editor", "Zed"],
      ["shell", "zsh"],
      ["font", null],
    ]);
  });
  it("a respelling of the same tool is a change (raw, not canonical: the stored string differs)", () => {
    const out = profileChanges(prof([{ key: "editor", value: "vim" }]), map([["editor", "Vim"]]));
    expect([...out]).toEqual([["editor", "vim"]]);
  });
  it("a padded stored value is not a change: the defaults it was merged into are trimmed too", () => {
    const padded = prof([{ key: "editor", value: "  Vim " }]);
    expect(profileChanges(padded, buildDefaults(padded, map([]))).size).toBe(0);
  });
  it("a whitespace-only stored value is absent on both sides", () => {
    const blank = prof([{ key: "editor", value: "   " }]);
    expect(profileChanges(blank, buildDefaults(blank, map([["editor", "Vim"]]))).size).toBe(0);
  });
  it("a detection that fills a gap is a new key", () => {
    const out = profileChanges(live, buildDefaults(live, map([["os", "Arch"]])));
    expect([...out]).toEqual([["os", null]]);
  });
  it("newer-taxonomy keys are ignored: publish carries them through verbatim", () => {
    const p = prof([
      { key: "launcher", value: "Raycast" } as unknown as Entry,
      { key: "editor", value: "Zed" },
    ]);
    expect(profileChanges(p, map([["editor", "Zed"]])).size).toBe(0);
  });
  it("does not mutate the live profile", () => {
    const p = prof([{ key: "editor", value: " Zed " }]);
    profileChanges(p, map([["editor", "Vim"]]));
    expect(p.entries).toEqual([{ key: "editor", value: " Zed " }]);
  });
});

describe("sameContent", () => {
  const live = prof([{ key: "editor", value: "Vim" }], [{ label: "Keyboard", value: "HHKB" }]);

  it("setting a curated key or an extra to what is stored is the same content", () => {
    const curated = applySet(live, { kind: "curated", key: "editor", value: "Vim" });
    expect(sameContent(live, curated.entries, curated.extras)).toBe(true);
    const extra = applySet(live, { kind: "extra", label: "Keyboard", value: "HHKB" });
    expect(sameContent(live, extra.entries, extra.extras)).toBe(true);
  });
  it("a new value, a new key, and a new extra are not", () => {
    for (const target of [
      { kind: "curated", key: "editor", value: "Zed" },
      { kind: "curated", key: "shell", value: "zsh" },
      { kind: "extra", label: "Launcher", value: "Raycast" },
    ] as const) {
      const next = applySet(live, target);
      expect(sameContent(live, next.entries, next.extras)).toBe(false);
    }
  });
  it("entries compare by key, not position; extras compare in order", () => {
    const a = { key: "editor", value: "Vim" } as const;
    const b = { key: "shell", value: "zsh" } as const;
    const x = { label: "Keyboard", value: "HHKB" };
    const y = { label: "Launcher", value: "Raycast" };
    expect(sameContent(prof([a, b], [x, y]), [b, a], [x, y])).toBe(true);
    expect(sameContent(prof([a, b], [x, y]), [a, b], [y, x])).toBe(false);
    expect(sameContent(prof([a, b]), [a], [])).toBe(false);
  });
  it("the same number of entries under different keys is not the same content", () => {
    // What a walk that clears one key and fills another sends: the lengths match, the keys do not.
    const stored = prof([
      { key: "editor", value: "Vim" },
      { key: "shell", value: "zsh" },
    ]);
    const sent = [
      { key: "editor", value: "Vim" },
      { key: "font", value: "Lilex" },
    ] as Entry[];
    expect(sameContent(stored, sent, [])).toBe(false);
  });
  it("an extra label's casing is a real change (applySet rewrites the stored label)", () => {
    const next = applySet(live, { kind: "extra", label: "keyboard", value: "HHKB" });
    expect(sameContent(live, next.entries, next.extras)).toBe(false);
  });
  it("a respelled curated value is a real change", () => {
    const next = applySet(live, { kind: "curated", key: "editor", value: "vim" });
    expect(sameContent(live, next.entries, next.extras)).toBe(false);
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
