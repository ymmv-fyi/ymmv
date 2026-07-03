import type { DiffResult, Profile } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import {
  displayUrl,
  isHttpUrl,
  link,
  message,
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
  it("TERM=dumb disables color on a TTY, but an explicit FORCE_COLOR still wins", () => {
    expect(useColor({ TERM: "dumb" }, true)).toBe(false);
    expect(useColor({ TERM: "dumb", FORCE_COLOR: "1" }, false)).toBe(true);
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
    expect(out).toMatch(/1 differ {3}1 shared/);
  });

  it("NO_COLOR mode: zero ANSI; `~`/`=` symbols carry which rows differ", () => {
    const out = renderDiff(DIFF, { color: false, theirsLabel: "antfu", mineLabel: "you" });
    expect(out).not.toContain(ESC);
    expect(out).toMatch(/^~ Shell/m);
    expect(out).toMatch(/^= Editor/m);
  });

  it("opens with the web's title line in both color modes", () => {
    const plain = renderDiff(DIFF, { color: false, theirsLabel: "antfu", mineLabel: "you" });
    expect(plain).toContain("  how antfu differs from you");
    const color = renderDiff(DIFF, { color: true, theirsLabel: "antfu", mineLabel: "you" });
    expect(color).toContain(`${ESC}[1mantfu${ESC}[0m`);
    expect(color).toMatch(/how/);
    expect(color).toMatch(/differs from/);
  });

  it("uppercases the column headers (web parity), leaving row values untouched", () => {
    const out = renderDiff(DIFF, { color: false, theirsLabel: "antfu", mineLabel: "you" });
    expect(out).toMatch(/ANTFU\s+YOU/);
    expect(out).toContain("fish"); // values keep their case
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
    expect(out).toMatch(/2 differ {3}0 shared/);
  });
});

describe("renderProfile", () => {
  const SITE = "ymmv.fyi";
  const at = (iso: string) => () => Date.parse(iso);

  it("shows the handle + values but never spends amber on plain values (scarcity rule)", () => {
    const p: Profile = {
      schema_version: 1,
      handle: "antfu",
      entries: [{ key: "shell", value: "fish" }],
      extras: [],
      updated_at: "2026-01-01",
    };
    const out = renderProfile(p, { color: true, site: SITE });
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
    expect(renderProfile(empty, { color: false, site: SITE })).toContain("x");
  });

  const FULLISH: Profile = {
    schema_version: 1,
    handle: "carol",
    entries: [
      { key: "editor", value: "Zed" },
      { key: "dotfiles", value: "https://git.io/etc" },
    ],
    extras: [{ label: "Keyboard", value: "HHKB" }],
    updated_at: "2026-07-02T09:00:00.000Z",
  };
  const NOW = "2026-07-02T12:00:00.000Z";

  it("heads the card with the web breadcrumb: faint site/ + bold handle", () => {
    const out = renderProfile(FULLISH, { color: true, site: SITE, now: at(NOW) });
    const ESC_ = String.fromCharCode(27);
    expect(out).toContain(`  ${ESC_}[90mymmv.fyi/${ESC_}[0m${ESC_}[1mcarol${ESC_}[0m`);
    const plain = renderProfile(FULLISH, { color: false, site: SITE, now: at(NOW) });
    expect(plain).toContain("  ymmv.fyi/carol");
  });

  it("URL values render as amber links (the web rule: amber = links + diffs)", () => {
    const out = renderProfile(FULLISH, { color: true, site: SITE, now: at(NOW) });
    expect(out).toContain(`${AMBER}git.io/etc`);
    expect(out).toContain(OSC8_OPEN);
    const plain = renderProfile(FULLISH, { color: false, site: SITE, now: at(NOW) });
    expect(plain).toContain("https://git.io/etc"); // full URL, machine-readable
    expect(plain).not.toContain(ESC);
  });

  it("humanizes the updated line in view mode", () => {
    const out = renderProfile(FULLISH, { color: false, site: SITE, now: at(NOW) });
    expect(out).toContain("updated 3h ago");
  });

  it("view mode hides unset keys — no — gap rows, no unset labels (preview must not leak)", () => {
    const out = renderProfile(FULLISH, { color: false, site: SITE, now: at(NOW) });
    expect(out).not.toContain("—");
    expect(out).not.toContain("Font");
    expect(out).not.toContain("Version Manager");
  });

  it("renders extras rows and linkifies URL extras like curated values", () => {
    const p: Profile = {
      ...FULLISH,
      extras: [
        { label: "Keyboard", value: "HHKB" },
        { label: "Blog", value: "https://ex.io/b" },
      ],
    };
    const plain = renderProfile(p, { color: false, site: SITE, now: at(NOW) });
    expect(plain).toMatch(/Keyboard\s+HHKB/);
    expect(plain).toContain("https://ex.io/b"); // full URL when color is off
    const color = renderProfile(p, { color: true, site: SITE, now: at(NOW) });
    expect(color).toContain(`${AMBER}ex.io/b`); // URL extras get the link treatment too
  });

  it("preview mode lists all 13 curated labels, marks gaps with —, and drops updated", () => {
    const out = renderProfile(FULLISH, {
      color: false,
      site: SITE,
      mode: "preview",
      now: at(NOW),
    });
    expect(out).toContain("Editor");
    expect(out).toContain("Version Manager"); // widest label, present as a gap row
    expect(out).toMatch(/Font\s+—/);
    expect(out).toContain("Zed");
    expect(out).not.toContain("updated");
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

describe("output units (spacing convention)", () => {
  it("message() opens with one blank line and indents the text two spaces", () => {
    expect(message("Published x")).toBe("\n  Published x");
  });
  it("message() indents every non-empty line of a multi-line text", () => {
    expect(message("a\nb")).toBe("\n  a\n  b");
  });
  it("message() leaves empty interior lines empty (no whitespace-only lines)", () => {
    expect(message("a\n\nb")).toBe("\n  a\n\n  b");
  });
  it("message() normalizes CRLF (a thrown Error.message may carry it)", () => {
    expect(message("a\r\nb")).toBe("\n  a\n  b");
  });
  it("every render builder returns a unit: one leading blank line, no trailing newline", () => {
    const p: Profile = {
      schema_version: 1,
      handle: "carol",
      entries: [{ key: "editor", value: "Zed" }],
      extras: [],
      updated_at: "2026-07-02T09:00:00.000Z",
    };
    const units = [
      renderProfile(p, { color: false, site: "ymmv.fyi" }),
      renderProfile(p, { color: false, site: "ymmv.fyi", mode: "preview" }),
      renderDiff(DIFF, { color: false, theirsLabel: "antfu", mineLabel: "you" }),
      nudge(false),
      notFound("ghost", false, "https://ymmv.fyi"),
    ];
    for (const unit of units) {
      expect(unit).toMatch(/^\n(?!\n)/); // exactly one leading blank line
      expect(unit).not.toMatch(/\n$/); // console.log terminates the line — no self-carried blank
    }
  });
});
