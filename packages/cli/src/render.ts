import {
  CURATED_KEYS,
  type DiffResult,
  type Entry,
  type ExtraDiff,
  KEY_LABELS,
  type Profile,
} from "@ymmv/shared";

// Terminal rendering — the CLI half of the design system. Mirrors the web surface (ymmv.css):
// aligned key→value columns, amber on links + diff-differences ONLY (the load-bearing scarcity
// rule, same as the web), muted for same. Two hard requirements live here:
//   • NO_COLOR (no-color.org): drop all ANSI and fall back to `~` (changed) / `=` (same) symbols so
//     the diff still reads on any terminal.
//   • Output sanitization: every profile value is UNTRUSTED — strip ANSI/control sequences
//     before printing so a crafted value can't move the cursor, recolor the screen, or inject lines.
//
// Output convention: every user-facing output unit — card, diff, prompt, confirmation, note block,
// error — begins with exactly ONE blank line and is indented two spaces; units never carry trailing
// blank lines (console.log terminates the line). The render* builders return whole units; every
// other print wraps in message(). The bin entry (cli.ts) prints the single closing blank line
// before the shell prompt — to stdout on success, to stderr on a non-zero exit so failed runs
// leave stdout byte-clean for pipes. Exceptions: `ymmv help` and `--version` stay flush-left
// (reference surfaces, read by pipes as much as by people; help is byte-pinned by its snapshot).
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
// Unicode bidi overrides + isolates (U+202A–202E, U+2066–2069) and LRM/RLM (U+200E/200F). These
// visually reorder text (Trojan-Source-style spoofing) without being ANSI or C0/C1, so strip them
// too — no legitimate single-line stack value needs a directional control.
const BIDI_RE = new RegExp(
  `[${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}]`,
  "g",
);

