import { sanitizeValue } from "./render.js";

// Worker API base. Defaults to production (ymmv.fyi); `YMMV_API` overrides it (set to
// http://localhost:4321 for the local astro-dev loop, a `wrangler dev` URL, or the staging
// workers.dev URL). Trailing slashes are stripped so `${BASE}/api/...` never double-slashes.
// YMMV_API must be a bare origin (no path prefix): the Worker's rename 301 sends a root-absolute
// Location, so a path-mounted base would lose its prefix on the redirect.

/** The one normalization applied to a configured base. baseProblem() validates THIS value — the
 *  validator and the request base share one code path so they can never drift. */
export function normalizeBase(raw: string): string {
  return raw.replace(/\/+$/, "");
}

// `||`, not `??`: `YMMV_API= ymmv` (the shell way of "clearing" a variable) sets the EMPTY string,
// and empty means unset here — falling back to the default base matches the user's evident intent.
export const BASE = normalizeBase(process.env.YMMV_API || "https://ymmv.fyi");

/**
 * Why the configured YMMV_API can't be used (a full user-facing message), or null when it's fine
 * (unset, or a valid bare http/https origin). Called at the top of main() so a config mistake
 * fails fast with its real diagnosis — an unparseable base otherwise surfaces as fetch throwing,
 * which safeFetch mislabels as "Can't reach ... Check your connection". Pure over `raw` for tests;
 * production passes nothing and reads the env at call time.
 */
export function baseProblem(raw: string | undefined = process.env.YMMV_API): string | null {
  // Empty means unset (BASE falls back to the default above) — never an error.
  if (raw === undefined || raw === "") return null;
  const shown = `YMMV_API is set to "${sanitizeValue(raw)}"`;
  // new URL() silently trims surrounding whitespace that BASE keeps, so a space-padded value
  // would validate clean here and then break every request URL — reject it instead.
  if (/\s/.test(raw)) return `${shown} which contains whitespace. Remove it.`;
  const base = normalizeBase(raw);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return `${shown} which is not a full URL. Use a bare origin like https://ymmv.fyi (the http:// or https:// scheme is required).`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `${shown} which is not an http or https URL. Use a bare origin like https://ymmv.fyi.`;
  }
  if (url.username || url.password) {
    return `${shown} which contains credentials. Use a bare origin like https://ymmv.fyi.`;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return `${shown} which is not a bare origin. Drop the path (the Worker's redirects are root-absolute, so a path-mounted base breaks): use just the scheme and host, like https://ymmv.fyi.`;
  }
  // Catch-all: the STRING must equal its own parsed origin. The URL parser normalizes away a
  // trailing "?" or "#", dot segments ("/$(id)/../.."), backslashes, ":443", scheme-relative
  // forms, and case, so every earlier check sees a clean parse while BASE keeps the raw string.
  // Without this, a value can pass the gate yet route every request somewhere else, scope
  // token.json under a junk base, and smuggle shell metacharacters into recovery copy.
  if (base !== url.origin) {
    return `${shown} which is not in canonical form. Use exactly the scheme and host, like https://ymmv.fyi.`;
  }
  return null;
}
