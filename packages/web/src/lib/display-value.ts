// Display-only URL shortening: drop the boring-default "https://" so long links wrap at the
// value column instead of splitting after the scheme on narrow screens. Deliberately narrow:
//   • http:// is KEPT — a cleartext link target is noteworthy, hiding it misleads the clicker;
//   • the lookahead keeps a bare "https://" intact rather than rendering an empty cell.
// Hrefs and stored values always keep the full URL — this never feeds comparison or output.
export function displayUrl(value: string): string {
  // trim first: values are stored untrimmed while dotfiles compares trimmed, so a leading
  // space must not defeat the anchor and render a "same" row as two different-looking strings
  return value.trim().replace(/^https:\/\/(?=.)/i, "");
}

// The full value for a title attribute — only when the display text was shortened,
// so unshortened values don't grow a redundant tooltip.
export function urlTitle(value: string): string | undefined {
  return displayUrl(value) !== value ? value : undefined;
}
