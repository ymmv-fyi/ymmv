/**
 * URL guard for user-controlled values rendered as links (dotfiles URLs, URL-shaped extras).
 *
 * Astro auto-escapes every `{value}`, which neutralizes HTML injection — but escaping does NOT
 * neutralize a `javascript:` / `data:` / `vbscript:` href, which fires on click. So before a value
 * is ever used as an `href`, it must clear a scheme allowlist. Returns the URL only when it parses
 * as an absolute http(s) URL; otherwise null (the caller renders it as plain, escaped text).
 */
export function safeHref(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null; // not an absolute URL (e.g. "github.com/u/dotfiles") → render as text, never a link
  }
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}
