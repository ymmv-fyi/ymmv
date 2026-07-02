/**
 * Reserved names + handle validation.
 *
 * Identity is the GitHub handle, so claiming is automatic. Two carve-outs:
 *  - a small set of root path segments are reserved (only `api`/`login`/`logout`);
 *  - the CLI verb words are reserved so `ymmv <verb>` never collides with a real handle.
 *
 * `isReserved`/`isValidHandle` are the single source of truth both the CLI (pre-check)
 * and the API (enforce on write) import. The API is the real trust boundary — it
 * re-checks server-side; these helpers do not replace that.
 */

/** Root path segments the web app reserves (everything else at root is a handle). */
export const RESERVED_ROUTES = ["api", "login", "logout"] as const;

/** CLI verb words — reserved as non-claimable handles so `ymmv <verb>` is unambiguous. */
export const CLI_VERBS = ["login", "logout", "set", "unset", "delete", "view", "help"] as const;

/** Every name that cannot be claimed as a handle (routes ∪ verbs, de-duplicated). */
export const RESERVED: readonly string[] = [...new Set<string>([...RESERVED_ROUTES, ...CLI_VERBS])];

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED);

/** Is `handle` reserved? Case-insensitive (handles compare on their lowercased form). */
export function isReserved(handle: string): boolean {
  return RESERVED_SET.has(handle.toLowerCase());
}

/**
 * GitHub username rules, mirrored: 1–39 chars, ASCII alphanumeric or single hyphens,
 * no leading or trailing hyphen, no consecutive hyphens. (Identity is the GitHub
 * handle, so we accept exactly what GitHub accepts.)
 *
 * The regex enforces the hyphen rules; the length guard enforces 1–39.
 */
const HANDLE_RE = /^[a-zA-Z0-9](?:-?[a-zA-Z0-9])*$/;

export function isValidHandle(handle: string): boolean {
  return handle.length >= 1 && handle.length <= 39 && HANDLE_RE.test(handle);
}
