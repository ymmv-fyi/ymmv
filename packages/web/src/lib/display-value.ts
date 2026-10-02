import { displayUrl } from "@ymmv/shared";
import { sanitizeText } from "./sanitize.ts";

// The full value for a title attribute, only when the display text differs from the stored value
// (scheme dropped or host normalized; a trim alone does not count), so untouched values don't grow
// a redundant tooltip. Sanitized like any other rendered text.
export function urlTitle(value: string): string | undefined {
  const trimmed = value.trim();
  return displayUrl(value) !== trimmed ? sanitizeText(trimmed) : undefined;
}

// A URL's display text cut after each run of "/" (a run, so the "//" of a kept "http://" scheme
// stays whole). The caller renders a <wbr> between the pieces: Chromium offers no line break at
// a slash, so without one a narrow column cuts "github.com/antfu/dotfiles" mid-word. Joined, the
// pieces are `text` again; a <wbr> is not text, so textContent and the copied string don't change.
// The one definition of the rule: UntrustedValue's links and the diff's compared cells share it.
export function slashSegments(text: string): string[] {
  return text.split(/(?<=\/)(?=[^/])/);
}
