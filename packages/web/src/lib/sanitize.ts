/**
 * Render-time stripping of Unicode bidi controls from untrusted text.
 *
 * \p{Bidi_Control} is the twelve code points that re-direct or reorder text without occupying
 * space (U+202A–202E, U+2066–2069, U+200E/200F, U+061C); `zsh<RLO>evil` displays reversed
 * (Trojan-Source-style spoofing). No single-line stack value needs one, and every HTML surface
 * strips them because the store and the JSON API keep values verbatim (an invisible char
 * decorating real text is the user's data). Same property as the CLI's render.ts BIDI_RE,
 * duplicated on purpose: @ymmv/shared never sanitizes (each surface owns its own strip).
 *
 * `mark` replaces each control with U+FFFD instead of deleting it, for the diff table's collide
 * guard: two differing values that collapse to one string after stripping must not render as
 * two equal cells. U+FFFD has no directional effect.
 *
 * Deliberately narrow: C0/C1 are harmless under Astro's escaping, and the wider Default_Ignorable
 * set (zero-width space/joiners, variation selectors) is kept as user data here; the diff table's
 * collide guard (lib/diff-cells.ts) is the one place that marks some of them.
 */
const BIDI_RE = /\p{Bidi_Control}/gu;
const REPLACEMENT_CHAR = String.fromCodePoint(0xfffd);

export function sanitizeText(value: string, opts?: { mark?: boolean }): string {
  return value.replace(BIDI_RE, opts?.mark ? REPLACEMENT_CHAR : "");
}
