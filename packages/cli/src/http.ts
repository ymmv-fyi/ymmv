import { sanitizeValue } from "./render.js";

// The one place a network-level fetch failure becomes words. Every fetch that surfaces its own
// network error goes through safeFetch so "TypeError: fetch failed" (or a TLS/proxy/DNS throw)
// never reaches the user raw. One sanctioned exception stays bare: pollForToken's poll fetch
// (thrown fetches feed the transient-failure counter instead of aborting the login) — it carries
// its own REQUEST_TIMEOUT_MS signal so a hung poll still becomes a counted failure.

/** Every CLI request aborts after this long. A dead-but-open connection (hung proxy, packet loss
 *  after the SYN) must become words, not hang a command forever. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The one line every timeout prints, on every surface — a single constant so the copy can't
 *  drift between causeText and displayError. */
const TIMEOUT_TEXT = "request timed out";

/** Is this rejection the AbortSignal.timeout reason? fetch rejects with the DOMException bare;
 *  some undici lines wrap a body-read abort in a TypeError carrying it under `cause` — treat
 *  both shapes as the same timeout. */
export function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" ||
      (err.cause instanceof Error && err.cause.name === "TimeoutError"))
  );
}

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
  // fetch rejects with the AbortSignal.timeout reason — a DOMException named TimeoutError whose
  // stock message ("The operation was aborted due to timeout") is wordier than it is useful.
  if (isTimeoutError(err)) return TIMEOUT_TEXT;
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

// Zero-width/invisible format chars sanitizeValue deliberately leaves alone (they can decorate
// real text) but which must not count as "a message" on their own — String.trim() misses them.
// Any hand-rolled list misses members (U+061C, variation selectors), so use the engine's
// complete Unicode set. Emptiness-test only; the returned message keeps its original chars.
const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/gu;

/** Read an error response's body as text. The ONE home of the read contract: a body-read timeout
 *  is rethrown (a stalled body is a network timeout, not a malformed message, and must not be
 *  mislabeled with a caller's fallback copy); any other read failure degrades to "" so the error
 *  path never itself throws. Consumes the body — a drained Response must never be re-read, so
 *  pass this text to `wireErrorBody`, never the Response back to `serverMessage`. */
export async function wireBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    if (isTimeoutError(err)) throw err;
    return "";
  }
}

/** Parse an already-read error body into the wire error envelope: `slug` (the machine `error`
 *  code — compared by callers, printed only through wireText) and `message` (the server's human
 *  copy — wireText'd, or undefined when the body is non-JSON (e.g. the edge WAF block page), has
 *  no message, or carries one that sanitizes to nothing visible: pure ANSI/whitespace/zero-width
 *  would otherwise defeat every caller's `?? fallback` and print a blank error line). */
export function wireErrorBody(raw: string): { slug?: string; message?: string } {
  try {
    const body = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const out: { slug?: string; message?: string } = {};
    if (typeof body?.error === "string") out.slug = body.error;
    if (typeof body?.message === "string") {
      const clean = wireText(body.message).trim();
      if (clean.replace(INVISIBLE_RE, "").trim()) out.message = clean;
    }
    return out;
  } catch {
    // non-JSON body — the caller's fallback stands
    return {};
  }
}

/** The server's JSON `{message}` — see wireErrorBody for the visibility rules and wireBody for
 *  the body-read contract (timeouts rethrow). Callers keep their own fallback copy, so the error
 *  path never depends on a well-formed body. Consumes the body. */
export async function serverMessage(res: Response): Promise<string | undefined> {
  return wireErrorBody(await wireBody(res)).message;
}

/** Append "(retry in Ns)" from the retry-after header. Only the delta-seconds form fits — RFC 9110
 *  also allows an HTTP-date (WAF/proxy senders use it), which would garble. The header comes off
 *  the wire, so the digits-only test doubles as its sanitizer. */
export function withRetryHint(msg: string, res: Response): string {
  const retry = res.headers.get("retry-after");
  return retry && /^\d+$/.test(retry) ? `${msg} (retry in ${retry}s)` : msg;
}

/** Top-level error → printable text (the bin's last-resort catch). A TimeoutError can surface from
 *  a BODY read (res.json()) OUTSIDE safeFetch's catch — the signal aborts the whole request, but
 *  only the initial fetch rejection passes through causeText — so map it here too and every
 *  timeout prints the same line. BARE name only, deliberately not isTimeoutError: safeFetch's own
 *  wrapper nests the TimeoutError under `cause`, and flattening it would discard the composed
 *  "Can't reach <host>" context the user needs. Everything else is sanitized per line: a V8
 *  JSON.parse SyntaxError embeds a raw source snippet, so wire bytes can reach this path around
 *  every wireText surface (sanitizeValue strips newlines, hence the split). */
export function displayError(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return TIMEOUT_TEXT;
  const text = err instanceof Error ? err.message : String(err);
  return text
    .split(/\r?\n/)
    .map((line) => sanitizeValue(line))
    .join("\n");
}

/** Thrown by safeFetch when the request never produced an HTTP response (connectivity), as
 *  opposed to a server-reached failure. The type is the discriminator — callers that word their
 *  copy differently for "couldn't reach" vs "the server answered badly" (logout) branch on
 *  `instanceof NetworkError || isTimeoutError`, never on message text. The message stays the
 *  exact "Can't reach …" line and `cause` is preserved: displayError's timeout nesting and
 *  every existing string match depend on both. */
export class NetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NetworkError";
  }
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
    // Default timeout so a dead-but-open connection fails with words instead of hanging. An
    // explicit caller signal wins (none exist today); Node >=22 unrefs the timer, so the signal
    // never holds the process open.
    return await fetchFn(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new NetworkError(`Can't reach ${reach}. Check your connection (${causeText(err)})`, {
      cause: err,
    });
  }
}
