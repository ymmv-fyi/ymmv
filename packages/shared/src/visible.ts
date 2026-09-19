/**
 * The visibility rule the web write handler (`api/v1/profile.ts`) enforces and the CLI
 * pre-flights, like the caps in caps.ts. Unlike a cap, the property escape below is resolved
 * from the running engine's Unicode table (the user's Node for the CLI, workerd for the Worker),
 * so the two can disagree on a code point a newer Unicode assigns; the CLI check is a courtesy
 * and the Worker's 422 stays the trust boundary.
 *
 * Code points that occupy no visual space: zero-width space/joiners, bidi marks and embedding
 * controls, variation selectors, the Arabic letter mark, and the rest of Unicode's
 * Default_Ignorable_Code_Point set — the engine-maintained property, where a hand-rolled class
 * drifts (an earlier one missed U+061C) — plus the C0/C1 controls (Cc: U+0000-001F, U+007F-009F),
 * which render as nothing too. `.trim()` does NOT remove these (it strips the Zs whitespace set
 * plus U+FEFF), so a field of only U+200B or U+0001 passes an emptiness check, stores, and
 * renders as a blank row. Reject a field only when NOTHING visible survives — an invisible char
 * decorating real text is the user's data and is stored verbatim.
 *
 * A predicate only, never a sanitizer: @ymmv/shared never rewrites a value (each surface owns its
 * own strip — see the web's lib/sanitize.ts and the CLI's render.ts).
 */
// One visible code point is enough, so look for it instead of stripping and trimming a copy:
// `\s` is exactly the set String.prototype.trim removes (WhiteSpace + LineTerminator, U+FEFF
// included), and /u lets the property escape see an astral code point (the tag block) whole
// rather than as two surrogates. No /g: a global regex carries lastIndex across `test` calls.
const VISIBLE_RE = /[^\s\p{Default_Ignorable_Code_Point}\p{Cc}]/u;

export function hasVisibleContent(s: string): boolean {
  return VISIBLE_RE.test(s);
}
