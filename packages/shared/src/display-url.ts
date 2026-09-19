/**
 * Display-only URL shortening, shared by the web (profile + diff pages) and the CLI (profile card,
 * page pointers). Drops the boring-default "https://" so long links wrap at the value column, and
 * rebuilds the AUTHORITY from a real URL parse so the shown text cannot lie about the destination:
 *   • userinfo is dropped: "https://good.com@evil.com" shows "evil.com", the host actually hit;
 *   • the host is the parser's (lowercased, IDN as punycode): a Cyrillic "аррӏе.com" lookalike
 *     shows as "xn--80ak6aa92e.com";
 *   • a non-default port stays ("a.com:8080"); the default one goes.
 * The path/query/hash are kept VERBATIM, not `url.pathname`: that percent-encodes non-ASCII and
 * would hide a bidi control from the per-surface sanitizer as "%E2%80%AE". Only the authority is
 * spoofable, so only the authority is rebuilt.
 *   • http:// KEEPS its scheme (a cleartext link target is information) but gets the same host;
 *   • a value that fails the parse (bare "https://", "https://evil com") or has another scheme
 *     comes back trimmed but otherwise untouched, so it never borrows a link's look.
 * The gate here must agree with the link gates (web safeHref, CLI isHttpUrl: both `new URL`) on
 * what is a link: any value the parser accepts as http(s) gets its authority rewritten, or the raw
 * spoof text would render as the link's label. So the pre-split mirrors the parser: ASCII
 * tab/LF/CR are stripped anywhere and C0/space at the edges, and any run of "/" or "\" after
 * the scheme is accepted ("https:/x", "https:\\x", "https:///x" all parse to host "x").
 * Hrefs, titles and stored values always keep the full URL: this never feeds comparison or output.
 * Host normalization makes new display collisions possible (GitHub.com vs github.com, user@host
 * vs host); the web diff guards by comparing what each cell will show, and the CLI diff never
 * shortens.
 */

const PARSER_STRIPS = /[\t\n\r]/g;
// authority / rest: the authority ends at the first "/", "?", "#" or "\" (the parser treats
// "\" as "/" for http(s)); the rest may span line terminators, which the parser also accepts.
const HTTP_RE = /^https?:[/\\]*([^/?#\\]*)([/?#\\][\s\S]*)?$/i;

// The parser's edge trim: C0 controls and space, of which String.prototype.trim covers only the
// whitespace ones. An index scan, because a regex trailing alternative is quadratic on a long run.
function trimC0(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

export function displayUrl(value: string): string {
  // trim first: values are stored untrimmed while dotfiles compares trimmed, so a leading space
  // must not defeat the anchor and render a "same" row as two different-looking strings
  const raw = value.trim();
  const input = trimC0(raw.replace(PARSER_STRIPS, ""));
  const m = HTTP_RE.exec(input);
  if (!m) return raw;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return raw;
  }
  const prefix = url.protocol === "http:" ? "http://" : "";
  return `${prefix}${url.host}${m[2] ?? ""}`;
}
