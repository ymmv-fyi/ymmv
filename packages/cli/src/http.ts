// The one place a network-level fetch failure becomes words. Every CLI fetch goes through
// safeFetch so "TypeError: fetch failed" (or a TLS/proxy/DNS throw) never reaches the user raw —
// api.ts, auth-http.ts, and device-flow.ts all label their host via `reach`.

/** The most specific human-readable cause available on a thrown fetch failure: undici nests the
 *  real reason (getaddrinfo ENOTFOUND…) under `cause`. */
export function causeText(err: unknown): string {
  if (err instanceof Error) {
    if (err.cause instanceof Error && err.cause.message) return err.cause.message;
    return err.message;
  }
  return String(err);
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
    throw new Error(`can't reach ${reach}. Check your connection (${causeText(err)})`, {
      cause: err,
    });
  }
}
