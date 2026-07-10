import {
  CURATED_KEYS,
  type Entry,
  type Extra,
  isReserved,
  type Profile,
  SCHEMA_VERSION,
} from "@ymmv/shared";

// Shared read path — the single source of truth for the lookup precedence, consumed by BOTH the
// public JSON endpoint (`GET /api/v1/u/<handle>`) and the SSR `/[handle]` page, so the HTML and the
// JSON can never disagree on what a handle resolves to. It does NOT catch D1 errors: a throw bubbles
// to the caller, which surfaces a 500 (error honesty) rather than masking a fault as a 404.

type LiveRow = { github_id: number; handle: string; extras: string; updated_at: string };

/** Discriminated outcome of resolving a handle. `handle` on `renamed` is the owner's CURRENT handle. */
export type ProfileRead =
  | { kind: "live"; profile: Profile }
  | { kind: "renamed"; handle: string }
  | { kind: "notfound" };

// Stored extras are written as valid JSON, but parse defensively so one bad row can't 500 a read —
// including element shape: a non-string label/value would throw later in render (.replace on a number).
// Exported for unit tests only.
export function parseExtras(json: string): Extra[] {
  try {
    const parsed = JSON.parse(json ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is Extra =>
        x !== null &&
        typeof x === "object" &&
        typeof x.label === "string" &&
        typeof x.value === "string",
    );
  } catch {
    return [];
  }
}

// Return entries in canonical CURATED_KEYS order; non-curated rows (shouldn't exist) are dropped.
function orderEntries(rows: { key: string; value: string }[]): Entry[] {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return CURATED_KEYS.flatMap((key) => {
    const value = byKey.get(key);
    return value === undefined ? [] : [{ key, value }];
  });
}

/**
 * Resolve a handle to its profile, a rename target, or nothing — precedence:
 *   live published owner  → { live }       (200)
 *   renamed away          → { renamed }     (caller emits 301 to the current handle)
 *   reclaimed / unknown / reserved / unpublished / 301-target-gone → { notfound } (404)
 * A reserved root segment (see `RESERVED_ROUTES`) never resolves to a profile.
 */
export async function resolveProfile(
  db: D1Database,
  handleParam: string | undefined,
): Promise<ProfileRead> {
  const handleLower = String(handleParam ?? "").toLowerCase();
  if (!handleLower || isReserved(handleLower)) {
    return { kind: "notfound" };
  }

  // LIVE owner first — a published row whose handle is currently this one wins over any history.
  const live = await db
    .prepare(
      "SELECT github_id, handle, extras, updated_at FROM users WHERE handle_lower = ? AND updated_at IS NOT NULL",
    )
    .bind(handleLower)
    .first<LiveRow>();

  if (live) {
    const { results } = await db
      .prepare("SELECT key, value FROM profile_entries WHERE github_id = ?")
      .bind(live.github_id)
      .all<{ key: string; value: string }>();
    return {
      kind: "live",
      profile: {
        schema_version: SCHEMA_VERSION,
        handle: live.handle,
        entries: orderEntries(results),
        extras: parseExtras(live.extras),
        updated_at: live.updated_at,
      },
    };
  }

  // Not live → was it renamed away? Resolve history to the owner's CURRENT, published handle.
  const hist = await db
    .prepare("SELECT github_id FROM handle_history WHERE old_handle_lower = ?")
    .bind(handleLower)
    .first<{ github_id: number }>();

  if (hist) {
    const owner = await db
      .prepare("SELECT handle, handle_lower, updated_at FROM users WHERE github_id = ?")
      .bind(hist.github_id)
      .first<{ handle: string | null; handle_lower: string | null; updated_at: string | null }>();
    // Redirect only to a published owner whose current handle differs; else the target is gone (404).
    if (owner?.handle && owner.updated_at && owner.handle_lower !== handleLower) {
      return { kind: "renamed", handle: owner.handle };
    }
  }

  return { kind: "notfound" };
}

/**
 * Edge cache policy: `s-maxage` + `stale-while-revalidate`, NO purge-on-publish. `max-age=0`
 * keeps browsers always-revalidating (a user sees their own republish immediately) while the shared
 * edge holds a short copy that shields D1 on viral reads. Found/renamed get a longer stale window;
 * not-found stays short so a freshly published handle appears within ~10s. Applied to the HTML page
 * AND the JSON read. Making it effective at the edge (Cache-Everything / Cache API) is a
 * deploy concern; this sets the contract.
 */
export function readCacheControl(kind: ProfileRead["kind"]): string {
  return kind === "notfound"
    ? "public, max-age=0, s-maxage=10, stale-while-revalidate=60"
    : "public, max-age=0, s-maxage=30, stale-while-revalidate=86400";
}
