import { env } from "cloudflare:workers";
import {
  isCuratedKey,
  isReserved,
  isValidHandle,
  type Profile,
  SCHEMA_VERSION,
} from "@ymmv/shared";
import type { APIRoute } from "astro";
import { authenticateRequest } from "../../../lib/auth.ts";
import { checkWriteRateLimit } from "../../../lib/rate-limit.ts";
import { handleBindStatements, isUniqueViolation } from "../../../lib/users.ts";

// Conservative input caps — curated entries are naturally ≤ 10 after dedup, but bound the
// pre-dedup count, the free-form extras, and any value length so one write can't bloat D1 or every
// future read of the profile.
const MAX_ENTRIES = 50;
const MAX_EXTRAS = 32;
const MAX_LABEL = 64;
const MAX_VALUE = 256;

function err(status: number, error: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// POST /api/v1/profile — authed upsert of one user's profile.
//
// SECURITY: a token only proves github_id, so publish refuses to
// claim a handle another account holds LIVE *or* vacated (renamed-away → handle_history) — the 409
// guard below + the UNIQUE backstop. Authoritative handle binding/reclaim happens at `login`
// (POST /api/v1/auth/token), where GitHub's /user proves current ownership — the only place a handle
// transfers between accounts.
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
    return err(422, "invalid_handle");
  }

  // entries: curated key + non-empty string value within caps; dedupe by key (last-wins).
  if (payload.entries !== undefined && !Array.isArray(payload.entries)) {
    return err(422, "invalid_entries");
  }
  const rawEntries = (Array.isArray(payload.entries) ? payload.entries : []) as unknown[];
  if (rawEntries.length > MAX_ENTRIES) return err(422, "too_many_entries", { max: MAX_ENTRIES });
  const entryMap = new Map<string, string>();
  for (const e of rawEntries) {
    const key = (e as { key?: unknown })?.key;
    const value = (e as { value?: unknown })?.value;
    if (typeof key !== "string" || !isCuratedKey(key)) {
      return err(422, "invalid_key", { key: typeof key === "string" ? key : null });
    }
    if (typeof value !== "string" || value.trim() === "") return err(422, "invalid_value", { key });
    if (value.length > MAX_VALUE) return err(422, "value_too_long", { key });
    entryMap.set(key, value);
  }

  // extras: {label, value} string pairs within caps; bounded count.
  if (payload.extras !== undefined && !Array.isArray(payload.extras)) {
    return err(422, "invalid_extras");
  }
  const rawExtras = (Array.isArray(payload.extras) ? payload.extras : []) as unknown[];
  if (rawExtras.length > MAX_EXTRAS) return err(422, "too_many_extras", { max: MAX_EXTRAS });
  const extras: { label: string; value: string }[] = [];
  for (const x of rawExtras) {
    const label = (x as { label?: unknown })?.label;
    const value = (x as { value?: unknown })?.value;
    if (typeof label !== "string" || typeof value !== "string") return err(422, "invalid_extra");
    if (label.length > MAX_LABEL || value.length > MAX_VALUE) return err(422, "extra_too_long");
    extras.push({ label, value });
  }

  const now = new Date().toISOString();
  const extrasJson = JSON.stringify(extras);

  try {
    // Takeover guard: a token only proves github_id, so refuse to claim a handle another account
    // holds LIVE *or* vacated (renamed-away → handle_history). Blocking the vacated case stops a
    // crafted publish from hijacking the victim's 301 redirect; legitimate reclaim flows through login
    // (GitHub /user proof). The UNIQUE(handle_lower) catch below backstops the live-case TOCTOU.
    const taken = await env.DB.prepare(
      "SELECT github_id FROM users WHERE handle_lower = ? AND github_id <> ? " +
        "UNION SELECT github_id FROM handle_history WHERE old_handle_lower = ? AND github_id <> ?",
    )
      .bind(handleLower, githubId, handleLower, githubId)
      .first<{ github_id: number }>();
    if (taken) return err(409, "handle_taken");

    // One atomic batch — D1 has no interactive transactions. handleBindStatements does history +
    // claim (stampPublish marks the row published; release:false — publish never transfers a live
    // handle, login does). Then, critically, delete-then-insert entries so a republish drops keys.
    await env.DB.batch([
      ...handleBindStatements(env.DB, githubId, handle, now, {
        stampPublish: true,
        extrasJson,
        release: false,
      }),
      env.DB.prepare("DELETE FROM profile_entries WHERE github_id = ?").bind(githubId),
      ...[...entryMap].map(([key, value]) =>
        env.DB.prepare("INSERT INTO profile_entries (github_id, key, value) VALUES (?, ?, ?)").bind(
          githubId,
          key,
          value,
        ),
      ),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) return err(409, "handle_taken"); // lost a concurrent free-handle race
    console.error("profile upsert failed for", handleLower, e);
    return err(500, "internal_error");
  }

  return new Response(JSON.stringify({ ok: true, handle }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

// DELETE /api/v1/profile — authed hard-delete (v1 delete semantics). One atomic batch:
//   • record the current handle in handle_history BEFORE clearing it (the SELECT reads the live
//     value in-transaction). This keeps the handle from being publish-squatted by another account:
//     the POST takeover guard treats a vacated (history) handle as taken, so reclaim flows ONLY
//     through a GitHub-proven login — never an arbitrary publish (no impersonation of the GitHub
//     owner after they delete). The owner themselves re-claim freely (the guard excludes own id).
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
    return err(500, "internal_error");
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};
