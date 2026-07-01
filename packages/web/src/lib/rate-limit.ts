import { env } from "cloudflare:workers";

// Cloudflare built-in rate limiting (Workers binding half; the WAF rule is zone config, see
// infra/waf-ratelimit.sh). Two bindings, two keying strategies:
//   • RL_WRITE — per github_id. Gates authed writes (POST/DELETE /api/v1/profile) AND the mint's
//     post-identity D1 writes (POST /api/v1/auth/token). Keyed on the identity, not the token, so
//     minting many tokens for one account can't dodge the cap.
//   • RL_AUTH  — per client IP. Gates the UNAUTHENTICATED mint endpoint BEFORE it makes its outbound
//     GitHub introspection call, so a single-IP junk-token flood can't amplify into unbounded outbound
//     subrequests. No identity exists yet there, so the IP is the only thing to key on.
// The WAF rule (per IP, at the edge) is the real volumetric shield; both bindings are in-code backstops.
//
// NOTE: Cloudflare rate-limit bindings count per data-center (colo), so the effective ceiling is
// ~limit×(#colos)/period for a globally-distributed caller — a backstop against runaway/abusive
// traffic, not a precise global quota.

// Retry-After hint (seconds) — matches each binding's `period`. Advisory; the limiter is the gate.
const RETRY_AFTER = 60;

/** The 429 a rate-limited caller receives. `error:"rate_limited"` is the contract the CLI keys on. */
function rateLimited(message: string): Response {
  return new Response(JSON.stringify({ error: "rate_limited", message }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(RETRY_AFTER),
      "cache-control": "no-store",
    },
  });
}

/** The rate-limit key for an identity's writes. Exported so the handler and tests can't drift. */
export function writeRateLimitKey(githubId: number): string {
  return `w:${githubId}`;
}

/** The rate-limit key for a client IP's hits on the unauthenticated mint endpoint. */
export function authRateLimitKey(ip: string): string {
  return `a:${ip}`;
}

/**
 * Enforce the per-identity write rate limit. Returns a 429 Response to return as-is when the caller
 * is over the limit, or null to proceed. Fail-open if RL_WRITE is unbound (e.g. a stripped-down dev
 * build) so local work never 429s spuriously — production always binds it (release.yml asserts it).
 */
export async function checkWriteRateLimit(githubId: number): Promise<Response | null> {
  const limiter = (env as { RL_WRITE?: RateLimit }).RL_WRITE;
  if (!limiter) return null;

  const { success } = await limiter.limit({ key: writeRateLimitKey(githubId) });
  return success ? null : rateLimited("Too many writes — slow down and try again shortly.");
}

/**
 * Enforce the per-IP cap on the unauthenticated mint endpoint. Returns a 429 to return as-is when over
 * the limit, or null to proceed. Fail-open when RL_AUTH is unbound OR when `ip` is absent (a direct
 * handler call in tests, or a request with no cf-connecting-ip) — production always has both, and
 * release.yml asserts the binding is baked so it can't silently fail open.
 */
export async function checkAuthRateLimit(ip: string | null): Promise<Response | null> {
  const limiter = (env as { RL_AUTH?: RateLimit }).RL_AUTH;
  if (!limiter || !ip) return null;

  const { success } = await limiter.limit({ key: authRateLimitKey(ip) });
  return success ? null : rateLimited("Too many login attempts — slow down and try again shortly.");
}
