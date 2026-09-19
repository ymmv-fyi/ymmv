import { displayUrl } from "@ymmv/shared";
import { urlTitle } from "./display-value.ts";
import { sanitizeText } from "./sanitize.ts";

export interface Cell {
  text: string;
  title?: string;
}

const FFFD = String.fromCodePoint(0xfffd);
// HTML collapses a run of these five characters to one space and NBSP renders as one; a
// Default_Ignorable code point (zero-width space, soft hyphen, every bidi control) takes no space
// at all. None of them can tell two cells apart. The join controls, variation selectors and tag
// characters are left out: they shape glyphs (an emoji sequence vs its parts, emoji vs text
// presentation), so a difference in them is already visible and must not be marked.
const HTML_WS = /[ \t\n\r\f]+/g;
const NBSP = /\xa0/g;
const INVISIBLE =
  /(?![\p{Join_Control}\p{Variation_Selector}\u{e0020}-\u{e007f}])\p{Default_Ignorable_Code_Point}/gu;

// The cell text: bidi controls stripped (sanitizeText), or with `mark` every invisible code point
// replaced by U+FFFD so a difference that lives only in invisibles still shows.
function render(text: string, mark: boolean): string {
  const clean = sanitizeText(text, { mark });
  return mark ? clean.replace(INVISIBLE, FFFD) : clean;
}

// What a reader will see for `text` once rendered. Two cells with the same `shown` are
// indistinguishable on the page.
function shown(text: string, mark: boolean): string {
  const visible = mark ? render(text, true) : render(text, false).replace(INVISIBLE, "");
  return visible.replace(NBSP, " ").replace(HTML_WS, " ").trim();
}

/**
 * The two cells of a compared row (a missing side is null). Never display a marked difference as
 * two equal-looking strings: if shortening both sides would show the same text (https://x vs x,
 * GitHub.com vs github.com, user@host vs host, paths that differ only by whitespace or invisibles,
 * all of which dotfiles compares verbatim), render both raw; if the raw sides still look the same,
 * mark each invisible code point (U+FFFD) instead of dropping it. Two values that differ only by
 * whitespace count, or by WHICH invisible they carry, still look alike; that is the floor of what
 * a glyph can show. A row the diff calls "same" never collides: its sides may differ raw (dotfiles
 * compares trimmed) and both simply shorten.
 */
export function pairCells(
  theirs: string | null,
  mine: string | null,
  differs: boolean,
): [Cell | null, Cell | null] {
  const pair = differs && theirs != null && mine != null ? [theirs, mine] : null;
  // marked, not stripped: if even the marked shortened forms coincide, no shortened rendering can
  // tell the sides apart, so the raw values are the only honest choice
  const shortenCollide =
    pair != null && shown(displayUrl(pair[0]), true) === shown(displayUrl(pair[1]), true);
  const base = (v: string) => (shortenCollide ? v : displayUrl(v));
  const invisibleCollide =
    pair != null && shown(base(pair[0]), false) === shown(base(pair[1]), false);
  const cell = (v: string | null): Cell | null =>
    v == null
      ? null
      : {
          text: render(base(v), invisibleCollide),
          title: shortenCollide ? undefined : urlTitle(v),
        };
  return [cell(theirs), cell(mine)];
}
