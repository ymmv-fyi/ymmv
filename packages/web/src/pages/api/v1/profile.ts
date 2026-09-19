import { env } from "cloudflare:workers";
import {
  hasVisibleContent,
  isCuratedKey,
  isReserved,
  isValidHandle,
  MAX_ENTRIES,
  MAX_EXTRAS,
  MAX_LABEL,
  MAX_VALUE,
  type Profile,
  SCHEMA_VERSION,
} from "@ymmv/shared";
import type { APIRoute } from "astro";
import { authenticateRequest } from "../../../lib/auth.ts";
import { noStoreJson } from "../../../lib/json.ts";
import { profileEtag, readOwnProfile } from "../../../lib/profile-read.ts";
import { checkWriteRateLimit } from "../../../lib/rate-limit.ts";

// Input caps live in @ymmv/shared (`caps.ts`) so the CLI pre-flights the same numbers this handler
// enforces. Rationale unchanged: curated entries are naturally ≤ CURATED_KEYS.length (13) after
// dedup (plus any newer-taxonomy keys a skewed client carries through verbatim), but bound the
// pre-dedup count, the free-form extras, and any value length so one write can't bloat D1 or every
// future read of the profile. The visibility rule (`hasVisibleContent`, `visible.ts`) is shared
// the same way: a field of only zero-width/format code points survives `.trim()`, so both the
// server's 422 and the CLI's pre-flight test for visible content.

// Every reply here is bearer-authed, so every one is no-store (errors included).
function err(status: number, error: string, extra?: Record<string, unknown>): Response {
  return noStoreJson(status, { error, ...extra });
}

/** The entity-tag an `If-Match` carries, unquoted — or null when the header is absent or empty
 *  (an unconditional write, which every CLI before the precondition sends). Accepts `"<tag>"`,
 *  bare `<tag>`, and a weak `W/"<tag>"`: the tag IS the server's own stamp, so weak comparison
 *  loses nothing, and an edge that compresses a reply may weaken the validator it forwards (RFC
 *  9110 would refuse it; that would turn every conditional write into a 412). Anything else
 *  (`*`, a list) is compared verbatim and so never matches: a malformed precondition fails closed
 *  as a 412 rather than opening the write. */
function ifMatchTag(request: Request): string | null {
  const raw = request.headers.get("if-match")?.trim() ?? "";
  if (raw === "") return null;
  const strong = raw.startsWith("W/") ? raw.slice(2) : raw;
  const quoted = /^"(.*)"$/.exec(strong);
  return quoted ? quoted[1] : strong;
}

// GET /api/v1/profile — the caller's OWN live profile, bearer-authed and no-store: the uncached
// read the CLI's read-modify-write commands (publish/set/unset) build their merge on. The public
// GET /api/v1/u/<handle> declares an edge-cache policy and may one day be served stale; a merge
// built on a stale read would silently drop writes made moments earlier, so this read never is.
// Carries the same ETag as the public read; the CLI sends the same stamp back as If-Match below.
// 404 {error:"not_found"} when the account binds no handle or has not published — the CLI treats
// exactly that envelope as "no profile yet" (an older Worker's HTML 404 must NOT read as one).
// The read is keyed on the authenticated github_id, never on the handle the token maps to, so a
// rename or reclaim racing this request can't hand the caller someone else's profile. No CORS
// (bearer endpoint) and no RL binding: same class as GET /api/v1/auth/whoami, covered by the zone
// WAF rule (infra/waf-ratelimit.sh names both GETs).
export const GET: APIRoute = async ({ request }) => {
  try {
    const githubId = await authenticateRequest(request, env.DB);
    if (githubId === null) return noStoreJson(401, { error: "unauthorized" });
    const profile = await readOwnProfile(env.DB, githubId);
    if (!profile) return noStoreJson(404, { error: "not_found" });
    return noStoreJson(200, profile, { etag: profileEtag(profile) });
  } catch (e) {
    console.error("own-profile read failed", e);
    return noStoreJson(500, {
      error: "internal_error",
      message: "The server hit an error reading your profile. Try again shortly.",
    });
  }
};

