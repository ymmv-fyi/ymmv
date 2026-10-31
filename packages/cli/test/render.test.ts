import { type CuratedKey, type DiffResult, MAX_VALUE, type Profile } from "@ymmv/shared";
import { describe, expect, it, vi } from "vitest";
import {
  diffPageUrl,
  isHttpUrl,
  link,
  linkForm,
  message,
  notFound,
  nudge,
  profilePageUrl,
  relTime,
  renderDiff,
  renderProfile,
  sanitizeValue,
  shownValue,
  takeLine,
  useColor,
} from "../src/render.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const AMBER = `${ESC}[93m`;
const OSC8_OPEN = `${ESC}]8;;`;

describe("shownValue (the form a prompt's default and the card show)", () => {
  it("sanitizes, then trims: whitespace an escape was hiding goes too", () => {
    expect(shownValue(`  Neo${ESC}[2Jvim  `)).toBe("Neovim");
    expect(shownValue(` ${ESC}[31m `)).toBe("");
  });
  it("leaves a clean value, inner spacing included, untouched", () => {
    expect(shownValue("VS Code")).toBe("VS Code");
  });
});

describe("takeLine (one marked row as publish's per-key question)", () => {
  it("pads the label so a run of questions lines up, with no indent of its own", () => {
    expect(takeLine("Editor", 8, "Zed", "Neovim", false)).toBe("Editor    Zed → Neovim");
    expect(takeLine("Terminal", 8, "WezTerm", "VS Code", false)).toBe(
      "Terminal  WezTerm → VS Code",
    );
  });
  it("sanitizes both values: the saved one is off the wire, the detected one from the env", () => {
    const line = takeLine("Editor", 6, `Z${ESC}[31med`, `Neo${ESC}[2Jvim`, false);
    expect(line).toBe("Editor  Zed → Neovim");
  });
  it("never links a URL value, and color dims the label and the arrow only", () => {
    const line = takeLine("Dotfiles", 8, "https://a.example/x", "https://b.example/y", true);
    expect(line).not.toContain(OSC8_OPEN);
    expect(line).not.toContain(AMBER);
    expect(line).toBe(
      `${ESC}[90mDotfiles${ESC}[0m  https://a.example/x ${ESC}[90m→${ESC}[0m https://b.example/y`,
    );
  });
});

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
  it("strips one control from each Bidi_Control range (embedding, isolate, mark, ALM)", () => {
    const cp = (n: number) => String.fromCharCode(n);
    expect(sanitizeValue(`a${cp(0x202a)}b${cp(0x2066)}c${cp(0x200e)}d${cp(0x061c)}e`)).toBe(
      "abcde",
    );
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

  it("FORCE_COLOR=false force-disables too (supports-color treats it like 0)", () => {
    expect(useColor({ FORCE_COLOR: "false" }, true)).toBe(false);
  });

  it("FORCE_COLOR= (empty) still force-ENABLES (supports-color convention)", () => {
    expect(useColor({ FORCE_COLOR: "" }, false)).toBe(true);
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

describe("isHttpUrl", () => {
  it("accepts whole-value http(s) URLs only", () => {
    expect(isHttpUrl("https://git.io/etc")).toBe(true);
    expect(isHttpUrl("http://git.io/etc")).toBe(true);
    expect(isHttpUrl(" https://git.io/etc ")).toBe(true);
    expect(isHttpUrl("git.io/etc")).toBe(false);
    expect(isHttpUrl("see https://git.io/etc")).toBe(false);
    expect(isHttpUrl("ftp://host")).toBe(false);
    // the parser rejects these, so they are text, never a link wearing their raw spoof as label
    expect(isHttpUrl("https://good.com@evil.com:99999")).toBe(false);
    expect(isHttpUrl("https://good.com@[evil.com]")).toBe(false);
  });
});

describe("linkForm", () => {
  it("reads the user's own user/repo as GitHub, and a host path as https", () => {
    expect(linkForm("me/dotfiles", "me")).toBe("https://github.com/me/dotfiles");
    expect(linkForm("me/.dotfiles", "me")).toBe("https://github.com/me/.dotfiles");
    expect(linkForm("me/dotfiles/", "me")).toBe("https://github.com/me/dotfiles");
    expect(linkForm("Me/dotfiles", "me")).toBe("https://github.com/Me/dotfiles"); // logins fold
    expect(linkForm(" github.com/me/dotfiles ", "me")).toBe("https://github.com/me/dotfiles");
    expect(linkForm("codeberg.org/you/dots/", "me")).toBe("https://codeberg.org/you/dots/");
    expect(linkForm("git.sr.ht/~me/dotfiles", "me")).toBe("https://git.sr.ht/~me/dotfiles");
  });

  it("never reads someone else's word/word as a repo: the offer defaults to yes", () => {
    for (const v of ["n/a", "N/A", "src/dotfiles", "yes/no", "nix/home-manager", "you/dotfiles"]) {
      expect(linkForm(v, "me"), v).toBeUndefined();
    }
  });

  it("only ever offers a value that links, and that is safe to print and to paste", () => {
    for (const v of ["me/dotfiles", "github.com/me/dotfiles", "git.sr.ht/~me/%7Edots/"]) {
      const url = linkForm(v, "me") ?? "";
      expect(isHttpUrl(url), v).toBe(true);
      // The non-TTY note prints this inside a command, unsanitized: the patterns are the guard.
      expect(url, v).toMatch(/^https:\/\/[A-Za-z0-9._~%+/-]+$/);
      expect(sanitizeValue(url), v).toBe(url);
    }
  });

  it("offers nothing when this runtime's URL parser refuses the https form", () => {
    // Which hosts a parser refuses varies by Node version (22 rejects `xn--a.example`, 26 takes
    // it), so the refusal is scripted: the rule under test is that a refused form is not offered.
    const canParse = vi.spyOn(URL, "canParse").mockReturnValue(false);
    try {
      expect(linkForm("github.com/me/dotfiles", "me")).toBeUndefined();
      expect(linkForm("me/dotfiles", "me")).toBeUndefined();
    } finally {
      canParse.mockRestore();
    }
    // Unscripted: whatever this runtime decides about a dubious host, offered still means linked.
    const dubious = linkForm("xn--a.example/x", "me");
    if (dubious !== undefined) expect(isHttpUrl(dubious)).toBe(true);
  });

  it("has nothing to offer for a value that already links", () => {
    expect(linkForm("https://github.com/me/dotfiles", "me")).toBeUndefined();
    expect(linkForm("http://git.io/etc", "me")).toBeUndefined();
  });

  it("leaves everything that is not plainly a repo or a host path as typed", () => {
    for (const v of [
      "",
      "dotfiles",
      "chezmoi.toml", // a filename: the slash is what makes a host path
      "example.com",
      "a/b/c", // three segments and no dotted host
      "me/..",
      "me/.",
      "~/dotfiles",
      "./dotfiles",
      "my dots/repo",
      "git@github.com:me/dotfiles.git",
      "github.com/me/dotfiles?tab=readme", // not paste-safe, so not offered
      "github.com/me/dotfiles#install",
      "github.com/me/$(id)",
      "ftp://host/path",
    ]) {
      expect(linkForm(v, "me"), v).toBeUndefined();
    }
  });

  it("never offers a form over the value cap", () => {
    const typed = `me/${"r".repeat(MAX_VALUE - 3)}`; // fits as typed, not with the prefix
    expect(typed.length).toBe(MAX_VALUE);
    expect(linkForm(typed, "me")).toBeUndefined();
    expect(linkForm(`me/${"r".repeat(MAX_VALUE - 22)}`, "me")).toHaveLength(MAX_VALUE);
  });

  it("never offers a host path the https prefix pushes over the cap", () => {
    const typed = `me.dev/${"p".repeat(MAX_VALUE - 7)}`; // fits as typed, not with the prefix
    expect(typed.length).toBe(MAX_VALUE);
    expect(linkForm(typed, "me")).toBeUndefined();
    expect(linkForm(`me.dev/${"p".repeat(MAX_VALUE - 15)}`, "me")).toHaveLength(MAX_VALUE);
  });

  it("reads a repo as two segments only, and leaves a host's own casing alone", () => {
    expect(linkForm("me/dot/files", "me")).toBeUndefined();
    expect(linkForm("me/../up", "me")).toBeUndefined();
    expect(linkForm("GitHub.com/me/dots", "me")).toBe("https://GitHub.com/me/dots");
  });
});

describe("link", () => {
  it("color mode: OSC-8 wraps the full URL, display is amber + shortened", () => {
    const out = link("https://git.io/etc", true, "xterm-256color");
    expect(out).toBe(
      `${OSC8_OPEN}https://git.io/etc${ESC}\\${AMBER}git.io/etc${ESC}[0m${OSC8_OPEN}${ESC}\\`,
    );
  });
  it("color mode: the display shows the parsed host (userinfo dropped); the OSC-8 target keeps it", () => {
    const out = link("https://good.com@evil.com/x", true, "xterm-256color");
    expect(out).toBe(
      `${OSC8_OPEN}https://good.com@evil.com/x${ESC}\\${AMBER}evil.com/x${ESC}[0m${OSC8_OPEN}${ESC}\\`,
    );
  });
  it("color mode: http:// keeps its scheme in the display (a cleartext target is information)", () => {
    const out = link("http://old.example/x", true, "xterm-256color");
    expect(out).toBe(
      `${OSC8_OPEN}http://old.example/x${ESC}\\${AMBER}http://old.example/x${ESC}[0m${OSC8_OPEN}${ESC}\\`,
    );
  });
  it("color mode: an IDN host displays as punycode while the OSC-8 target keeps the raw URL", () => {
    // Cyrillic а р р ӏ е: a lookalike of apple
    const raw = `https://${String.fromCodePoint(0x430, 0x440, 0x440, 0x4cf, 0x435)}.com/x`;
    const out = link(raw, true, "xterm-256color");
    expect(out).toBe(
      `${OSC8_OPEN}${raw}${ESC}\\${AMBER}xn--80ak6aa92e.com/x${ESC}[0m${OSC8_OPEN}${ESC}\\`,
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
  onlyTheirs: 0,
  onlyMine: 0,
};

const PAGE = "https://ymmv.fyi/antfu/vs/me";

describe("renderDiff", () => {
  it("shows a URL whole when shortening would make a differing row's cells match", () => {
    const d: DiffResult = {
      rows: [
        {
          key: "dotfiles",
          label: "Dotfiles",
          theirs: "https://good.com@evil.com",
          mine: "https://evil.com",
          status: "changed",
        },
      ],
      extras: { mine: [], theirs: [] },
      differ: 1,
      shared: 0,
      onlyTheirs: 0,
      onlyMine: 0,
    };
    const out = renderDiff(d, {
      color: true,
      theirsLabel: "antfu",
      mineLabel: "you",
      page: PAGE,
      term: "xterm-256color",
    });
    // Both shorten to `evil.com`, so neither does; each is still a link to its own address.
    expect(out).toContain(`${OSC8_OPEN}https://good.com@evil.com${ESC}\\https://good.com@evil.com`);
    expect(out).toContain(`${OSC8_OPEN}https://evil.com${ESC}\\https://evil.com${OSC8_OPEN}`);
  });

  describe("on a terminal (columns)", () => {
    const LONG = "https://github.com/antfu/dotfiles-but-with-a-very-long-path/blob/main/config";
    const LONGDIFF: DiffResult = {
      rows: [
        { key: "editor", label: "Editor", theirs: "VS Code", mine: "Zed", status: "changed" },
        { key: "os", label: "OS", theirs: "macOS 15.2", mine: "macOS 15.2", status: "same" },
        {
          key: "version-manager",
          label: "Version Manager",
          theirs: "mise",
          mine: "fnm",
          status: "changed",
        },
        { key: "dotfiles", label: "Dotfiles", theirs: LONG, mine: null, status: "only_theirs" },
      ],
      extras: { mine: [], theirs: [] },
      differ: 2,
      shared: 1,
      onlyTheirs: 1,
      onlyMine: 0,
    };
    const OPTS = { theirsLabel: "antfu", mineLabel: "bardisty", page: PAGE, term: "xterm" };
    // What the terminal shows: the line with its SGR codes and OSC-8 wrappers taken out.
    const visible = (line: string): string =>
      line
        .replace(new RegExp(`${ESC}\\]8;;[^${ESC}]*${ESC}\\\\`, "g"), "")
        .replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
    it("without columns (piped) prints every value whole, as before the cap", () => {
      const out = renderDiff(LONGDIFF, { ...OPTS, color: false });
      expect(out).toContain(`? Dotfiles         ${LONG}  —`);
      expect(out).toContain(`~ Editor           ${"VS Code".padEnd(LONG.length)}  Zed`);
      expect(out).not.toContain("…");
    });

    it("color off at 80 columns: every row fits and the long cell ends in …", () => {
      const out = renderDiff(LONGDIFF, { ...OPTS, color: false, columns: 80 });
      for (const l of out.split("\n")) expect(l.length).toBeLessThanOrEqual(80);
      // Color off keeps a URL whole when it fits (a terminal can detect it); one being cut
      // loses that anyway, so it drops `https://` first, as with color on.
      expect(out).toMatch(/^\? Dotfiles {9}github\.com\/antfu\/dotfiles-but-wi\S*… {2}—$/m);
      expect(out).toMatch(/^~ Editor {11}VS Code {2,}Zed$/m);
      expect(out).toMatch(/^= OS {15}macOS 15\.2 {2,}macOS 15\.2$/m);
    });

    it("color on at 80 columns: the URL shortens like the card's, links in full, and fits", () => {
      const out = renderDiff(LONGDIFF, { ...OPTS, color: true, columns: 80 });
      for (const l of out.split("\n")) expect(visible(l).length).toBeLessThanOrEqual(80);
      const dot = out.split("\n").find((l) => l.includes("Dotfiles")) ?? "";
      expect(dot).toContain(`${OSC8_OPEN}${LONG}${ESC}\\github.com/antfu/dotfiles-but-`);
      expect(visible(dot)).toMatch(/github\.com\/antfu\/dotfiles-but-\S*… {2}—$/);
      // The padding sits outside the link: no trailing spaces inside the OSC-8 text.
      expect(dot).not.toContain(`  ${OSC8_OPEN}${ESC}\\`);
    });

    it("at 120 columns a row that fits is left alone", () => {
      const out = renderDiff(LONGDIFF, { ...OPTS, color: true, columns: 120 });
      expect(out).not.toContain("…");
      expect(out).toContain("github.com/antfu/dotfiles-but-with-a-very-long-path/blob/main/config");
    });

    it("caps the second column too, keeping a short first column whole", () => {
      const d: DiffResult = {
        ...LONGDIFF,
        rows: [
          { key: "dotfiles", label: "Dotfiles", theirs: null, mine: LONG, status: "only_mine" },
        ],
      };
      const out = renderDiff(d, { ...OPTS, color: false, columns: 60 });
      for (const l of out.split("\n")) expect(l.length).toBeLessThanOrEqual(60);
      expect(out).toMatch(/^\? Dotfiles {2}— {6}github\.com\S*…$/m);
    });

    it("cuts a column head that is longer than its column", () => {
      const out = renderDiff(LONGDIFF, {
        ...OPTS,
        theirsLabel: "a-very-long-github-handle-indeed",
        color: false,
        columns: 50,
      });
      // The table rows fit; the page and count lines name handles whole and may wrap.
      for (const l of out.split("\n").filter((l) => /^[~=?] /.test(l))) {
        expect(l.length).toBeLessThanOrEqual(50);
      }
      expect(out).toContain("a-very-long-github…");
      // The heading names the handle in full: only the column head is cut.
      expect(out).toContain("how a-very-long-github-handle-indeed differs from bardisty");
    });

    it("never cuts inside a surrogate pair", () => {
      const emoji = String.fromCodePoint(0x1f680);
      const d: DiffResult = {
        ...LONGDIFF,
        rows: [
          {
            key: "theme",
            label: "Theme",
            theirs: `ab${emoji.repeat(40)}`,
            mine: "Gruvbox",
            status: "changed",
          },
        ],
      };
      const out = renderDiff(d, { ...OPTS, color: false, columns: 40 });
      const row = out.split("\n").find((l) => l.startsWith("~ Theme")) ?? "";
      expect(row).toMatch(/…/);
      // No lone surrogate: every UTF-16 high surrogate is followed by its low one.
      expect(row).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    });

    it("too narrow for a useful cut, it prints values whole and lets the terminal wrap", () => {
      const out = renderDiff(LONGDIFF, { ...OPTS, color: false, columns: 30 });
      expect(out).toContain(LONG);
      expect(out).not.toContain("…");
    });

    describe("a differing row never shows two equal-looking cells", () => {
      const pair = (theirs: string, mine: string): DiffResult => ({
        rows: [{ key: "dotfiles", label: "Dotfiles", theirs, mine, status: "changed" }],
        extras: { mine: [], theirs: [] },
        differ: 1,
        shared: 0,
        onlyTheirs: 0,
        onlyMine: 0,
      });
      const BASE_URL = `https://github.com/someone/${"x".repeat(80)}`;
      const cells = (out: string): string[] =>
        visible(out.split("\n").find((l) => visible(l).includes("Dotfiles")) ?? "")
          .replace(/^[~•] Dotfiles\s+/, "")
          .split(/ {2,}/);

      it("keeps the tails when two URLs differ only past the cut", () => {
        for (const color of [false, true]) {
          const out = renderDiff(pair(`${BASE_URL}/v1`, `${BASE_URL}/v2`), {
            ...OPTS,
            color,
            columns: 80,
          });
          const [t, m] = cells(out);
          expect(t).not.toBe(m);
          expect(t).toMatch(/^….*\/v1$/);
          expect(m).toMatch(/^….*\/v2$/);
          for (const l of out.split("\n")) expect(visible(l).length).toBeLessThanOrEqual(80);
        }
      });

      it("shows the middle when the heads and the tails both match", () => {
        const a = `${BASE_URL}/a/${"y".repeat(60)}`;
        const b = `${BASE_URL}/b/${"y".repeat(60)}`;
        for (const color of [false, true]) {
          const out = renderDiff(pair(a, b), { ...OPTS, color, columns: 80 });
          const [t, m] = cells(out);
          expect(t).toMatch(/^…x+\/a\/y+…$/);
          expect(m).toMatch(/^…x+\/b\/y+…$/);
          expect(t?.length).toBe(m?.length);
          for (const l of out.split("\n")) expect(visible(l).length).toBeLessThanOrEqual(80);
        }
      });

      it("compares two cut cells at the same width when the room is odd", () => {
        // `Version Manager` makes the room 80 - 15 - 6 = 59: both columns get 29.
        const d: DiffResult = {
          rows: [
            {
              key: "version-manager",
              label: "Version Manager",
              theirs: "mise",
              mine: "mise",
              status: "same",
            },
            {
              key: "dotfiles",
              label: "Dotfiles",
              theirs: "https://github.com/acme-corp/dotfiles/tree/main/hosts/alice-laptop",
              mine: "https://github.com/acme-corp/dotfiles/tree/main/hosts/bob-desktop",
              status: "changed",
            },
            {
              key: "font",
              label: "Font",
              theirs: "JetBrains Mono Nerd Font Propo",
              mine: "JetBrains Mono Nerd Font Propo",
              status: "same",
            },
          ],
          extras: { mine: [], theirs: [] },
          differ: 1,
          shared: 2,
          onlyTheirs: 0,
          onlyMine: 0,
        };
        for (const columns of [80, 81]) {
          const out = renderDiff(d, { ...OPTS, color: false, columns });
          const dot = out.split("\n").find((l) => l.startsWith("~ Dotfiles")) ?? "";
          expect(dot).toContain("alice");
          expect(dot).toContain("bob");
          // An `=` row's two cuts of one value look the same.
          const font = out.split("\n").find((l) => l.startsWith("= Font")) ?? "";
          const [ft, fm] = font.replace(/^= Font\s+/, "").split(/ {2,}/);
          expect(ft).toBe(fm);
          for (const l of out.split("\n")) expect(l.length).toBeLessThanOrEqual(columns);
        }
      });

      it("a row the diff calls same may cut both sides alike", () => {
        const d: DiffResult = {
          rows: [{ key: "dotfiles", label: "Dotfiles", theirs: LONG, mine: LONG, status: "same" }],
          extras: { mine: [], theirs: [] },
          differ: 0,
          shared: 1,
          onlyTheirs: 0,
          onlyMine: 0,
        };
        const out = renderDiff(d, { ...OPTS, color: false, columns: 60 });
        const [t, m] = cells(out.replace(/^= /m, "~ "));
        expect(t).toBe(m);
        expect(t).toMatch(/…$/);
      });

      describe("marks the invisible characters two cells differ by (the web's pairCells)", () => {
        const FFFD = "\u{fffd}";
        const RLO = "\u{202e}";
        const ZWSP = "\u{200b}";

        it("a bidi control: `zsh` against `zsh�`, and the control never prints", () => {
          for (const color of [false, true]) {
            const out = renderDiff(pair("zsh", `zsh${RLO}`), { ...OPTS, color });
            expect(cells(out)).toEqual(["zsh", `zsh${FFFD}`]);
            expect(out).not.toContain(RLO);
          }
          const plain = renderDiff(pair("zsh", `zsh${RLO}`), { ...OPTS, color: false });
          expect(plain).toMatch(new RegExp(`^~ Dotfiles  zsh +zsh${FFFD}$`, "mu"));
        });

        it("a zero-width space, which prints as nothing", () => {
          const out = renderDiff(pair(`Ghost${ZWSP}ty`, "Ghostty"), { ...OPTS, color: false });
          expect(cells(out)).toEqual([`Ghost${FFFD}ty`, "Ghostty"]);
          expect(out).not.toContain(ZWSP);
        });

        it("a URL keeps its shortening and its link to the unmarked address", () => {
          const url = "https://github.com/me/dots";
          const out = renderDiff(pair(url, `${url}${ZWSP}`), { ...OPTS, color: true });
          expect(cells(out)).toEqual(["github.com/me/dots", `github.com/me/dots${FFFD}`]);
          expect(out).toContain(`${OSC8_OPEN}${url}${ZWSP}${ESC}\\`);
        });

        it("a cut cell keeps the mark in view", () => {
          for (const color of [false, true]) {
            const out = renderDiff(pair(`${BASE_URL}/v1`, `${BASE_URL}/v1${RLO}`), {
              ...OPTS,
              color,
              columns: 80,
            });
            const [t, m] = cells(out);
            expect(t).not.toBe(m);
            expect(m).toContain(FFFD);
            expect(out).not.toContain(RLO);
            for (const l of out.split("\n")) expect(visible(l).length).toBeLessThanOrEqual(80);
          }
        });

        it("with color off, a URL shortened only by its cut still marks", () => {
          const tail = "github.com/someone/dotfiles-long-name";
          for (const theirs of [
            `https://user@${tail}`,
            `https://GitHub.com/someone/dotfiles-long-name`,
          ]) {
            const out = renderDiff(pair(`${theirs}${ZWSP}`, `https://${tail}`), {
              ...OPTS,
              color: false,
              columns: 80,
            });
            const [t, m] = cells(out);
            expect(t).not.toBe(m);
            expect(t).toContain(FFFD);
          }
        });

        it("two values alike at the floor print whole when nothing is cut", () => {
          const out = renderDiff(pair(`longvalue${ZWSP}`, "longvalue\u{2060}"), {
            ...OPTS,
            color: false,
          });
          expect(cells(out)).toEqual([`longvalue${FFFD}`, `longvalue${FFFD}`]);
        });

        it("leaves a same row, a row that differs visibly, and a glyph-shaping join alone", () => {
          const same: DiffResult = {
            ...pair(`zsh${ZWSP}`, `zsh${ZWSP}`),
            rows: [
              {
                key: "shell",
                label: "Shell",
                theirs: `zsh${ZWSP}`,
                mine: `zsh${ZWSP}`,
                status: "same",
              },
            ],
          };
          const zwj = `\u{1f469}\u{200d}\u{1f4bb}`;
          for (const d of [same, pair(`fish${ZWSP}`, "zsh"), pair(zwj, "\u{1f469}\u{1f4bb}")]) {
            expect(renderDiff(d, { ...OPTS, color: false })).not.toContain(FFFD);
          }
        });

        it("the card marks nothing (the web's profile page doesn't either)", () => {
          const p: Profile = {
            schema_version: 1,
            handle: "x",
            entries: [{ key: "shell", value: `zsh${ZWSP}${RLO}` }],
            extras: [],
            updated_at: "t",
          };
          expect(renderProfile(p, { color: false, site: "ymmv.fyi" })).not.toContain(FFFD);
        });
      });
    });
  });

  it("heads the diff with the web page it mirrors, schemeless in both color modes", () => {
    const plain = renderDiff(DIFF, {
      color: false,
      theirsLabel: "antfu",
      mineLabel: "you",
      page: PAGE,
    });
    expect(plain.startsWith("\n  ymmv.fyi/antfu/vs/me\n  how antfu differs from you\n\n")).toBe(
      true,
    );
    const color = renderDiff(DIFF, {
      color: true,
      theirsLabel: "antfu",
      mineLabel: "you",
      page: PAGE,
      term: "xterm-256color",
    });
    // Faint, never amber (an address, not a difference), and a link to the full URL.
    expect(color).toContain(
      `\n  ${OSC8_OPEN}${PAGE}${ESC}\\${ESC}[90mymmv.fyi/antfu/vs/me${ESC}[0m${OSC8_OPEN}${ESC}\\\n`,
    );
  });

  it("drops the page line's OSC-8 on a terminal that mishandles it, keeping the faint text", () => {
    const out = renderDiff(DIFF, {
      color: true,
      theirsLabel: "antfu",
      mineLabel: "you",
      page: PAGE,
      term: "linux",
    });
    expect(out).not.toContain(OSC8_OPEN);
    expect(out).toContain(`\n  ${ESC}[90mymmv.fyi/antfu/vs/me${ESC}[0m\n`);
  });

  it("names a local Worker's page with its http scheme, as the card does", () => {
    const out = renderDiff(DIFF, {
      color: false,
      theirsLabel: "antfu",
      mineLabel: "you",
      page: diffPageUrl("http://localhost:8791", "antfu", "me"),
    });
    expect(out).toContain("\n  http://localhost:8791/antfu/vs/me\n");
  });

  it("sanitizes the page before it reaches the terminal", () => {
    const out = renderDiff(DIFF, {
      color: true,
      theirsLabel: "antfu",
      mineLabel: "you",
      page: `https://ymmv.fyi/a${ESC}]8;;https://evil.example${ESC}\\/vs/b`,
      term: "xterm-256color",
    });
    // Only our own link's open and close: the smuggled sequence lost its escape bytes.
    expect(out.split(`${ESC}]`)).toHaveLength(3);
  });

  it("color mode: amber marks BOTH values of the differing row; footer is the thesis line", () => {
    const out = renderDiff(DIFF, {
      color: true,
      theirsLabel: "antfu",
      mineLabel: "you",
      page: PAGE,
    });
    expect(out).toContain(`${AMBER}fish`); // theirs column ambers too — a difference is symmetric
    expect(out).toContain(`${AMBER}zsh`);
    expect(out).toMatch(/1 differ {3}1 shared/);
  });

  it("NO_COLOR mode: zero ANSI; `~`/`=` symbols carry which rows differ", () => {
    const out = renderDiff(DIFF, {
      color: false,
      theirsLabel: "antfu",
      mineLabel: "you",
      page: PAGE,
    });
    expect(out).not.toContain(ESC);
    expect(out).toMatch(/^~ Shell/m);
    expect(out).toMatch(/^= Editor/m);
  });

  it("opens with the web's title line in both color modes", () => {
    const plain = renderDiff(DIFF, {
      color: false,
      theirsLabel: "antfu",
      mineLabel: "you",
      page: PAGE,
    });
    expect(plain).toContain("  how antfu differs from you");
    const color = renderDiff(DIFF, {
      color: true,
      theirsLabel: "antfu",
      mineLabel: "you",
      page: PAGE,
    });
    expect(color).toContain(`${ESC}[1mantfu${ESC}[0m`);
    expect(color).toMatch(/how/);
    expect(color).toMatch(/differs from/);
  });

  it("prints the column heads as the handles are stored (web parity), leaving row values untouched", () => {
    const out = renderDiff(DIFF, {
      color: false,
      theirsLabel: "antfu",
      mineLabel: "you",
      page: PAGE,
    });
    expect(out).toMatch(/antfu\s+you/);
    expect(out).not.toMatch(/ANTFU|YOU/);
    expect(out).toContain("fish"); // values keep their case
  });

  it("keeps the display casing of a mixed-case handle in its column head", () => {
    const out = renderDiff(DIFF, {
      color: false,
      theirsLabel: "OctoCat",
      mineLabel: "you",
      page: PAGE,
    });
    // The heading line above prints the handle with its casing; the head must not disagree.
    expect(out).toMatch(/how OctoCat differs from you/);
    expect(out).toMatch(/OctoCat\s+you/);
    expect(out).not.toContain("OCTOCAT");
  });

  it("sanitizes an injected value before it reaches the terminal", () => {
    const evil: DiffResult = {
      rows: [
        { key: "shell", label: "Shell", mine: "zsh", theirs: `${ESC}[2Jboom`, status: "changed" },
      ],
      extras: { mine: [], theirs: [] },
      differ: 1,
      shared: 0,
      onlyTheirs: 0,
      onlyMine: 0,
    };
    const out = renderDiff(evil, { color: false, theirsLabel: "x", mineLabel: "you", page: PAGE });
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
      differ: 0,
      shared: 0,
      onlyTheirs: 1,
      onlyMine: 1,
    };
    const out = renderDiff(d, { color: false, theirsLabel: "antfu", mineLabel: "you", page: PAGE });
    expect(out).toContain("—"); // the absent-side placeholder
    expect(out).toMatch(/extras/);
    expect(out).toContain("Hyprland");
    expect(out).toContain("Raycast");
    expect(out).toMatch(/0 differ {3}0 shared {3}1 only antfu {3}1 only you$/);
  });

  it("marks a one-sided row `?` with color off, and faint with no amber with color on", () => {
    const d: DiffResult = {
      rows: [
        { key: "editor", label: "Editor", theirs: "Zed", mine: "Helix", status: "changed" },
        { key: "prompt", label: "Prompt", theirs: "Starship", mine: null, status: "only_theirs" },
        { key: "shell", label: "Shell", theirs: "fish", mine: "fish", status: "same" },
        { key: "font", label: "Font", theirs: null, mine: "Lilex", status: "only_mine" },
      ],
      extras: { mine: [], theirs: [] },
      differ: 1,
      shared: 1,
      onlyTheirs: 1,
      onlyMine: 1,
    };
    const opts = { theirsLabel: "bardisty", mineLabel: "you", page: PAGE, term: "xterm" };
    const plain = renderDiff(d, { ...opts, color: false });
    expect(plain).toMatch(/^~ Editor {2}Zed {7}Helix$/m);
    expect(plain).toMatch(/^\? Prompt {2}Starship {2}—$/m);
    expect(plain).toMatch(/^= Shell {3}fish {6}fish$/m);
    expect(plain).toMatch(/^\? Font {4}— {9}Lilex$/m);
    const color = renderDiff(d, { ...opts, color: true });
    const prompt = color.split("\n").find((l) => l.includes("Prompt")) ?? "";
    expect(prompt).toBe(
      `${ESC}[90m•${ESC}[0m Prompt  ${ESC}[90mStarship${ESC}[0m  ${ESC}[90m—${ESC}[0m`,
    );
    const font = color.split("\n").find((l) => l.includes("Font")) ?? "";
    expect(font).toBe(
      `${ESC}[90m•${ESC}[0m Font    ${ESC}[90m—${ESC}[0m${" ".repeat(7)}  ${ESC}[90mLilex${ESC}[0m`,
    );
    expect(prompt + font).not.toContain(AMBER);
  });

  it("splits the count per side, leaving out a side with none, in the web's order", () => {
    const base: DiffResult = {
      rows: [],
      extras: { mine: [], theirs: [] },
      differ: 5,
      shared: 1,
      onlyTheirs: 6,
      onlyMine: 0,
    };
    const opts = { color: false, theirsLabel: "bardisty", mineLabel: "you", page: PAGE };
    expect(renderDiff(base, opts)).toMatch(/\n {2}5 differ {3}1 shared {3}6 only bardisty$/);
    expect(renderDiff({ ...base, onlyTheirs: 0, onlyMine: 2 }, opts)).toMatch(
      /\n {2}5 differ {3}1 shared {3}2 only you$/,
    );
    expect(renderDiff({ ...base, onlyTheirs: 0 }, opts)).toMatch(/\n {2}5 differ {3}1 shared$/);
    // The handle in the count is sanitized, as the column heads are.
    expect(renderDiff(base, { ...opts, theirsLabel: `bar${ESC}[2Jdisty` })).toMatch(
      /6 only bardisty$/,
    );
  });

  it("heads the extras block as uncompared and starts each label at the value column", () => {
    const d: DiffResult = {
      rows: [{ key: "editor", label: "Editor", mine: "Zed", theirs: "VS Code", status: "changed" }],
      extras: {
        theirs: [
          { label: "Keyboard", value: "HHKB Pro 2" },
          { label: "Dotfiles", value: "https://github.com/antfu/dotfiles" },
        ],
        mine: [{ label: "Launcher", value: "Raycast" }],
      },
      differ: 1,
      shared: 0,
      onlyTheirs: 0,
      onlyMine: 0,
    };
    const plain = renderDiff(d, {
      color: false,
      theirsLabel: "antfu",
      mineLabel: "bardisty",
      page: PAGE,
    });
    // `Editor` is shorter than `bardisty`, so the owner column sets the stop for the extras.
    expect(plain).toContain(
      [
        "  extras (not compared)",
        "  antfu     Keyboard = HHKB Pro 2",
        "  antfu     Dotfiles = https://github.com/antfu/dotfiles",
        "  bardisty  Launcher = Raycast",
      ].join("\n"),
    );
    // With color on the whole line is faint and the padding sits inside it, so the codes add no
    // width. A URL value is a link, shortened, but faint: in the diff amber means "differs".
    const color = renderDiff(d, {
      color: true,
      theirsLabel: "antfu",
      mineLabel: "bardisty",
      page: PAGE,
      term: "xterm-256color",
    });
    expect(color).toContain(`  ${ESC}[90mextras (not compared)${ESC}[0m`);
    expect(color).toContain(`  ${ESC}[90mantfu     Keyboard = HHKB Pro 2${ESC}[0m`);
    expect(color).toContain(`  ${ESC}[90mbardisty  Launcher = Raycast${ESC}[0m`);
    expect(color).toContain(
      `  ${ESC}[90mantfu     Dotfiles = ${OSC8_OPEN}https://github.com/antfu/dotfiles${ESC}\\` +
        `github.com/antfu/dotfiles${OSC8_OPEN}${ESC}\\${ESC}[0m`,
    );
    expect(color.slice(color.indexOf("extras ("))).not.toContain(AMBER);
  });

  it("starts the extras labels at the rows' value column when the row labels are longer", () => {
    const d: DiffResult = {
      rows: [{ key: "shell", label: "Shell", mine: "zsh", theirs: "zsh", status: "same" }],
      extras: { theirs: [{ label: "WM", value: "Hyprland" }], mine: [] },
      differ: 0,
      shared: 1,
      onlyTheirs: 0,
      onlyMine: 0,
    };
    // Only the owners with a line count: `bardisty` owns none, so `Shell` sets the stop.
    const out = renderDiff(d, {
      color: false,
      theirsLabel: "x",
      mineLabel: "bardisty",
      page: PAGE,
    });
    expect(out).toContain("= Shell  zsh");
    expect(out).toContain("  x      WM = Hyprland");
  });

  it("pads the signed-in diff's owner column to `you` when the handle is shorter", () => {
    const d: DiffResult = {
      rows: [],
      extras: {
        theirs: [{ label: "WM", value: "Hyprland" }],
        mine: [{ label: "Launcher", value: "Raycast" }],
      },
      differ: 0,
      shared: 0,
      onlyTheirs: 0,
      onlyMine: 0,
    };
    const out = renderDiff(d, { color: false, theirsLabel: "jo", mineLabel: "you", page: PAGE });
    expect(out).toContain("  jo   WM = Hyprland\n  you  Launcher = Raycast");
  });
});

describe("diffPageUrl", () => {
  it("follows the web's route: theirs first, then mine", () => {
    expect(diffPageUrl("https://ymmv.fyi", "antfu", "bardisty")).toBe(
      "https://ymmv.fyi/antfu/vs/bardisty",
    );
  });
  it("keeps the stored casing and encodes each segment like the web's swap link", () => {
    expect(diffPageUrl("https://ymmv.fyi", "OctoCat", "a b/c")).toBe(
      "https://ymmv.fyi/OctoCat/vs/a%20b%2Fc",
    );
  });
  it("strips control bytes from a handle before encoding it", () => {
    expect(diffPageUrl("https://ymmv.fyi", `x${ESC}[2Jy`, "me")).toBe("https://ymmv.fyi/xy/vs/me");
  });
});

describe("profilePageUrl", () => {
  it("is the card's web page, the handle as one encoded segment", () => {
    expect(profilePageUrl("https://ymmv.fyi", "antfu")).toBe("https://ymmv.fyi/antfu");
    expect(profilePageUrl("https://ymmv.fyi", "a/b?c")).toBe("https://ymmv.fyi/a%2Fb%3Fc");
  });
  it("strips control bytes from a handle before encoding it", () => {
    expect(profilePageUrl("https://ymmv.fyi", `x${ESC}[2Jy`)).toBe("https://ymmv.fyi/xy");
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

  it("renders an empty profile with exactly ONE blank line between units (never two)", () => {
    const empty: Profile = {
      schema_version: 1,
      handle: "x",
      entries: [],
      extras: [],
      updated_at: "t",
    };
    const out = renderProfile(empty, { color: false, site: SITE });
    expect(out).toContain("x");
    // Exact pin: breadcrumb, one blank, updated — the zero-curated-rows card must not stack the
    // breadcrumb's old trailing blank on the next section's leading one.
    expect(out).toBe("\n  ymmv.fyi/x\n\n  updated t");
    expect(out).not.toContain("\n\n\n");
  });

  it("zero curated entries + extras: single blank between breadcrumb, extras, and updated", () => {
    const p: Profile = {
      schema_version: 1,
      handle: "x",
      entries: [],
      extras: [{ label: "Keyboard", value: "HHKB" }],
      updated_at: "t",
    };
    const out = renderProfile(p, { color: false, site: SITE });
    expect(out).toBe("\n  ymmv.fyi/x\n\n  Keyboard  HHKB\n\n  updated t");
    expect(out).not.toContain("\n\n\n");
  });

  it("a populated profile keeps the exact historical line structure (refactor guard)", () => {
    const out = renderProfile(FULLISH, { color: false, site: SITE, now: at(NOW) });
    expect(out).toBe(
      "\n  ymmv.fyi/carol\n\n  Editor    Zed\n  Dotfiles  https://git.io/etc\n\n  Keyboard  HHKB\n\n  updated 3h ago",
    );
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

  describe("the breadcrumb links its page", () => {
    const PAGE = "https://ymmv.fyi/carol";
    const ST = `${ESC}\\`;
    const CRUMB = `${ESC}[90mymmv.fyi/${ESC}[0m${ESC}[1mcarol${ESC}[0m`;
    const opts = { site: SITE, now: at(NOW), page: PAGE };

    it("with color on: an OSC-8 link to the page around the unchanged faint/bold text", () => {
      const out = renderProfile(FULLISH, { ...opts, color: true, term: "xterm-256color" });
      expect(out.split("\n")[1]).toBe(`  ${OSC8_OPEN}${PAGE}${ST}${CRUMB}${OSC8_OPEN}${ST}`);
    });
    it("TERM=linux and TERM=dumb keep the text and drop the link", () => {
      for (const term of ["linux", "dumb"]) {
        const out = renderProfile(FULLISH, { ...opts, color: true, term });
        expect(out.split("\n")[1]).toBe(`  ${CRUMB}`);
      }
    });
    it("with color off: byte-identical to a card without a page", () => {
      const without = renderProfile(FULLISH, { color: false, site: SITE, now: at(NOW) });
      expect(renderProfile(FULLISH, { ...opts, color: false })).toBe(without);
    });
    it("the publish preview never links (before a first publish the page is a 404)", () => {
      const out = renderProfile(FULLISH, { ...opts, color: true, mode: "preview" });
      expect(out.split("\n")[1]).toBe(`  ${CRUMB}`);
      expect(out).not.toContain(PAGE);
    });
    it("the href is sanitized: a control byte in the page can't end the sequence early", () => {
      const out = renderProfile(FULLISH, { ...opts, page: `${PAGE}${ESC}${BEL}x`, color: true });
      expect(out).toContain(`${OSC8_OPEN}${PAGE}x${ST}`);
    });
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

  it("a userinfo-bearing URL shows the real host on the card; plain mode keeps it whole", () => {
    const p: Profile = {
      ...FULLISH,
      entries: [{ key: "dotfiles", value: "https://good.com@evil.com/x" }],
    };
    const color = renderProfile(p, { color: true, site: SITE, now: at(NOW) });
    expect(color).toContain(`${AMBER}evil.com/x`);
    expect(color).not.toContain(`${AMBER}good.com`);
    const plain = renderProfile(p, { color: false, site: SITE, now: at(NOW) });
    expect(plain).toContain("Dotfiles  https://good.com@evil.com/x");
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

  describe("disagreements (preview row marks)", () => {
    const FAINT = `${ESC}[90m`;
    const RESET = `${ESC}[0m`;
    const marks = new Map<CuratedKey, string>([["editor", "Neovim"]]);

    it("appends a faint (detected: X) note to a marked row, never amber", () => {
      const plain = renderProfile(FULLISH, {
        color: false,
        site: SITE,
        mode: "preview",
        disagreements: marks,
      });
      expect(plain).toMatch(/Editor\s+Zed {2}\(detected: Neovim\)/);
      const colored = renderProfile(FULLISH, {
        color: true,
        site: SITE,
        mode: "preview",
        disagreements: marks,
      });
      expect(colored).toContain(`${FAINT}(detected: Neovim)${RESET}`);
      // The dotfiles link below it is amber by rule; the marked row itself spends none.
      const editorLine = colored.split("\n").find((l) => l.includes("Editor")) ?? "";
      expect(editorLine).not.toContain(AMBER);
    });
    it("sanitizes the note (the detected value is env-derived)", () => {
      const out = renderProfile(FULLISH, {
        color: false,
        site: SITE,
        mode: "preview",
        disagreements: new Map<CuratedKey, string>([["editor", `Neo${ESC}[2Jvim`]]),
      });
      expect(out).toContain("(detected: Neovim)");
      expect(out).not.toContain(ESC);
    });
    it("view mode ignores disagreements entirely", () => {
      const out = renderProfile(FULLISH, {
        color: false,
        site: SITE,
        disagreements: marks,
        now: at(NOW),
      });
      expect(out).not.toContain("(detected");
    });
    it("a gap row never carries a note", () => {
      const out = renderProfile(FULLISH, {
        color: false,
        site: SITE,
        mode: "preview",
        disagreements: new Map<CuratedKey, string>([["font", "Lilex"]]),
      });
      expect(out).toMatch(/Font\s+—/);
      expect(out).not.toContain("(detected");
    });
    it("an empty note prints nothing, never a bare (detected: )", () => {
      const out = renderProfile(FULLISH, {
        color: false,
        site: SITE,
        mode: "preview",
        disagreements: new Map<CuratedKey, string>([["editor", ""]]),
      });
      expect(out).toMatch(/Editor\s+Zed\n/);
      expect(out).not.toContain("(detected");
    });
  });

  describe("changes (preview row marks against the live profile)", () => {
    const FAINT = `${ESC}[90m`;
    const RESET = `${ESC}[0m`;
    const preview = (
      changes: [CuratedKey, string | null][],
      color = false,
      extra: { disagreements?: Map<CuratedKey, string>; mode?: "view" | "preview" } = {},
    ): string =>
      renderProfile(FULLISH, {
        color,
        site: SITE,
        mode: "preview",
        now: at(NOW),
        changes: new Map(changes),
        ...extra,
      });
    const line = (out: string, label: string): string =>
      out.split("\n").find((l) => l.includes(label)) ?? "";

    it("marks changed, new and cleared rows in the gutter; the columns hold", () => {
      const out = preview([
        ["editor", "Vim"],
        ["dotfiles", null],
        ["shell", "zsh"],
      ]);
      // "Version Manager" (a gap row) sets the label width: 15, then the two-space gutter.
      expect(line(out, "Editor")).toBe("~ Editor           Vim → Zed");
      expect(line(out, "Dotfiles")).toBe("+ Dotfiles         https://git.io/etc");
      expect(line(out, "Shell")).toBe("- Shell            zsh → —");
      expect(line(out, "Font")).toBe("  Font             —");
    });
    it("a card with no changes is byte-identical to one without the option", () => {
      const bare = renderProfile(FULLISH, { color: true, site: SITE, mode: "preview" });
      expect(preview([], true)).toBe(bare);
    });
    it("color: amber glyph and incoming value, faint outgoing value and arrow", () => {
      const out = preview([["editor", "Vim"]], true);
      expect(line(out, "Editor")).toBe(
        `${AMBER}~${RESET} ${FAINT}Editor           Vim → ${RESET}${AMBER}Zed${RESET}`,
      );
    });
    it("color: a cleared row spends its amber on the glyph and the —", () => {
      const out = preview([["shell", "zsh"]], true);
      expect(line(out, "Shell")).toBe(
        `${AMBER}-${RESET} ${FAINT}Shell            zsh → ${RESET}${AMBER}—${RESET}`,
      );
    });
    it("a changed URL: the incoming one is the usual link, the outgoing one is never linked", () => {
      const colored = line(preview([["dotfiles", "https://old.example/dots"]], true), "Dotfiles");
      expect(colored).toContain(`${OSC8_OPEN}https://git.io/etc`);
      expect(colored).not.toContain(`${OSC8_OPEN}https://old.example`);
      expect(colored).toContain("old.example/dots →"); // shortened beside the shortened link
      expect(colored).not.toContain("https://old.example");
      // Color off: both addresses in full, like every plain URL.
      expect(line(preview([["dotfiles", "https://old.example/dots"]]), "Dotfiles")).toBe(
        "~ Dotfiles         https://old.example/dots → https://git.io/etc",
      );
    });
    it("sanitizes the outgoing value (it came off the wire)", () => {
      const out = preview([["editor", `V${ESC}[2Jim`]]);
      expect(out).not.toContain(ESC);
      expect(line(out, "Editor")).toBe("~ Editor           Vim → Zed");
    });
    it("drops `old →` when the old value shows nothing or shows the same as the new one", () => {
      const ZWSP = String.fromCharCode(0x200b);
      expect(line(preview([["editor", ZWSP]]), "Editor")).toBe("~ Editor           Zed");
      expect(line(preview([["editor", `Z${ESC}[2Jed`]]), "Editor")).toBe("~ Editor           Zed");
      expect(line(preview([["shell", ZWSP]]), "Shell")).toBe("- Shell            —");
    });
    it("a row can carry a change mark and a detection note", () => {
      const out = preview([["editor", "Vim"]], false, {
        disagreements: new Map<CuratedKey, string>([["editor", "Helix"]]),
      });
      expect(line(out, "Editor")).toBe("~ Editor           Vim → Zed  (detected: Helix)");
    });
    it("view mode ignores changes", () => {
      const out = preview([["editor", "Vim"]], false, { mode: "view" });
      expect(out).toBe(renderProfile(FULLISH, { color: false, site: SITE, now: at(NOW) }));
    });
  });
});

describe("nudge / notFound", () => {
  it("nudge is the one amber CTA (plain under NO_COLOR)", () => {
    expect(nudge(true)).toContain(AMBER);
    expect(nudge(false)).not.toContain(ESC);
    expect(nudge(false)).toBe("\n  publish yours to diff → run ymmv");
    expect(nudge(false, "publish yours")).toBe("\n  publish yours → run ymmv");
  });
  it("notFound names the handle in the web's words, and points nowhere", () => {
    expect(notFound("ghost")).toBe('\n  no ymmv profile for "ghost" yet.');
    expect(notFound(`gh${ESC}[31most`)).toBe('\n  no ymmv profile for "ghost" yet.');
  });

  it("link label replaces the display text with color, is sanitized, and is color-mode only", () => {
    // Hostile label: the ANSI content is stripped before it can terminate the OSC wrapper.
    const out = link("https://ymmv.fyi", true, "xterm-256color", `evil${ESC}[2Jlabel`);
    expect(out).toContain("evillabel");
    expect(out).not.toContain(`${ESC}[2J`);
    expect(out).toContain(`${ESC}]8;;https://ymmv.fyi${ESC}\\`); // OSC-8 wraps the real URL
    // Color off: the plain URL still wins — piped output never trades the address for prose.
    expect(link("https://ymmv.fyi", false, "xterm-256color", "label")).toBe("https://ymmv.fyi");
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
      renderProfile(p, {
        color: false,
        site: "ymmv.fyi",
        mode: "preview",
        changes: new Map<CuratedKey, string | null>([
          ["editor", "Vim"],
          ["shell", "zsh"],
        ]),
      }),
      renderDiff(DIFF, { color: false, theirsLabel: "antfu", mineLabel: "you", page: PAGE }),
      nudge(false),
      notFound("ghost"),
    ];
    for (const unit of units) {
      expect(unit).toMatch(/^\n(?!\n)/); // exactly one leading blank line
      expect(unit).not.toMatch(/\n$/); // console.log terminates the line — no self-carried blank
    }
  });
});
