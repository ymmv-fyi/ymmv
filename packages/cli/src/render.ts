import {
  CURATED_KEYS,
  type DiffResult,
  type Entry,
  type ExtraDiff,
  KEY_LABELS,
  type Profile,
} from "@ymmv/shared";

// Terminal rendering — the CLI half of the design system. Mirrors the web surface (DESIGN.md):
// aligned key→value columns, amber ONLY on diff-differences (the load-bearing scarcity rule), muted
// for same. Two hard requirements live here:
//   • NO_COLOR (no-color.org): drop all ANSI and fall back to `~` (changed) / `=` (same) symbols so
//     the diff still reads on any terminal.
//   • Output sanitization: every profile value is UNTRUSTED — strip ANSI/control sequences
//     before printing so a crafted value can't move the cursor, recolor the screen, or inject lines.
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
type Codes = typeof CODES;
const NO_CODES: Codes = { amber: "", faint: "", bold: "", reset: "" };

function palette(color: boolean): Codes {
  return color ? CODES : NO_CODES;
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
 * no-color.org); then an explicit FORCE_COLOR; otherwise color only on a real TTY.
 */
export function useColor(env: Env, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined) return false;
  // FORCE_COLOR convention (supports-color): "0" force-DISABLES, any other value force-enables.
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  return isTTY;
}

/** Curated entries in canonical order, with display labels; non-curated rows are dropped. */
function orderedEntries(profile: Profile): { label: string; value: string }[] {
  const byKey = new Map<string, string>(
    (profile.entries ?? []).map((e: Entry) => [e.key, e.value]),
  );
  return CURATED_KEYS.flatMap((key) => {
    const value = byKey.get(key);
    return value === undefined ? [] : [{ label: KEY_LABELS[key], value: sanitizeValue(value) }];
  });
}

/** A single profile as a key→value spec sheet (plain view; no amber — amber is reserved for diffs). */
export function renderProfile(profile: Profile, opts: { color: boolean }): string {
  const c = palette(opts.color);
  const rows = orderedEntries(profile);
  const extras = (profile.extras ?? []).map((x) => ({
    label: sanitizeValue(x.label),
    value: sanitizeValue(x.value),
  }));
  const labelW = Math.max(
    0,
    ...rows.map((r) => r.label.length),
    ...extras.map((x) => x.label.length),
  );

  const lines: string[] = ["", `  ${c.bold}${sanitizeValue(profile.handle)}${c.reset}`, ""];
  for (const r of rows) {
    lines.push(`  ${c.faint}${r.label.padEnd(labelW)}${c.reset}  ${r.value}`);
  }
  if (extras.length) {
    lines.push("");
    for (const x of extras) {
      lines.push(`  ${c.faint}${x.label.padEnd(labelW)}${c.reset}  ${x.value}`);
    }
  }
  lines.push("", `  ${c.faint}updated ${sanitizeValue(profile.updated_at)}${c.reset}`, "");
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
  const theirsW = Math.max(theirsLabel.length, ...cells.map((r) => r.theirs.length));

  const lines: string[] = [""];
  // Column header (which side is which), muted.
  lines.push(
    `  ${c.faint}${"".padEnd(labelW)}  ${theirsLabel.padEnd(theirsW)}  ${mineLabel}${c.reset}`,
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
  lines.push(
    "",
    `  ${c.faint}${result.differ} differ · ${result.shared} shared — your mileage may vary${c.reset}`,
    "",
  );
  return lines.join("\n");
}

/** Logged-in-but-no-profile nudge (the one amber call-to-action, link-like). */
export function nudge(color: boolean): string {
  const c = palette(color);
  return `\n  ${c.amber}publish yours to diff →${c.reset} run ${c.bold}ymmv${c.reset}\n`;
}

/** Friendly "unknown handle" message (the arg is already handle-validated; sanitize defensively). */
export function notFound(handle: string): string {
  return (
    `\n  no ymmv profile for "${sanitizeValue(handle)}" yet.\n` +
    "  publish one at ymmv.fyi with: npx ymmv-cli\n"
  );
}
