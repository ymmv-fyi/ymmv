import {
  CURATED_KEYS,
  type CuratedKey,
  type DiffResult,
  displayUrl,
  type Entry,
  type ExtraDiff,
  hasVisibleContent,
  KEY_LABELS,
  MAX_VALUE,
  type Profile,
} from "@ymmv/shared";

// Terminal rendering — the CLI half of the design system. Mirrors the web surface (ymmv.css):
// aligned key→value columns, amber on links + diff-differences ONLY (the load-bearing scarcity
// rule, same as the web), muted for same. Two hard requirements live here:
//   • NO_COLOR (no-color.org): drop all ANSI and fall back to `~` (changed) / `=` (same) / `?` (one
//     side only) symbols so the diff still reads on any terminal.
//   • Output sanitization: every profile value is UNTRUSTED — strip ANSI/control sequences
//     before printing so a crafted value can't move the cursor, recolor the screen, or inject lines.
//
// Output convention: every user-facing output unit — card, diff, prompt, confirmation, note block,
// error — begins with exactly ONE blank line and is indented two spaces; units never carry trailing
// blank lines (console.log terminates the line). The render* builders return whole units; every
// other print wraps in message(). The bin entry (cli.ts) prints the single closing blank line
// before the shell prompt — to stdout on success, to stderr on a non-zero exit so failed runs
// leave stdout byte-clean for pipes. Exceptions: the general `ymmv help` and `--version` stay
// flush-left (reference surfaces, read by pipes as much as by people; help is byte-pinned by its
// snapshot). Per-verb help (`ymmv set --help`) is an ordinary unit.
//
// All control bytes are built from char codes (never typed literally) so the source stays pure ASCII.

type Env = Record<string, string | undefined>;

const ESC = String.fromCharCode(27); // U+001B — the ANSI escape introducer
const CSI = `${ESC}[`;
const CODES = {
  amber: `${CSI}93m`, // DESIGN: amber == ANSI bright-yellow
  faint: `${CSI}90m`,
  bold: `${CSI}1m`,
  reset: `${CSI}0m`,
};
export type Codes = typeof CODES;
export const NO_CODES: Codes = { amber: "", faint: "", bold: "", reset: "" };

export function palette(color: boolean): Codes {
  return color ? CODES : NO_CODES;
}

/**
 * A user-facing message as a standard output unit: a leading blank line, every non-empty line
 * indented two spaces (empty interior lines stay empty — no whitespace-only lines). Callers pass
 * text with no trailing newline — console.log/console.error terminate the line, so units never
 * stack trailing blanks. Splits on \r?\n: authored strings are \n-only and wire text loses \r in
 * sanitizeValue, but the bin catch prints arbitrary Error.message, which may carry CRLF.
 */
export function message(text: string): string {
  return `\n${text
    .split(/\r?\n/)
    .map((l) => (l ? `  ${l}` : l))
    .join("\n")}`;
}

