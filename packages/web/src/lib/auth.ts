// Token auth for the unified Worker. Authed writes VERIFY tokens (hash the presented bearer,
// look it up, reject if revoked → github_id); the auth/token endpoint MINTS them (device flow) using
// the same `hashToken`. Raw tokens are never stored — only their SHA-256. The API is the trust
// boundary: every authed write resolves identity through here.

import type { WhoamiResult } from "@ymmv/shared";

/** SHA-256 hex of a raw token. Web Crypto — available in workerd and Node 22 (tests seed rows). */
export async function hashToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Extract the bearer token from an Authorization header, or null when absent/empty. */
export function parseBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve the identity a request's bearer is bound to, or null if the bearer is missing, unknown,
 * or revoked. This query is the ONE definition of a valid token: `authenticateRequest` below is
 * its projection, so whoami and the authed writes can never disagree about which tokens are live.
 * LEFT JOIN on purpose: an account with no bound handle (reserved username, or a handle another
 * account has since proven) still authenticates — `handle` is just null.
 */
export async function authenticateIdentity(
  request: Request,
  db: D1Database,
): Promise<WhoamiResult | null> {
  const raw = parseBearer(request);
  if (!raw) return null;
  const hash = await hashToken(raw);
  const row = await db
    .prepare(
      "SELECT t.github_id, u.handle FROM tokens t LEFT JOIN users u ON u.github_id = t.github_id " +
        "WHERE t.hash = ? AND t.revoked_at IS NULL",
    )
    .bind(hash)
    .first<{ github_id: number; handle: string | null }>();
  return row ? { github_id: row.github_id, handle: row.handle ?? null } : null;
}

/**
 * Resolve the authenticated github_id for a request, or null if the bearer is missing, unknown,
 * or revoked. A single null result (→ 401) covers all three: the CLI re-logs-in on a 401.
 */
export async function authenticateRequest(
  request: Request,
  db: D1Database,
): Promise<number | null> {
  return (await authenticateIdentity(request, db))?.github_id ?? null;
}

/** The one revoke statement: `changes` is 1 when the row was live, 0 when unknown or already revoked. */
function revokeStatement(db: D1Database, hash: string, now: string): D1PreparedStatement {
  return db
    .prepare("UPDATE tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL")
    .bind(now, hash);
}

/**
 * Mint a fresh opaque ymmv token for a github_id, storing only its SHA-256 (the raw is returned once
 * to the CLI and never persisted server-side). The `ymmv_` prefix aids secret scanning. Re-login
 * mints another active token (multi-device); revocation is per-token via `revokeToken`.
 *
 * With `revokeRaw` (the stored token the CLI's login replaces), the revoke rides in
 * the SAME batch as the insert: D1 batches are transactional, so the old token dies in the step
 * that births the new one and no client-side ordering can strand it live. Unscoped by github_id
 * on purpose, exactly like `revokeToken`: holding the raw token IS the credential, and the file
 * may hold a token for a different account than the one now logging in. `revoked` is undefined
 * when nothing was asked, else whether that token was live.
 */
export async function mintToken(
  db: D1Database,
  githubId: number,
  revokeRaw?: string,
): Promise<{ token: string; revoked?: boolean }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const raw = `ymmv_${b64}`;
  const now = new Date().toISOString();
  const stmts = [
    db
      .prepare(
        "INSERT INTO tokens (hash, github_id, created_at, revoked_at) VALUES (?, ?, ?, NULL)",
      )
      .bind(await hashToken(raw), githubId, now),
  ];
  if (revokeRaw !== undefined) stmts.push(revokeStatement(db, await hashToken(revokeRaw), now));
  const results = await db.batch(stmts);
  if (revokeRaw === undefined) return { token: raw };
  return { token: raw, revoked: (results[1]?.meta.changes ?? 0) > 0 };
}

/** Revoke a token by its raw value. Idempotent: false when already revoked or unknown. */
export async function revokeToken(db: D1Database, raw: string): Promise<boolean> {
  const res = await revokeStatement(db, await hashToken(raw), new Date().toISOString()).run();
  return (res.meta.changes ?? 0) > 0;
}
