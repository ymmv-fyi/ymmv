import { sanitizeValue } from "./render.js";

// The one place a network-level fetch failure becomes words. Every fetch that surfaces its own
// network error goes through safeFetch so "TypeError: fetch failed" (or a TLS/proxy/DNS throw)
// never reaches the user raw. Two sanctioned exceptions stay bare: revokeYmmvToken (logout()
// owns its friendlier catch-all message) and pollForToken's poll fetch (thrown fetches feed the
// transient-failure counter instead of aborting the login).

/** The most specific human-readable cause available on a thrown fetch failure: undici nests the
 *  real reason under `cause` — often an AggregateError with an EMPTY message wrapping the real
 *  per-address errors (ECONNREFUSED on v4+v6 is the everyday local-dev case), so dig into it.
 *  Output is sanitized: these strings can carry middlebox/proxy bytes and get printed raw. */
export function causeText(err: unknown): string {
  const pick = (e: Error): string => {
    if (e instanceof AggregateError) {
      const first = e.errors.find((x): x is Error => x instanceof Error && x.message.length > 0);
      if (first) return first.message;
      const code = (e as NodeJS.ErrnoException).code;
      if (code) return String(code);
    }
    return e.message;
  };
  let text: string;
  if (err instanceof Error) {
    const fromCause = err.cause instanceof Error ? pick(err.cause) : "";
    text = fromCause || pick(err) || String(err);
  } else {
    text = String(err);
  }
  return sanitizeValue(text);
}

/** Wire-derived text bound for an error message: coerced (a malformed body can put a number or
 *  object where a string belongs — the error path must never itself throw), sanitized
 *  (origin/middlebox bytes print raw via console.error), and capped — a proxy block page can be
 *  a whole HTML document. */
export function wireText(text: unknown): string {
  const clean = sanitizeValue(String(text));
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

/**
 * fetch, but ANY thrown failure (undici TypeError, TLS, proxy, bad URL — deliberately not just
 * TypeError) becomes an actionable "can't reach" error carrying the underlying cause. HTTP
 * responses of every status pass through untouched — status handling stays with the caller.
 * `fetchFn` is injectable for tests (mirrors device-flow's PollDeps).
 */
export async function safeFetch(
  url: string,
  init: RequestInit | undefined,
  reach: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (err) {
    throw new Error(`Can't reach ${reach}. Check your connection (${causeText(err)})`, {
      cause: err,
    });
  }
}
