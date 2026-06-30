import type { DiffResult, Profile } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import {
  notFound,
  nudge,
  renderDiff,
  renderProfile,
  sanitizeValue,
  useColor,
} from "../src/render.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const AMBER = `${ESC}[93m`;

describe("sanitizeValue (terminal-escape injection)", () => {
  it("strips ANSI color sequences", () => {
    expect(sanitizeValue(`${ESC}[31mred${ESC}[0m`)).toBe("red");
  });
  it("strips a clear-screen sequence + a lone ESC, BEL, and newlines", () => {
    expect(sanitizeValue(`${ESC}[2Ja\nb${BEL}c${ESC}`)).toBe("abc");
  });
  it("leaves ordinary values untouched", () => {
    expect(sanitizeValue("Neovim 0.10")).toBe("Neovim 0.10");
  });
  it("strips Unicode bidi overrides (Trojan-Source display spoofing)", () => {
    const RLO = String.fromCharCode(0x202e); // right-to-left override
    expect(sanitizeValue(`zsh${RLO}evil`)).toBe("zshevil");
  });
});

describe("useColor", () => {
  it("NO_COLOR disables color even when set to empty (no-color.org)", () => {
    expect(useColor({ NO_COLOR: "" }, true)).toBe(false);
  });
  it("NO_COLOR wins over FORCE_COLOR", () => {
    expect(useColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
  });
  it("FORCE_COLOR forces color off a TTY", () => {
    expect(useColor({ FORCE_COLOR: "1" }, false)).toBe(true);
  });
  it("FORCE_COLOR=0 force-disables color even on a TTY (supports-color convention)", () => {
    expect(useColor({ FORCE_COLOR: "0" }, true)).toBe(false);
  });
  it("otherwise follows the TTY state", () => {
    expect(useColor({}, true)).toBe(true);
    expect(useColor({}, false)).toBe(false);
  });
});

const DIFF: DiffResult = {
  rows: [
    { key: "editor", label: "Editor", mine: "Neovim", theirs: "Neovim", status: "same" },
    { key: "shell", label: "Shell", mine: "zsh", theirs: "fish", status: "changed" },
  ],
  extras: { mine: [], theirs: [] },
  differ: 1,
  shared: 1,
};

describe("renderDiff", () => {
  it("color mode: amber marks the differing row; footer is the thesis line", () => {
    const out = renderDiff(DIFF, { color: true, theirsLabel: "antfu", mineLabel: "you" });
    expect(out).toContain(AMBER);
    expect(out).toMatch(/1 differ · 1 shared — your mileage may vary/);
  });

  it("NO_COLOR mode: zero ANSI; `~`/`=` symbols carry which rows differ", () => {
    const out = renderDiff(DIFF, { color: false, theirsLabel: "antfu", mineLabel: "you" });
    expect(out).not.toContain(ESC);
    expect(out).toMatch(/^~ Shell/m);
    expect(out).toMatch(/^= Editor/m);
  });

  it("sanitizes an injected value before it reaches the terminal", () => {
    const evil: DiffResult = {
      rows: [
        { key: "shell", label: "Shell", mine: "zsh", theirs: `${ESC}[2Jboom`, status: "changed" },
      ],
      extras: { mine: [], theirs: [] },
      differ: 1,
      shared: 0,
    };
    const out = renderDiff(evil, { color: false, theirsLabel: "x", mineLabel: "you" });
    expect(out).not.toContain(ESC);
    expect(out).toContain("boom");
  });

  it("renders the — placeholder for one-sided rows and a separate extras block", () => {
    const d: DiffResult = {
      rows: [
        { key: "editor", label: "Editor", mine: "Neovim", theirs: null, status: "only_mine" },
        { key: "shell", label: "Shell", mine: null, theirs: "fish", status: "only_theirs" },
      ],
      extras: {
        mine: [{ label: "WM", value: "Hyprland" }],
        theirs: [{ label: "Launcher", value: "Raycast" }],
      },
      differ: 2,
      shared: 0,
    };
    const out = renderDiff(d, { color: false, theirsLabel: "antfu", mineLabel: "you" });
    expect(out).toContain("—"); // the absent-side placeholder
    expect(out).toMatch(/extras/);
    expect(out).toContain("Hyprland");
    expect(out).toContain("Raycast");
    expect(out).toMatch(/2 differ · 0 shared/);
  });
});

describe("renderProfile", () => {
  it("shows the handle + values but never spends amber (scarcity rule)", () => {
    const p: Profile = {
      schema_version: 1,
      handle: "antfu",
      entries: [{ key: "shell", value: "fish" }],
      extras: [],
      updated_at: "2026-01-01",
    };
    const out = renderProfile(p, { color: true });
    expect(out).toContain("antfu");
    expect(out).toContain("fish");
    expect(out).not.toContain(AMBER);
  });

  it("renders an empty profile (no entries/extras) without crashing", () => {
    const empty: Profile = {
      schema_version: 1,
      handle: "x",
      entries: [],
      extras: [],
      updated_at: "t",
    };
    expect(renderProfile(empty, { color: false })).toContain("x");
  });
});

describe("nudge / notFound", () => {
  it("nudge is the one amber CTA (plain under NO_COLOR)", () => {
    expect(nudge(true)).toContain(AMBER);
    expect(nudge(false)).not.toContain(ESC);
    expect(nudge(false)).toMatch(/publish yours to diff/);
  });
  it("notFound names the handle", () => {
    expect(notFound("ghost")).toMatch(/no ymmv profile for "ghost"/);
  });
});
