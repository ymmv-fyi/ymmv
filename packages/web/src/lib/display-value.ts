import { displayUrl } from "@ymmv/shared";
import { sanitizeText } from "./sanitize.ts";

// The full value for a title attribute, only when the display text differs from the stored value
// (scheme dropped or host normalized; a trim alone does not count), so untouched values don't grow
// a redundant tooltip. Sanitized like any other rendered text.
export function urlTitle(value: string): string | undefined {
  const trimmed = value.trim();
  return displayUrl(value) !== trimmed ? sanitizeText(trimmed) : undefined;
}
