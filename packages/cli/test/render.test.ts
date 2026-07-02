import type { DiffResult, Profile } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import {
  displayUrl,
  isHttpUrl,
  link,
  notFound,
  nudge,
  relTime,
  renderDiff,
  renderProfile,
  sanitizeValue,
  useColor,
} from "../src/render.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const AMBER = `${ESC}[93m`;
const OSC8_OPEN = `${ESC}]8;;`;

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

describe("displayUrl / isHttpUrl", () => {
  it("strips only the leading https:// for display", () => {
    expect(displayUrl("https://git.io/etc")).toBe("git.io/etc");
    expect(displayUrl("  https://git.io/etc  ")).toBe("git.io/etc");
  });
  it("keeps http:// (it is information) and a bare scheme intact", () => {
    expect(displayUrl("http://old.example")).toBe("http://old.example");
    expect(displayUrl("https://")).toBe("https://");
  });
  it("isHttpUrl accepts whole-value http(s) URLs only", () => {
    expect(isHttpUrl("https://git.io/etc")).toBe(true);
    expect(isHttpUrl("http://git.io/etc")).toBe(true);
    expect(isHttpUrl(" https://git.io/etc ")).toBe(true);
    expect(isHttpUrl("git.io/etc")).toBe(false);
    expect(isHttpUrl("see https://git.io/etc")).toBe(false);
    expect(isHttpUrl("ftp://host")).toBe(false);
  });
});

describe("link", () => {
  it("color mode: OSC-8 wraps the full URL, display is amber + shortened", () => {
    const out = link("https://git.io/etc", true, "xterm-256color");
    expect(out).toBe(
      `${OSC8_OPEN}https://git.io/etc${ESC}\\${AMBER}git.io/etc${ESC}[0m${OSC8_OPEN}${ESC}\\`,
    );
  });
  it("plain mode: the full URL, no ANSI, no shortening", () => {
    const out = link("https://git.io/etc", false);
    expect(out).toBe("https://git.io/etc");
    expect(out).not.toContain(ESC);
  });
  it("TERM=linux/dumb: amber text, zero OSC-8 bytes (denylist)", () => {
    for (const term of ["linux", "dumb"]) {
      const out = link("https://git.io/etc", true, term);
      expect(out).toBe(`${AMBER}git.io/etc${ESC}[0m`);
      expect(out).not.toContain(OSC8_OPEN);
    }
  });
  it("an injected escape can neither terminate the OSC early nor survive display", () => {
    const out = link(`https://x.io/${ESC}${BEL}evil`, true, "xterm");
    expect(out).toContain("https://x.io/evil");
    expect(out).not.toContain(BEL);
    expect(out.split(`${ESC}\\`).length).toBe(3); // exactly the two ST terminators we emit
  });
});

describe("relTime", () => {
  const at = (iso: string) => () => Date.parse(iso);
  const NOW = "2026-07-02T12:00:00.000Z";
  it("humanizes wire timestamps relative to the injected clock", () => {
    expect(relTime("2026-07-02T11:59:30.000Z", at(NOW))).toBe("just now");
    expect(relTime("2026-07-02T11:55:00.000Z", at(NOW))).toBe("5m ago");
    expect(relTime("2026-07-02T09:00:00.000Z", at(NOW))).toBe("3h ago");
    expect(relTime("2026-06-30T12:00:00.000Z", at(NOW))).toBe("2d ago");
  });
  it("falls back to the plain date past ~30 days", () => {
    expect(relTime("2026-05-18T12:00:00.000Z", at(NOW))).toBe("2026-05-18");
  });
  it("a FUTURE stamp (clock skew) reads as just now, never negative", () => {
    expect(relTime("2026-07-02T12:03:00.000Z", at(NOW))).toBe("just now");
  });
  it("unparseable input comes back raw but sanitized", () => {
    expect(relTime("not-a-date", at(NOW))).toBe("not-a-date");
    expect(relTime(`${ESC}[2Jt`, at(NOW))).toBe("t");
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
  it("color mode: amber marks BOTH values of the differing row; footer is the thesis line", () => {
    const out = renderDiff(DIFF, { color: true, theirsLabel: "antfu", mineLabel: "you" });
    expect(out).toContain(`${AMBER}fish`); // theirs column ambers too — a difference is symmetric
    expect(out).toContain(`${AMBER}zsh`);
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
  it("notFound names the handle and links the site (plain URL when color is off)", () => {
    const out = notFound("ghost", false, "https://ymmv.fyi");
    expect(out).toMatch(/no ymmv profile for "ghost"/);
    expect(out).toContain("publish one at https://ymmv.fyi with: npx ymmv-cli");
    expect(out).not.toContain(ESC);
    expect(notFound("ghost", true, "https://ymmv.fyi")).toContain(`${AMBER}ymmv.fyi`);
  });
});