// POST /api/v1/profile — authed upsert of one user's profile.
//
// SECURITY: a token only proves github_id, so publish never BINDS a handle — it only writes under
// the handle this account already bound at `login` (POST /api/v1/auth/token), where GitHub's /user
// proves current ownership of the name. That single rule (the bound-handle guard below) blocks
// squatting an unclaimed handle before its GitHub owner ever logs in, taking over a handle another
// account holds live or vacated, and renaming via publish (renames flow through a re-login).
export const POST: APIRoute = async ({ request }) => {
  const githubId = await authenticateRequest(request, env.DB);
  if (githubId === null) return err(401, "unauthorized");

  // Per-identity write rate limit (after auth so we can key on github_id, before any D1 work).
  const limited = await checkWriteRateLimit(githubId);
  if (limited) return limited;

  // Optional precondition: the ETag the caller read (see GET above). Null = unconditional.
  const expectedTag = ifMatchTag(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err(400, "bad_json");
  }
  const payload = (body ?? {}) as Partial<Profile>;

  // Old CLIs: reject a mismatched payload version with clear upgrade copy, never corrupt.
  if (payload.schema_version !== SCHEMA_VERSION) {
    return err(400, "unsupported_schema_version", {
      expected: SCHEMA_VERSION,
      got: payload.schema_version ?? null,
      message: "Upgrade the ymmv CLI (npm i -g ymmv-cli).",
    });
  }

  const handle = String(payload.handle ?? "").trim();
  const handleLower = handle.toLowerCase();
  if (!isValidHandle(handle) || isReserved(handleLower)) {
    // No retry advice on purpose: for the one real human who hits this (a GitHub handle that IS a
    // reserved word), no re-login can ever succeed — state the fact instead of prescribing a loop.
    return err(422, "invalid_handle", {
      message: "That handle can't be published (invalid or reserved).",
    });
  }

  // entries: curated key + a value with visible content within caps; dedupe by key (last-wins).
  // Trim BEFORE the emptiness/length checks and store trimmed, exactly like extras below: padding
  // is not content, so a padded value must neither pass the empty check, consume the length
  // budget, nor render padded. `hasVisibleContent` extends that to wholly-invisible values.
  if (payload.entries !== undefined && !Array.isArray(payload.entries)) {
    return err(422, "invalid_entries", { message: "Entries must be an array." });
  }
  const rawEntries = (Array.isArray(payload.entries) ? payload.entries : []) as unknown[];
  if (rawEntries.length > MAX_ENTRIES) {
    return err(422, "too_many_entries", {
      max: MAX_ENTRIES,
      message: `A profile holds at most ${MAX_ENTRIES} entries.`,
    });
  }
  const entryMap = new Map<string, string>();
  for (const e of rawEntries) {
    const key = (e as { key?: unknown })?.key;
    const rawValue = (e as { value?: unknown })?.value;
    if (typeof key !== "string" || !isCuratedKey(key)) {
      return err(422, "invalid_key", {
        key: typeof key === "string" ? key : null,
        message: "Not a curated key. Run `ymmv help` to list them.",
      });
    }
    if (typeof rawValue !== "string") {
      return err(422, "invalid_value", { key, message: "Entry values must be text." });
    }
    const value = rawValue.trim();
    if (!hasVisibleContent(value)) {
      return err(422, "invalid_value", { key, message: "Entry values need visible text." });
    }
    if (value.length > MAX_VALUE) {
      return err(422, "value_too_long", {
        key,
        message: `Values are capped at ${MAX_VALUE} characters.`,
      });
    }
    entryMap.set(key, value);
  }

  // extras: {label, value} string pairs with visible content, within caps; bounded count. Trim
  // BEFORE the emptiness and length checks, then store trimmed: padding is not content, so a padded
  // label must neither pass the empty check, consume the length budget, nor render padded on the
  // page. `hasVisibleContent` extends that to characters that render as nothing at all.
  // Mirrors the entries rule above (and the CLI, which requires both non-empty).
  if (payload.extras !== undefined && !Array.isArray(payload.extras)) {
    return err(422, "invalid_extras", { message: "Extras must be an array." });
  }
  const rawExtras = (Array.isArray(payload.extras) ? payload.extras : []) as unknown[];
  if (rawExtras.length > MAX_EXTRAS) {
    return err(422, "too_many_extras", {
      max: MAX_EXTRAS,
      message: `A profile holds at most ${MAX_EXTRAS} extras.`,
    });
  }
  const extras: { label: string; value: string }[] = [];
  for (const [i, x] of rawExtras.entries()) {
    const rawLabel = (x as { label?: unknown })?.label;
    const rawValue = (x as { value?: unknown })?.value;
    if (typeof rawLabel !== "string" || typeof rawValue !== "string") {
      return err(422, "invalid_extra", { message: "Extras need a text label and value." });
    }
    const label = rawLabel.trim();
    const value = rawValue.trim();
    if (!hasVisibleContent(label) || !hasVisibleContent(value)) {
      // Name the row: an invisible label cannot be quoted back, and the CLI prints only the
      // message, so the ordinal is what lets the user find the extra to remove.
      return err(422, "invalid_extra", {
        message: `Extra ${i + 1} needs a visible label and value.`,
      });
    }
    if (label.length > MAX_LABEL || value.length > MAX_VALUE) {
      return err(422, "extra_too_long", {
        message: `Extra ${i + 1} is over the cap: labels at most ${MAX_LABEL} characters, values ${MAX_VALUE}.`,
      });
    }
    extras.push({ label, value });
  }

  const now = new Date().toISOString();
  const extrasJson = JSON.stringify(extras);

  let boundHandle: string;
  try {
    // Bound-handle guard: publish may only use the handle login already bound to this github_id.
    // Anything else — an unclaimed handle (pre-owner squat), a handle another account holds live or
    // vacated (takeover), a self-rename, or a limbo account (handle_lower NULL) — is refused; the
    // caller must (re-)login, where GitHub proves name ownership. 409 keeps every deployed CLI's
    // self-heal working: on 409 it re-logins (refreshing the bound handle) and retries once.
    const bound = await env.DB.prepare("SELECT handle, handle_lower FROM users WHERE github_id = ?")
      .bind(githubId)
      .first<{ handle: string | null; handle_lower: string | null }>();
    if (bound?.handle_lower !== handleLower || bound.handle === null) {
      return err(409, "handle_not_bound", {
        message: "Publish uses the handle bound at login. Run `ymmv login` and retry.",
      });
    }
    boundHandle = bound.handle;

    // One atomic batch — D1 has no interactive transactions. Publish never writes handle or
    // handle_lower: it stamps the row published (updated_at + extras) and rewrites the entries,
    // and EVERY write statement re-checks the bind (handle_lower = ?) inside the transaction. That
    // closes the guard-to-batch TOCTOU as a CAS: if a concurrent login rebound this account (GitHub
    // rename on another device) or a concurrent DELETE vacated it (handle_lower NULL), the whole
    // batch no-ops — a stale publish can neither undo a GitHub-proven rename nor resurrect a
    // deleted profile. Delete-then-insert entries so a republish drops keys.
    //
    // The same gate carries the If-Match precondition: `(? IS NULL OR updated_at = ?)` is inert
    // without a tag (every statement is byte-identical to the unconditional write) and otherwise
    // requires the stored stamp to still equal the one the caller read, so a merge built on a
    // stale read no-ops instead of clobbering the write that landed in between. The stamp UPDATE
    // runs LAST because it rewrites the very column the entry statements gate on. A NULL stamp
    // (never published, or vacated since the read) never equals a tag, which is the right verdict:
    // what the caller read is gone. Known gap: two publishes stamped in the same millisecond share
    // a tag, so a reader of the first can't see the second (needs two same-account writes in one
    // millisecond under the per-identity write limit; a revision column would close it).
    const gate = "AND handle_lower = ? AND (? IS NULL OR updated_at = ?)";
    const gateBinds = [handleLower, expectedTag, expectedTag] as const;
    const writes = [
      env.DB.prepare(
        `DELETE FROM profile_entries WHERE github_id = ? AND EXISTS (SELECT 1 FROM users WHERE github_id = ? ${gate})`,
      ).bind(githubId, githubId, ...gateBinds),
      ...[...entryMap].map(([key, value]) =>
        env.DB.prepare(
          `INSERT INTO profile_entries (github_id, key, value) SELECT ?, ?, ? FROM users WHERE github_id = ? ${gate}`,
        ).bind(githubId, key, value, githubId, ...gateBinds),
      ),
      env.DB.prepare(
        `UPDATE users SET extras = ?, updated_at = ? WHERE github_id = ? ${gate}`,
      ).bind(extrasJson, now, githubId, ...gateBinds),
    ];
    // Conditional writes only: one more statement reads the bind inside the same transaction, so
    // a zero-change batch is classified from the snapshot that produced it, never a later read.
    const probe =
      expectedTag === null
        ? []
        : [env.DB.prepare("SELECT handle_lower FROM users WHERE github_id = ?").bind(githubId)];
    const results = await env.DB.batch<{ handle_lower: string | null }>([...writes, ...probe]);
    const stampResult = results[writes.length - 1];
    const probeRow = results[writes.length]?.results[0];
    if ((stampResult?.meta.changes ?? 0) === 0) {
      // Nothing written. Bind moved (rename / vacate / limbo) → 409, the verdict deployed CLIs
      // self-heal from by re-logging-in — and it wins over a stamp mismatch, since a re-read under
      // the old handle can't fix a moved bind. Bind intact but the stamp moved → 412: the caller's
      // read is stale, and only a caller that sent a tag (and so has a probe row) can land here.
      if (probeRow?.handle_lower === handleLower) {
        return err(412, "precondition_failed", {
          message: "Your profile changed since this command read it. Re-run the command.",
        });
      }
      return err(409, "handle_not_bound", {
        message: "Publish uses the handle bound at login. Run `ymmv login` and retry.",
      });
    }
  } catch (e) {
    console.error("profile upsert failed for", handleLower, e);
    return err(500, "internal_error", {
      message: "The server hit an error saving your profile. Try again shortly.",
    });
  }

  // Echo the STORED handle, not the payload: display casing is login-proven (GitHub's exact login
  // casing) and a publish must not be able to drift it via a case-variant payload.
  return noStoreJson(200, { ok: true, handle: boundHandle });
};

