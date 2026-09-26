import { isReserved, isValidHandle } from "@ymmv/shared";
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

const DEFAULT_BASE = "https://ymmv.fyi";

// `||`, not `??`: `YMMV_API= ymmv` (the shell way of "clearing" a variable) sets the EMPTY string,
// and empty means unset here — falling back to the default base matches the user's evident intent.
export const BASE = normalizeBase(process.env.YMMV_API || DEFAULT_BASE);

/** A host the production Worker answers on: the apex or www (web's canonicalHosts()). Any scheme
 *  or port; one trailing dot is the same host. Every such origin but DEFAULT_BASE redirects. */
function isYmmvHost(url: URL): boolean {
  const apex = new URL(DEFAULT_BASE).hostname;
  const host = url.hostname.replace(/\.$/, "");
  return host === apex || host === `www.${apex}`;
}

/** Where plain http may go: nowhere a token can cross a network in cleartext. */
function isLoopback(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname)
  );
}

/** The server requests for `base` actually reach: https://ymmv.fyi for any ymmv.fyi address (an
 *  alias only redirects to the same Worker and D1), else `base` itself. Only logout runs under an
 *  alias (it skips the gate), and a token an older CLI stored under one would otherwise be
 *  unrevocable, or revocable only over plain http. Never throws: under logout BASE is ungated,
 *  and every command passes the stored token.json base, untrusted file content (loadToken,
 *  retirable, peekBase). */
export function serverOrigin(base: string = BASE): string {
  try {
    return isYmmvHost(new URL(base)) ? DEFAULT_BASE : base;
  } catch {
    return base;
  }
}

/** Whether a token stored under `base` belongs to the server BASE reaches, so login and logout
 *  can retire it here: a token stored under a ymmv.fyi alias counts as ymmv.fyi's. */
export function isSameServer(base: string): boolean {
  return serverOrigin(base) === serverOrigin();
}

/** Whether `base` is plain http to a host off this machine: a token used there has crossed a
 *  network in cleartext. Never throws, like serverOrigin (token.json content reaches it). */
export function isCleartextBase(base: string): boolean {
  try {
    const url = new URL(base);
    return url.protocol === "http:" && !isLoopback(url);
  } catch {
    return false;
  }
}

/**
 * Why the configured YMMV_API can't be used (a full user-facing message), or null when it's fine
 * (unset, a bare https origin, or plain http on loopback). Called at the top of main() so a config
 * mistake fails fast with its real diagnosis — an unparseable base otherwise surfaces as fetch
 * throwing, which safeFetch mislabels as "Can't reach ... Check your connection". Pure over `raw`
 * for tests; production passes nothing and reads the env at call time.
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
  // The Worker serves no other ymmv.fyi origin: it redirects them (which the CLI never follows
  // with a credential) or, on http, refuses a credential with a 403. Each would fail every login
  // and write.
  if (isYmmvHost(url) && base !== DEFAULT_BASE) {
    return `${shown} which redirects to ${DEFAULT_BASE}. Use ${DEFAULT_BASE}, or unset YMMV_API.`;
  }
  // The same predicate loadToken refuses a stored base by: a base this gate accepts must never
  // store a token that loadToken then reads as logged out.
  if (isCleartextBase(base)) {
    return `${shown} which uses plain http, so a login token sent there would cross the network unencrypted. Use https (plain http works only for localhost).`;
  }
  return null;
}

/**
 * Why the configured YMMV_TOKEN / YMMV_HANDLE pair can't be used (a full user-facing message), or
 * null when it's fine (unset, or well-shaped). Runs beside baseProblem() at the top of main() —
 * same rationale (a config mistake must fail with its real diagnosis, not deep in a fetch), same
 * logout exemption (logout is env-blind: it acts on the file token, so a malformed env token must
 * not strand it). YMMV_HANDLE without a token is inert: nothing reads it, so a stray export must
 * never block file-token use. Unlike YMMV_API, the TOKEN VALUE IS NEVER ECHOED — it's a secret.
 */
export function credentialEnvProblem(
  rawToken: string | undefined = process.env.YMMV_TOKEN,
  rawHandle: string | undefined = process.env.YMMV_HANDLE,
): string | null {
  // Empty means unset (`YMMV_TOKEN= ymmv` clears it), matching YMMV_API.
  if (rawToken === undefined || rawToken === "") return null;
  // Printable ASCII only: whitespace or control characters would corrupt the `Bearer` header into
  // an opaque undici TypeError (or worse, split it), and no server-minted token contains them.
  if (!/^[\x21-\x7E]+$/.test(rawToken)) {
    return "YMMV_TOKEN contains whitespace, control, or non-ASCII characters. Set it to the exact token value.";
  }
  if (rawHandle !== undefined && rawHandle !== "") {
    const shown = `YMMV_HANDLE is set to "${sanitizeValue(rawHandle)}"`;
    if (!isValidHandle(rawHandle)) {
      return `${shown} which is not a valid GitHub username. Set it to the handle bound to YMMV_TOKEN.`;
    }
    if (isReserved(rawHandle)) {
      return `${shown} which is a reserved word, so no handle can be bound to it.`;
    }
  }
  return null;
}
