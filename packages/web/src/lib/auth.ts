// Token auth for the unified Worker. Authed writes VERIFY tokens (hash the presented bearer,
// look it up, reject if revoked → github_id); the auth/token endpoint MINTS them (device flow) using
// the same `hashToken`. Raw tokens are never stored — only their SHA-256. The API is the trust
// boundary: every authed write resolves identity through here.

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
 * Resolve the authenticated github_id for a request, or null if the bearer is missing, unknown,
 * or revoked. A single null result (→ 401) covers all three: the CLI re-logs-in on a 401.
 */
export async function authenticateRequest(
  request: Request,
  db: D1Database,
): Promise<number | null> {
  const raw = parseBearer(request);
  if (!raw) return null;
  const hash = await hashToken(raw);
  const row = await db
    .prepare("SELECT github_id FROM tokens WHERE hash = ? AND revoked_at IS NULL")
    .bind(hash)
    .first<{ github_id: number }>();
  return row?.github_id ?? null;
}

/**
 * Mint a fresh opaque ymmv token for a github_id, storing only its SHA-256 (the raw is returned once
 * to the CLI and never persisted server-side). The `ymmv_` prefix aids secret scanning. Re-login
 * mints another active token (multi-device); revocation is per-token via `revokeToken`.
 */
export async function mintToken(db: D1Database, githubId: number): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const raw = `ymmv_${b64}`;
  await db
    .prepare("INSERT INTO tokens (hash, github_id, created_at, revoked_at) VALUES (?, ?, ?, NULL)")
    .bind(await hashToken(raw), githubId, new Date().toISOString())
    .run();
  return raw;
}

/** Revoke a token by its raw value. Idempotent: false when already revoked or unknown. */
export async function revokeToken(db: D1Database, raw: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), await hashToken(raw))
    .run();
  return (res.meta.changes ?? 0) > 0;
}
