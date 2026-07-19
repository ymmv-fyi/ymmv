import { env } from "cloudflare:workers";
import {
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
import { checkWriteRateLimit } from "../../../lib/rate-limit.ts";

// Input caps live in @ymmv/shared (`caps.ts`) so the CLI pre-flights the same numbers this handler
// enforces. Rationale unchanged: curated entries are naturally ≤ CURATED_KEYS.length (13) after
// dedup (plus any newer-taxonomy keys a skewed client carries through verbatim), but bound the
// pre-dedup count, the free-form extras, and any value length so one write can't bloat D1 or every
// future read of the profile.

// Code points that occupy no visual space: zero-width space/joiners, bidi marks and embedding
// controls, variation selectors, the Arabic letter mark, and the rest of Unicode's
// Default_Ignorable_Code_Point set — the engine-maintained property, where a hand-rolled class
// drifts (an earlier one missed U+061C). `.trim()` does NOT remove these (it strips the Zs
// whitespace set plus U+FEFF), so a field of only U+200B passes an emptiness check, stores, and
// renders as a blank row. Reject a field only when NOTHING visible survives — an invisible char
// decorating real text is the user's data and is stored verbatim.
const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/gu;

function hasVisibleContent(s: string): boolean {
  return s.replace(INVISIBLE_RE, "").trim() !== "";
}

function err(status: number, error: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
  for (const x of rawExtras) {
    const rawLabel = (x as { label?: unknown })?.label;
    const rawValue = (x as { value?: unknown })?.value;
    if (typeof rawLabel !== "string" || typeof rawValue !== "string") {
      return err(422, "invalid_extra", { message: "Extras need a text label and value." });
    }
    const label = rawLabel.trim();
    const value = rawValue.trim();
    if (!hasVisibleContent(label) || !hasVisibleContent(value)) {
      return err(422, "invalid_extra", { message: "Extras need a visible label and value." });
    }
    if (label.length > MAX_LABEL || value.length > MAX_VALUE) {
      return err(422, "extra_too_long", {
        message: `Extra labels are capped at ${MAX_LABEL} characters and values at ${MAX_VALUE}.`,
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
    // and EVERY statement re-checks the bind (WHERE handle_lower = ?) inside the transaction. That
    // closes the guard-to-batch TOCTOU as a CAS: if a concurrent login rebound this account (GitHub
    // rename on another device) or a concurrent DELETE vacated it (handle_lower NULL), the whole
    // batch no-ops — a stale publish can neither undo a GitHub-proven rename nor resurrect a
    // deleted profile. Delete-then-insert entries so a republish drops keys.
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET extras = ?, updated_at = ? WHERE github_id = ? AND handle_lower = ?",
      ).bind(extrasJson, now, githubId, handleLower),
      env.DB.prepare(
        "DELETE FROM profile_entries WHERE github_id = ? " +
          "AND EXISTS (SELECT 1 FROM users WHERE github_id = ? AND handle_lower = ?)",
      ).bind(githubId, githubId, handleLower),
      ...[...entryMap].map(([key, value]) =>
        env.DB.prepare(
          "INSERT INTO profile_entries (github_id, key, value) " +
            "SELECT ?, ?, ? FROM users WHERE github_id = ? AND handle_lower = ?",
        ).bind(githubId, key, value, githubId, handleLower),
      ),
    ]);
    // The stamp UPDATE matching zero rows means the bind changed mid-flight (and the shared WHERE
    // made every other statement no-op with it) — same verdict as the guard, one race later.
    if ((results[0]?.meta.changes ?? 0) === 0) {
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
  return new Response(JSON.stringify({ ok: true, handle: boundHandle }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
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

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};