// DELETE /api/v1/profile — authed hard-delete (v1 delete semantics). One atomic batch:
//   • record the current handle in handle_history BEFORE clearing it (the SELECT reads the live
//     value in-transaction). Nobody can publish-squat the vacated handle: POST's bound-handle guard
//     refuses any handle not currently login-bound, so reclaim (the owner's included — delete also
//     clears their bind) flows ONLY through a GitHub-proven login, never an arbitrary publish (no
//     impersonation of the GitHub owner after they delete).
//   • drop the user's profile_entries,
//   • clear handle/handle_lower (→ reclaimable) + extras, and NULL updated_at so the row reads as
//     "no profile" (GET 404s); the users row is kept so a later login re-binds the same github_id,
//   • revoke ALL of this account's tokens (the spec's "delete revokes tokens" — kills every session;
//     the CLI then drops its now-dead local token).
export const DELETE: APIRoute = async ({ request }) => {
  const githubId = await authenticateRequest(request, env.DB);
  if (githubId === null) return err(401, "unauthorized");

  // Delete is a write too; share the per-identity write limit (same key as POST).
  const limited = await checkWriteRateLimit(githubId);
  if (limited) return limited;

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR REPLACE INTO handle_history (old_handle_lower, github_id, changed_at) " +
          "SELECT handle_lower, github_id, ? FROM users WHERE github_id = ? AND handle_lower IS NOT NULL",
      ).bind(now, githubId),
      env.DB.prepare("DELETE FROM profile_entries WHERE github_id = ?").bind(githubId),
      env.DB.prepare(
        "UPDATE users SET handle = NULL, handle_lower = NULL, extras = '[]', updated_at = NULL WHERE github_id = ?",
      ).bind(githubId),
      env.DB.prepare(
        "UPDATE tokens SET revoked_at = ? WHERE github_id = ? AND revoked_at IS NULL",
      ).bind(now, githubId),
    ]);
  } catch (e) {
    console.error("profile delete failed for github_id", githubId, e);
    return err(500, "internal_error", {
      message: "The server hit an error deleting your profile. Try again shortly.",
    });
  }

  return noStoreJson(200, { ok: true });
};