/** Neutralize an untrusted value for terminal display: strip ANSI + control + bidi chars. */
export function sanitizeValue(value: string): string {
  return value.replace(ANSI_RE, "").replace(CTRL_RE, "").replace(BIDI_RE, "");
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

/** Color for the current process: NO_COLOR/FORCE_COLOR, else stdout TTY state. */
export function colorEnabled(): boolean {
  return useColor(process.env, Boolean(process.stdout.isTTY));
}

const OSC = `${ESC}]`;
const ST = `${ESC}\\`;

/**
 * Display-only URL shortening: trim + strip a leading "https://" (the boring default; "http://"
 * stays deliberately — it is information). Duplicated from the web on purpose
 * (packages/web/src/lib/display-value.ts) — the web package must not become a CLI dependency and
 * @ymmv/shared stays wire-schema-only.
 */
export function displayUrl(value: string): string {
  return value.trim().replace(/^https:\/\/(?=.)/i, "");
}

const HTTP_URL_RE = /^https?:\/\/\S+$/i;

/** Is this value a bare http(s) URL (the whole value, no whitespace)? */
export function isHttpUrl(value: string): boolean {
  return HTTP_URL_RE.test(value.trim());
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
  if (term !== undefined && NO_OSC8_TERMS.has(term)) return text;
  return `${OSC}8;;${clean}${ST}${text}${OSC}8;;${ST}`;
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
 */
export function renderProfile(
  profile: Profile,
  opts: { color: boolean; site: string; mode?: "view" | "preview"; now?: () => number },
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
    return [{ label: KEY_LABELS[key], value: value === undefined ? null : sanitizeValue(value) }];
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
  const val = (v: string): string => (isHttpUrl(v) ? link(v, opts.color) : v);

  // Every section (rows, extras, updated) pushes its OWN leading blank — the breadcrumb never
  // pre-pays one. A profile with zero curated rows would otherwise stack the breadcrumb's blank
  // on the next section's, breaking the one-blank-line-between-units convention.
  const lines: string[] = [
    "",
    `  ${c.faint}${opts.site}/${c.reset}${c.bold}${sanitizeValue(profile.handle)}${c.reset}`,
  ];
  if (rows.length) {
    lines.push("");
    for (const r of rows) {
      lines.push(
        r.value === null
          ? `  ${c.faint}${r.label.padEnd(labelW)}  ${MISSING}${c.reset}`
          : `  ${c.faint}${r.label.padEnd(labelW)}${c.reset}  ${val(r.value)}`,
      );
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

const MISSING = "—";

function extrasBlock(
  extras: ExtraDiff,
  theirsLabel: string,
  mineLabel: string,
  c: Codes,
): string[] {
  if (!extras.theirs.length && !extras.mine.length) return [];
  const out: string[] = ["", `  ${c.faint}extras${c.reset}`];
  const line = (who: string, label: string, value: string): string =>
    `  ${c.faint}${who}${c.reset}  ${sanitizeValue(label)} = ${sanitizeValue(value)}`;
  for (const x of extras.theirs) out.push(line(theirsLabel, x.label, x.value));
  for (const x of extras.mine) out.push(line(mineLabel, x.label, x.value));
  return out;
}

/**
 * The diff — the soul of ymmv — as a 3-column readout: label | theirs | yours. Differing rows mark
 * BOTH value columns amber with a leading amber dot (a difference is symmetric, neither side is the
 * "wrong" one — mirrors the web diff); same rows are muted. With color off, a leading `~`/`=`
 * symbol carries the same information so it reads on any terminal.
 */
export function renderDiff(
  result: DiffResult,
  opts: { color: boolean; theirsLabel: string; mineLabel: string },
): string {
  const c = palette(opts.color);
  const theirsLabel = sanitizeValue(opts.theirsLabel);
  const mineLabel = sanitizeValue(opts.mineLabel);

  const cells = result.rows.map((r) => ({
    label: r.label,
    theirs: r.theirs === null ? MISSING : sanitizeValue(r.theirs),
    mine: r.mine === null ? MISSING : sanitizeValue(r.mine),
    differ: r.status !== "same",
  }));
  const labelW = Math.max(3, ...cells.map((r) => r.label.length));
  // Column headers echo the web's uppercase letterspaced caps; widths come from what is printed.
  const theirsHead = theirsLabel.toUpperCase();
  const theirsW = Math.max(theirsHead.length, ...cells.map((r) => r.theirs.length));

  const lines: string[] = [
    "",
    // The web diff's h1, collapsed to one line — information (which side is which), not decoration,
    // so it prints in both color modes.
    `  ${c.faint}how${c.reset} ${c.bold}${theirsLabel}${c.reset} ${c.faint}differs from${c.reset} ${c.bold}${mineLabel}${c.reset}`,
    "",
  ];
  lines.push(
    `  ${c.faint}${"".padEnd(labelW)}  ${theirsHead.padEnd(theirsW)}  ${mineLabel.toUpperCase()}${c.reset}`,
  );
  for (const r of cells) {
    if (!opts.color) {
      const sym = r.differ ? "~" : "=";
      lines.push(`${sym} ${r.label.padEnd(labelW)}  ${r.theirs.padEnd(theirsW)}  ${r.mine}`);
    } else if (r.differ) {
      lines.push(
        `${c.amber}•${c.reset} ${r.label.padEnd(labelW)}  ` +
          `${c.amber}${r.theirs.padEnd(theirsW)}${c.reset}  ${c.amber}${r.mine}${c.reset}`,
      );
    } else {
      lines.push(
        `  ${c.faint}${r.label.padEnd(labelW)}  ${r.theirs.padEnd(theirsW)}  ${r.mine}${c.reset}`,
      );
    }
  }

  lines.push(...extrasBlock(result.extras, theirsLabel, mineLabel, c));
  lines.push("", `  ${c.faint}${result.differ} differ   ${result.shared} shared${c.reset}`);
  return lines.join("\n");
}

/** Logged-in-but-no-profile nudge (the one amber call-to-action, link-like). */
export function nudge(color: boolean): string {
  const c = palette(color);
  return `\n  ${c.amber}publish yours to diff →${c.reset} run ${c.bold}ymmv${c.reset}`;
}

/** Friendly "unknown handle" message (the arg is already handle-validated; sanitize defensively).
 *  `base` is the full site URL (BASE) — linked amber like every other link. */
export function notFound(handle: string, color: boolean, base: string): string {
  return (
    `\n  no ymmv profile for "${sanitizeValue(handle)}" yet.\n` +
    `  publish one at ${link(base, color)} with: npx ymmv-cli@latest`
  );
}
