/**
 * Reserved names + handle validation.
 *
 * Identity is the GitHub handle, so claiming is automatic. Two carve-outs:
 *  - every top-level route the web app serves itself is reserved;
 *  - the CLI verb words are reserved so `ymmv <verb>` never collides with a real handle.
 *
 * `isReserved`/`isValidHandle` are the single source of truth the API imports and enforces
 * on write — it is the trust boundary. `RESERVED_ROUTES` must list every static top-level
 * page route, because Astro resolves a static route ahead of the dynamic `[handle]` page:
 * a handle-shaped route left off this list is claimable but its HTML page is unreachable,
 * so the JSON and HTML surfaces disagree forever. `web/test/routes.test.ts` pins that
 * invariant against the real route table.
 */

/** Root path segments the web app reserves (everything else at root is a handle). */
export const RESERVED_ROUTES = ["404", "api", "login", "logout"] as const;

/** CLI verb words — reserved as non-claimable handles so `ymmv <verb>` is unambiguous.
 *  `publish` and `version` are here even though flags/bare `ymmv` cover them: both are
 *  predictable muscle-memory words, and unreserved they'd be squattable profile views.
 *  `update` (the self-upgrade command) rode the same reasoning in: an unreserved `update`
 *  profile would be silently shadowed by the command forever. */
export const CLI_VERBS = [
  "login",
  "logout",
  "set",
  "unset",
  "delete",
  "view",
  "help",
  "publish",
  "version",
  "update",
] as const;

/** Every name that cannot be claimed as a handle (routes ∪ verbs, de-duplicated).
 *  NOTE: the CLI bakes this list into each released binary as a local pre-check (resolve.ts), so
 *  ADDING a name is safe for data (old CLIs just make the round-trip) but REMOVING one is a
 *  breaking change — shipped CLIs would keep refusing it locally without ever asking the server.
 *  Skew caveat when adding: until users upgrade, old binaries round-trip the new name and
 *  misreport `no ymmv profile for "<name>" yet` (the server 404s reserved names) — weigh that
 *  permanent old-binary misreport when reserving a word people type as a command. */
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