// ANSI/VT escape sequences (CSI, OSC, …) — the well-known `ansi-regex` pattern, built via char
// codes so no control byte appears in source. Strips the escape introducer + its parameters.
const ESC_INTRODUCERS = `${String.fromCharCode(27)}${String.fromCharCode(0x9b)}`;
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(
  `[${ESC_INTRODUCERS}][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?${BEL})|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
);
// Any remaining C0 (0x00–0x1F), DEL (0x7F), or C1 (0x80–0x9F) control char — including a lone ESC,
// NUL, and newlines/tabs (which would break the single-line column layout).
const CTRL_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  "g",
);
// Unicode bidi controls (\p{Bidi_Control}: embeddings/overrides U+202A–202E, isolates U+2066–2069,
// LRM/RLM U+200E/200F, Arabic letter mark U+061C). These visually reorder text (Trojan-Source-style
// spoofing) without being ANSI or C0/C1, so strip them too — no legitimate single-line stack value
// needs a directional control. Same property as the web's packages/web/src/lib/sanitize.ts
// (duplicated on purpose; @ymmv/shared never sanitizes).
const BIDI_RE = /\p{Bidi_Control}/gu;

/** Neutralize an untrusted value for terminal display: strip ANSI + control + bidi chars. */
export function sanitizeValue(value: string): string {
  return value.replace(ANSI_RE, "").replace(CTRL_RE, "").replace(BIDI_RE, "");
}

// The code points a terminal shows as nothing: \p{Default_Ignorable_Code_Point} (zero-width
// space, soft hyphen, word joiner, BOM, and every bidi control) less the join controls, variation
// selectors and tag characters, which shape glyphs (an emoji sequence vs its parts, emoji vs text
// presentation), so a difference in them already shows. The web's diff-cells.ts INVISIBLE,
// duplicated on purpose like BIDI_RE.
const INVISIBLE_RE =
  /(?![\p{Join_Control}\p{Variation_Selector}\u{e0020}-\u{e007f}])\p{Default_Ignorable_Code_Point}/gu;
const FFFD = String.fromCodePoint(0xfffd);

/** sanitizeValue, but each invisible code point (INVISIBLE_RE) becomes U+FFFD instead of
 *  printing as nothing. Marked before the bidi strip, so a bidi control turns into U+FFFD and
 *  still never reaches the terminal; the strip after is a backstop. */
function markInvisible(value: string): string {
  return value
    .replace(ANSI_RE, "")
    .replace(CTRL_RE, "")
    .replace(INVISIBLE_RE, FFFD)
    .replace(BIDI_RE, "");
}

/** The form a prompt's `[default]` and the card row show for a value. Every "does this name the
 *  same thing the user saw" comparison uses it: promptEntries' typed-back dotfiles check and its
 *  repair of a stored form that fails a write rule, detectionDisagreements, and the dismissal
 *  match (isDismissed, and the `saved` form publish records on an "n"). Enter in the walk,
 *  publish()'s edit diff and its 412 keep-pruning keep or compare raw stored values on purpose:
 *  they ask whether the value changed, not how it reads. */
export function shownValue(value: string): string {
  return sanitizeValue(value).trim();
}

/** The CLI's visibility pre-flight: the shared rule applied to the form the user is SHOWN. An
 *  ANSI sequence like ESC[31m has visible bytes by the shared rule (the server stores it) but
 *  sanitizes to nothing here, so the card would show a blank the user then confirms. Judging the
 *  sanitized form keeps the card and the consent in agreement; the CLI refuses a little more than
 *  the server, never less. */
export function showsVisibleText(value: string): boolean {
  return hasVisibleContent(sanitizeValue(value));
}

/**
 * Should we emit ANSI color? NO_COLOR wins outright (its mere presence disables color, per
 * no-color.org); then an explicit FORCE_COLOR; then TERM=dumb disables (ecosystem convention —
 * dumb terminals render CSI as garbage, and the restyle styles nearly every line); otherwise
 * color only on a real TTY.
 */
export function useColor(env: Env, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined) return false;
  // FORCE_COLOR convention (supports-color): "0" and "false" force-DISABLE, any other value
  // (including empty) force-enables.
  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  }
  if (env.TERM === "dumb") return false;
  return isTTY;
}

/** Where a sign-in's lines print (login()'s code and waiting line, and the line that explains a
 *  sign-in mid-command): stdout as always, but stderr when only stderr is a terminal, or
 *  `ymmv -y > log.txt` buries the code in the file and waits on a blank screen. Picked per call:
 *  tests swap the console methods and the TTY flags after import. */
export function signInOut(): typeof console.log {
  return signInOnStderr() ? console.error : console.log;
}

/** Color for a sign-in's lines, by the stream signInOut() picks: the redirected case prints on a
 *  terminal too, so its code keeps its bold and its link. */
export function signInColor(): boolean {
  return signInOnStderr() ? useColor(process.env, true) : colorEnabled();
}

/** Whether a sign-in's lines go to stderr: stdout redirected, stderr still a terminal. */
export function signInOnStderr(): boolean {
  return !process.stdout.isTTY && Boolean(process.stderr.isTTY);
}

/** Color for the current process: NO_COLOR/FORCE_COLOR, else stdout TTY state. */
export function colorEnabled(): boolean {
  return useColor(process.env, Boolean(process.stdout.isTTY));
}

const OSC = `${ESC}]`;
const ST = `${ESC}\\`;

const HTTP_URL_RE = /^https?:\/\/\S+$/i;

/** Is this value a bare http(s) URL (the whole value, no whitespace) that the parser accepts? The
 *  parse half keeps this gate in step with displayUrl, which rewrites the authority only for values
 *  the parser takes: a value it rejects must never be linked with its raw text as the label. */
export function isHttpUrl(value: string): boolean {
  const t = value.trim();
  return HTTP_URL_RE.test(t) && URL.canParse(t);
}

// `me/dotfiles`: a GitHub login (no dots), then a repo name that is not `.` or `..`.
const USER_REPO_RE = /^([a-z\d][a-z\d-]*)\/((?!\.{1,2}\/?$)[\w.-]+)\/?$/i;
// `github.com/me/dotfiles`: a dotted host ending in a TLD, then a path. The slash is required so
// a filename (`chezmoi.toml`) never reads as a host, and the path charset is narrow enough that
// the result can ride inside a command meant to be pasted (no quotes, `$(`, backticks, `?`, `#`).
const HOST_PATH_RE = /^[a-z\d-]+(\.[a-z\d-]+)*\.[a-z]{2,}\/[\w.~%+/-]*$/i;

/** The https form of a dotfiles value typed without a scheme, or undefined when there is none to
 *  offer: both surfaces link only a bare http(s) URL (isHttpUrl here, safe-href.ts on the web), so
 *  `github.com/me/dotfiles` publishes as plain text. `user/repo` is read as GitHub only when the
 *  user is `handle`, the GitHub login this profile is bound to: any `word/word` fits the shape
 *  (`n/a`, `src/dotfiles`), and the offer defaults to yes. Never a form the write rules would
 *  refuse. */
export function linkForm(value: string, handle: string): string | undefined {
  const t = value.trim();
  if (isHttpUrl(t)) return undefined;
  const repo = USER_REPO_RE.exec(t);
  const url =
    repo && repo[1]?.toLowerCase() === handle.toLowerCase()
      ? `https://github.com/${repo[1]}/${repo[2]}`
      : HOST_PATH_RE.test(t)
        ? `https://${t}`
        : undefined;
  // The patterns admit hosts the URL parser may still refuse, and parsers differ: Node 22 rejects
  // the invalid punycode in `xn--a.example`, Node 26 takes it. Offered means it links HERE.
  return url !== undefined && url.length <= MAX_VALUE && isHttpUrl(url) ? url : undefined;
}

// Terminals known to mishandle (not ignore) unknown OSC sequences — never emit OSC-8 there.
// TERM=dumb is already colorless via useColor(); it stays listed as defense-in-depth for
// FORCE_COLOR=1 runs. Everything else gets the link when color is on; non-supporting-but-sane
// terminals drop the sequence and show the text. Contingency: grow this into an env sniff here.
const NO_OSC8_TERMS = new Set(["linux", "dumb"]);

/**
 * A URL for the terminal: amber + OSC-8 hyperlink + shortened display when color is on; the full
 * plain URL when color is off (piped/NO_COLOR output stays machine-readable). Safe on untrusted
 * values: sanitizeValue strips ESC/BEL/C0/C1 first, so the value can neither terminate the OSC
 * early nor smuggle its own sequence. An optional `label` replaces the displayed URL as the
 * link's visible text — a COLOR-MODE enhancement only: with color off the plain URL still wins,
 * so piped output never trades the address for prose. The label passes through sanitizeValue
 * like the URL (same injection surface).
 */
export function link(url: string, color: boolean, term = process.env.TERM, label?: string): string {
  const clean = sanitizeValue(url).trim();
  if (!color) return clean;
  const text = `${CODES.amber}${label ? sanitizeValue(label) : displayUrl(clean)}${CODES.reset}`;
  return hyperlink(clean, text, term);
}

/** `text` as an OSC-8 hyperlink to `href`, or `text` alone on a terminal that mishandles one.
 *  Callers pass a sanitized href and only emit this with color on. */
function hyperlink(href: string, text: string, term: string | undefined): string {
  if (term !== undefined && NO_OSC8_TERMS.has(term)) return text;
  return `${OSC}8;;${href}${ST}${text}${OSC}8;;${ST}`;
}

/** The web page a diff mirrors. /<a>/vs/<b> diffs mine = b against theirs = a, so theirs comes
 *  first. Callers pass the handles as stored (the fetched profiles, after any rename), never a
 *  typed argument and never the `you` the signed-in diff heads its column with. Each segment is
 *  encoded like Diff.astro's swap link: a stored handle needs none, but wire data is untrusted. */
export function diffPageUrl(base: string, theirs: string, mine: string): string {
  return `${base}/${pageSegment(theirs)}/vs/${pageSegment(mine)}`;
}

/** The web page a card mirrors, `<base>/<handle>`, for the handle as stored (the fetched
 *  profile's, after any rename). Encoded like diffPageUrl's segments. */
export function profilePageUrl(base: string, handle: string): string {
  return `${base}/${pageSegment(handle)}`;
}

function pageSegment(handle: string): string {
  return encodeURIComponent(sanitizeValue(handle));
}

/**
 * Humanize a wire timestamp: "just now" (under a minute — including a FUTURE stamp, so clock skew
 * never prints "-3m ago"), Nm/Nh/Nd ago, the plain date past ~30 days, and the raw (sanitized)
 * string when unparseable.
 */
export function relTime(iso: string, now: () => number = Date.now): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return sanitizeValue(iso);
  const ms = now() - t;
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * A single profile as a key→value spec sheet, headed by the web's breadcrumb (faint site/ + bold
 * handle). URL values render as links; everything else is plain ink.
 *
 * `mode: "view"` (default — `ymmv <handle>`) hides unset keys and shows the humanized `updated`
 * line, exactly like the web page. `mode: "preview"` (the publish flow ONLY) shows every unset
 * curated key as a faint `Label  —` row so gaps are visible before confirming, and drops the
 * `updated` line (a pre-publish timestamp would be a lie). view() never passes `mode`, so preview
 * rows cannot leak into viewing.
 *
 * `disagreements` (preview only, ignored in view mode) holds the keys whose fresh detection names
 * a different tool than the shown value, each mapped to that detected value: the row gets a faint
 * trailing `(detected: X)` note so the user can see what the saved value won over before
 * confirming. The caller decides what "disagrees" means; this only prints. Gap rows never carry
 * one (nothing to disagree with). Env-derived, so the note is sanitized like every value.
 *
 * `changes` (preview only, ignored in view mode) holds the keys this publish would change on the
 * live profile (profile-ops' profileChanges): the live value being replaced or cleared, or null
 * for a new key. A marked row trades the first indent character for a glyph, so the columns hold:
 * `~ Editor  Zed → Neovim` changed, `+ Font  Lilex` new, `- Shell  zsh → —` cleared. The glyph
 * prints in both color modes (three kinds cannot share the diff's amber dot); with color on, the
 * glyph and the incoming value are amber (a diff difference) and the outgoing value is faint.
 * The outgoing value is wire data: sanitized, and never linked (takeLine's rule). `old →` is
 * dropped when the old value shows nothing or shows the same as the new one (a walk re-saving a
 * value that carried a control sequence), where it would read as a blank or as `Vim → Vim`.
 * Unmarked rows are byte-identical to a card without `changes`.
 *
 * `page` (view only, ignored in preview mode) is the web page the card mirrors (profilePageUrl).
 * With color on the breadcrumb is an OSC-8 link to it, its faint/bold text unchanged, as the
 * diff's page line links its page; with color off it prints exactly as without `page`. The
 * preview never links: before a first publish the page is a 404, and on a republish it shows the
 * live profile, not the card being confirmed.
 */
export function renderProfile(
  profile: Profile,
  opts: {
    color: boolean;
    site: string;
    mode?: "view" | "preview";
    page?: string;
    term?: string;
    now?: () => number;
    disagreements?: ReadonlyMap<CuratedKey, string>;
    changes?: ReadonlyMap<CuratedKey, string | null>;
  },
): string {
  const c = palette(opts.color);
  const preview = opts.mode === "preview";
  const byKey = new Map<string, string>(
    (profile.entries ?? []).map((e: Entry) => [e.key, e.value]),
  );
  // value === null marks a preview gap row (unset curated key).
  const rows = CURATED_KEYS.flatMap((key) => {
    const value = byKey.get(key);
    if (value === undefined && !preview) return [];
    return [
      {
        label: KEY_LABELS[key],
        value: value === undefined ? null : sanitizeValue(value),
        note: preview && value !== undefined ? opts.disagreements?.get(key) : undefined,
        // undefined = unmarked; null = new key; a string = the live value replaced or cleared.
        from: preview ? opts.changes?.get(key) : undefined,
      },
    ];
  });
  const extras = (profile.extras ?? []).map((x) => ({
    label: sanitizeValue(x.label),
    value: sanitizeValue(x.value),
  }));
  const labelW = Math.max(
    0,
    ...rows.map((r) => r.label.length),
    ...extras.map((x) => x.label.length),
  );
  const term = opts.term ?? process.env.TERM;
  const val = (v: string): string => (isHttpUrl(v) ? link(v, opts.color, term) : v);
  // A marked row's value column up to the incoming value: the gutter, then `old → ` unless it
  // would not read (see above). A URL is shortened with color on, to sit beside the shortened
  // incoming link.
  const outgoing = (from: string | null, to: string | null): string => {
    const old = shownValue(from ?? "");
    if (!hasVisibleContent(old) || (to !== null && old === shownValue(to))) return "  ";
    return `  ${opts.color && isHttpUrl(old) ? displayUrl(old) : old} → `;
  };

  // Every section (rows, extras, updated) pushes its OWN leading blank — the breadcrumb never
  // pre-pays one. A profile with zero curated rows would otherwise stack the breadcrumb's blank
  // on the next section's, breaking the one-blank-line-between-units convention.
  const crumb = `${c.faint}${opts.site}/${c.reset}${c.bold}${sanitizeValue(profile.handle)}${c.reset}`;
  const page = opts.color && !preview && opts.page !== undefined ? opts.page : undefined;
  const lines: string[] = [
    "",
    `  ${page === undefined ? crumb : hyperlink(sanitizeValue(page), crumb, term)}`,
  ];
  if (rows.length) {
    lines.push("");
    for (const r of rows) {
      const note = r.note ? `  ${c.faint}(detected: ${sanitizeValue(r.note)})${c.reset}` : "";
      if (r.from !== undefined) {
        const glyph = r.value === null ? "-" : r.from === null ? "+" : "~";
        // link() is amber already; everything else incoming (the cleared row's — too) is wrapped.
        const incoming =
          r.value !== null && isHttpUrl(r.value)
            ? val(r.value)
            : `${c.amber}${r.value ?? MISSING}${c.reset}`;
        lines.push(
          `${c.amber}${glyph}${c.reset} ${c.faint}${r.label.padEnd(labelW)}` +
            `${outgoing(r.from, r.value)}${c.reset}${incoming}${note}`,
        );
        continue;
      }
      if (r.value === null) {
        lines.push(`  ${c.faint}${r.label.padEnd(labelW)}  ${MISSING}${c.reset}`);
        continue;
      }
      lines.push(`  ${c.faint}${r.label.padEnd(labelW)}${c.reset}  ${val(r.value)}${note}`);
    }
  }
  if (extras.length) {
    lines.push("");
    for (const x of extras) {
      lines.push(`  ${c.faint}${x.label.padEnd(labelW)}${c.reset}  ${val(x.value)}`);
    }
  }
  if (!preview) {
    lines.push("", `  ${c.faint}updated ${relTime(profile.updated_at, opts.now)}${c.reset}`);
  }
  return lines.join("\n");
}

/**
 * One marked row as the per-key take question (publish's `d`): `Editor    Zed → Neovim`, the
 * label padded so a run of questions lines up. No indent (the prompter adds the unit's), and the
 * values are never linked: a URL here is something to answer about, not to follow. Both values
 * are untrusted (wire-fetched and env-derived), so both are sanitized like a card row.
 */
export function takeLine(
  label: string,
  width: number,
  saved: string,
  detected: string,
  color: boolean,
): string {
  const c = palette(color);
  return (
    `${c.faint}${label.padEnd(width)}${c.reset}  ${sanitizeValue(saved)} ` +
    `${c.faint}→${c.reset} ${sanitizeValue(detected)}`
  );
}

const MISSING = "—";

function extrasBlock(
  extras: ExtraDiff,
  theirsLabel: string,
  mineLabel: string,
  labelW: number,
  c: Codes,
  color: boolean,
  term: string | undefined,
): string[] {
  if (!extras.theirs.length && !extras.mine.length) return [];
  // The web's heading: extras are listed, never diffed, so two `Keyboard` lines are not a pair.
  const out: string[] = ["", `  ${c.faint}extras (not compared)${c.reset}`];
  // The owner sits in the rows' label column and `label = value` starts at the value column, one
  // tab stop for the whole readout as on the web (`--label-col`) and the card. A longer owner
  // pushes it out for every extras line alike. Padded as plain text before the faint codes go
  // around it, or the codes would count. The whole line is faint: uncompared, so dimmed like the
  // web's `.extras-dim` and never amber.
  const whoW = Math.max(
    labelW,
    extras.theirs.length ? theirsLabel.length : 0,
    extras.mine.length ? mineLabel.length : 0,
  );
  // A URL value is a link with color on, shortened as on the card, but faint like the rest of
  // the line: in the diff amber says "differs", and a terminal shows no underline to tell a link
  // apart (the web's extras link is amber, but underlined).
  const line = (who: string, label: string, value: string): string => {
    const v = sanitizeValue(value);
    const shown = color && isHttpUrl(v) ? hyperlink(v.trim(), displayUrl(v), term) : v;
    return `  ${c.faint}${who.padEnd(whoW)}  ${sanitizeValue(label)} = ${shown}${c.reset}`;
  };
  for (const x of extras.theirs) out.push(line(theirsLabel, x.label, x.value));
  for (const x of extras.mine) out.push(line(mineLabel, x.label, x.value));
  return out;
}

const ELLIPSIS = "…";
// The narrowest a capped value column gets. Below it a cut cell says too little to be worth the
// cut, so the diff prints full values and lets the terminal wrap, as it did before any cap.
const MIN_CELL = 6;

/** `s` cut to `w` columns, ending in `…` when it doesn't fit. Cuts between code points, never
 *  inside a surrogate pair. Measures `.length` like the padding does: a wide character (CJK,
 *  emoji) takes two columns on screen and is under-counted by both. */
function cut(s: string, w: number): string {
  if (s.length <= w) return s;
  let kept = "";
  for (const ch of s) {
    if (kept.length + ch.length > w - ELLIPSIS.length) break;
    kept += ch;
  }
  return kept + ELLIPSIS;
}

/** The part of `cps` (a value's code points) from `start`, in `w` columns: a leading `…` when
 *  it starts past the beginning, a trailing one when it still doesn't fit. */
function windowAt(cps: string[], start: number, w: number): string {
  if (start === 0) return cut(cps.join(""), w);
  return ELLIPSIS + cut(cps.slice(start).join(""), w - ELLIPSIS.length);
}

/** The two value columns' widths. Without `columns` (stdout not a terminal) both keep their
 *  longest value: a script reads full values. On a terminal the row (gutter, label, two values,
 *  their gaps) has to fit, so the longer column gives way first: a column that fits in half the
 *  room keeps its width and the other takes the rest, else both get the same half (an odd column
 *  left over goes unused: two cuts of one value at different widths would look different on an
 *  `=` row). Too little room for MIN_CELL in a column being cut and nothing is cut. */
function valueWidths(
  labelW: number,
  theirs: number,
  mine: number,
  columns: number | undefined,
): [number, number] {
  if (columns === undefined) return [theirs, mine];
  const room = columns - labelW - 6;
  if (theirs + mine <= room) return [theirs, mine];
  const half = Math.floor(room / 2);
  const [t, m] =
    theirs <= half
      ? [theirs, room - theirs]
      : mine <= room - half
        ? [room - mine, mine]
        : [half, half];
  // Only a column that is cut needs the room; one keeping its own width may be narrower.
  const tooNarrow = (w: number, own: number): boolean => w < own && w < MIN_CELL;
  return tooNarrow(t, theirs) || tooNarrow(m, mine) ? [theirs, mine] : [t, m];
}

/**
 * The shown text of a row's two cells. A URL shortens like the card's (displayUrl) with color on,
 * where it is also a link to the full address. With color off it stays the full URL (link()'s
 * rule: a terminal can still detect it), unless it is about to be cut, which loses that anyway.
 * Then each cell is cut to its column.
 *
 * A differing row must never show two equal-looking cells (the web's pairCells rule,
 * packages/web/src/lib/diff-cells.ts). Shortening can make two URLs match (https://x vs x,
 * user@host vs host, GitHub.com vs github.com, all of which dotfiles compares verbatim): the row
 * then drops the shortening. A cut can too (two long URLs that differ past it): checked at the
 * narrower column, the row then shows both cells from the same point a little before the first
 * character that differs, `…/editor/v1` against `…/editor/v2`, so the difference is in view.
 * Two values that differ only by invisible characters come in already marked (lookAlike), so
 * the first character that differs is a U+FFFD and a cut keeps it in view too.
 */
function pairShown(
  theirs: string | null,
  mine: string | null,
  differ: boolean,
  widths: [number, number],
  color: boolean,
): [string, string] {
  const both = differ && theirs !== null && mine !== null;
  const short = (v: string | null, w: number): string =>
    v === null ? MISSING : isHttpUrl(v) && (color || v.length > w) ? displayUrl(v) : v;
  const [tw, mw] = widths;
  let [t, m] = [short(theirs, tw), short(mine, mw)];
  if (both && t === m) [t, m] = [theirs, mine];
  const w = Math.min(tw, mw);
  if (!both || cut(t, w) !== cut(m, w)) return [cut(t, tw), cut(m, mw)];
  const [tc, mc] = [[...t], [...m]];
  let i = 0;
  while (i < tc.length && tc[i] === mc[i]) i++;
  // Half the window before the difference, or as much as the longer value's end leaves room for.
  const start = Math.max(
    0,
    Math.min(i - Math.floor(w / 2), Math.max(tc.length, mc.length) - w + 1),
  );
  return [windowAt(tc, start, w), windowAt(mc, start, w)];
}

/** Would a differing row's two (sanitized) cells still look the same once pairShown has dropped
 *  any shortening that made them match? Asked of the uncut forms, so every width marks alike.
 *  Then renderDiff marks the row's invisibles (the web's pairCells rule): `zsh` against `zsh`
 *  plus a bidi control or a zero-width space shows as `zsh` against `zsh�`. Two values that
 *  differ only by WHICH invisible they carry still look alike; that is the floor of a glyph. */
function lookAlike(theirs: string, mine: string, color: boolean): boolean {
  const short = (v: string): string => (color && isHttpUrl(v) ? displayUrl(v) : v);
  const [t, m] = short(theirs) === short(mine) ? [theirs, mine] : [short(theirs), short(mine)];
  return t.replace(INVISIBLE_RE, "") === m.replace(INVISIBLE_RE, "");
}

/**
 * The diff — the soul of ymmv — as a 3-column readout: label | theirs | yours. Differing rows mark
 * BOTH value columns amber with a leading amber dot (a difference is symmetric, neither side is the
 * "wrong" one — mirrors the web diff); same rows are muted. A row only one side filled in is not
 * a different tool, so it spends no amber: a faint dot, the label in ink, both cells faint. With
 * color off, a leading `~` (differ) / `=` (same) / `?` (one side only) carries the same
 * information so it reads on any terminal. `?` because the row can't be compared; `+`/`-` would
 * read as the publish preview's new/cleared, two screens apart.
 *
 * The count line splits the same way, `N differ   N shared   N only <theirs>   N only <mine>`, an
 * `only` segment left out at 0 (the web's foot, same order and words).
 *
 * `page` is the web page this readout mirrors (diffPageUrl). It heads the diff where the card
 * puts its `ymmv.fyi/<handle>` breadcrumb, and like that breadcrumb (and the web page's title) it
 * drops `https://` in both color modes, so a piped diff and a piped card name their pages alike.
 * It is faint throughout, handles included: the heading right under it bolds them already. An
 * address, not a difference, so never amber; with color on it is an OSC-8 link to the full URL.
 *
 * `columns` is the terminal's width when stdout is one (the caller reads it; this stays pure).
 * With it, the value columns are capped so a row fits and a longer cell ends in `…` (valueWidths,
 * pairShown); one long dotfiles URL no longer wraps every row. Without it nothing is cut, so piped
 * output keeps every value whole. Widths are measured on the plain text, and color and links go
 * around it afterwards, so escape bytes never count as columns.
 */
export function renderDiff(
  result: DiffResult,
  opts: {
    color: boolean;
    theirsLabel: string;
    mineLabel: string;
    page: string;
    columns?: number;
    term?: string;
  },
): string {
  const c = palette(opts.color);
  const term = opts.term ?? process.env.TERM;
  const theirsLabel = sanitizeValue(opts.theirsLabel);
  const mineLabel = sanitizeValue(opts.mineLabel);

  const rows = result.rows.map((r) => {
    const theirs = r.theirs === null ? null : sanitizeValue(r.theirs);
    const mine = r.mine === null ? null : sanitizeValue(r.mine);
    const differ = r.status !== "same";
    // `theirs`/`mine` stay unmarked: they are what a cell links to. `shown` is what pairShown
    // shortens and cuts, marked when the two would otherwise look alike. Same rows never are.
    const pair =
      differ && r.theirs !== null && r.mine !== null ? ([r.theirs, r.mine] as const) : null;
    const shown: [string | null, string | null] =
      pair && lookAlike(sanitizeValue(pair[0]), sanitizeValue(pair[1]), opts.color)
        ? [markInvisible(pair[0]), markInvisible(pair[1])]
        : [theirs, mine];
    return {
      label: r.label,
      theirs,
      mine,
      shown,
      differ,
      one: r.status === "only_theirs" || r.status === "only_mine",
    };
  });
  const labelW = Math.max(3, ...rows.map((r) => r.label.length));
  // Natural widths, of the form each cell shows uncut: column heads (the handles as stored, faint,
  // like the web diff's: DESIGN.md, Diff session) and values, shortened where pairShown would.
  const natural = rows.map((r) =>
    pairShown(...r.shown, r.differ, [Infinity, Infinity], opts.color),
  );
  const widths = valueWidths(
    labelW,
    Math.max(theirsLabel.length, ...natural.map(([t]) => t.length)),
    Math.max(mineLabel.length, ...natural.map(([, m]) => m.length)),
    opts.columns,
  );
  const [theirsW, mineW] = widths;
  // A shown cell, linked to its full URL with color on. Padded after the link closes, so the
  // padding is neither underlined nor clickable.
  const cell = (shown: string, raw: string | null, w?: number): string => {
    const pad = w === undefined ? "" : " ".repeat(Math.max(0, w - shown.length));
    const linked =
      opts.color && raw !== null && isHttpUrl(raw) ? hyperlink(raw.trim(), shown, term) : shown;
    return linked + pad;
  };

  const page = sanitizeValue(opts.page);
  const pageText = `${c.faint}${displayUrl(page)}${c.reset}`;
  const lines: string[] = [
    "",
    `  ${opts.color ? hyperlink(page, pageText, term) : pageText}`,
    // The web diff's h1, collapsed to one line — information (which side is which), not decoration,
    // so it prints in both color modes.
    `  ${c.faint}how${c.reset} ${c.bold}${theirsLabel}${c.reset} ${c.faint}differs from${c.reset} ${c.bold}${mineLabel}${c.reset}`,
    "",
  ];
  lines.push(
    `  ${c.faint}${"".padEnd(labelW)}  ${cut(theirsLabel, theirsW).padEnd(theirsW)}  ${cut(mineLabel, mineW)}${c.reset}`,
  );
  for (const r of rows) {
    const [ts, ms] = pairShown(...r.shown, r.differ, widths, opts.color);
    if (!opts.color) {
      const sym = r.one ? "?" : r.differ ? "~" : "=";
      lines.push(`${sym} ${r.label.padEnd(labelW)}  ${ts.padEnd(theirsW)}  ${ms}`);
    } else if (r.one) {
      // Both sides faint (the set one a link when it's a URL), the label in ink: the row recedes
      // like a shared one but its dot and label keep it apart from one.
      const side = (shown: string, raw: string | null): string =>
        `${c.faint}${raw === null ? shown : cell(shown, raw)}${c.reset}`;
      lines.push(
        `${c.faint}•${c.reset} ${r.label.padEnd(labelW)}  ${side(ts, r.theirs)}` +
          `${" ".repeat(Math.max(0, theirsW - ts.length))}  ${side(ms, r.mine)}`,
      );
    } else if (r.differ) {
      lines.push(
        `${c.amber}•${c.reset} ${r.label.padEnd(labelW)}  ` +
          `${c.amber}${cell(ts, r.theirs)}${c.reset}${" ".repeat(Math.max(0, theirsW - ts.length))}  ` +
          `${c.amber}${cell(ms, r.mine)}${c.reset}`,
      );
    } else {
      lines.push(
        `  ${c.faint}${r.label.padEnd(labelW)}  ${cell(ts, r.theirs, theirsW)}  ${cell(ms, r.mine)}${c.reset}`,
      );
    }
  }

  lines.push(...extrasBlock(result.extras, theirsLabel, mineLabel, labelW, c, opts.color, term));
  const counts = [`${result.differ} differ`, `${result.shared} shared`];
  if (result.onlyTheirs) counts.push(`${result.onlyTheirs} only ${theirsLabel}`);
  if (result.onlyMine) counts.push(`${result.onlyMine} only ${mineLabel}`);
  lines.push("", `  ${c.faint}${counts.join("   ")}${c.reset}`);
  return lines.join("\n");
}

/** Logged-in-but-no-profile nudge (the one amber call-to-action, link-like). `lead` is what
 *  publishing gets the viewer: a diff beside a profile, just a profile of their own after a miss. */
export function nudge(color: boolean, lead = "publish yours to diff"): string {
  const c = palette(color);
  return `\n  ${c.amber}${lead} →${c.reset} run ${c.bold}ymmv${c.reset}`;
}

/** The "unknown handle" line, in the web's words with the handle quoted (the arg is already
 *  handle-validated; sanitize defensively). It points nowhere: the viewer cannot publish someone
 *  else's profile, and whether to nudge them to publish their own is view()'s call. */
export function notFound(handle: string): string {
  return `\n  no ymmv profile for "${sanitizeValue(handle)}" yet.`;
}
