import { env } from "cloudflare:workers";

// The Workers rate-limit binding half of "Cloudflare built-in rate limiting". RL_WRITE
// (wrangler.jsonc) caps writes per github_id; the WAF rule (zone config, infra/waf-ratelimit.sh)
// caps raw IP volume at the edge before the Worker runs. Division of labor: WAF stops unauthenticated
// floods (no identity to key on yet); this binding backstops an authenticated identity hammering the
// write path. We key on github_id, not the raw token, so minting many tokens for one account can't
// dodge the cap (a token is just one session of an identity).
//
// NOTE: Cloudflare rate-limit bindings count per data-center (colo), so the effective ceiling is
// ~limit×(#colos)/period for a globally-distributed caller — a backstop against runaway/abusive
// writes, not a precise global quota. The WAF rule (per IP) is the volumetric shield.

/** The rate-limit key for an identity's writes. Exported so the handler and tests can't drift. */
export function writeRateLimitKey(githubId: number): string {
  return `w:${githubId}`;
}

// Retry-After hint (seconds) — matches the binding's `period`. Advisory; the limiter is the gate.
const WRITE_RETRY_AFTER = 60;

/**
 * Enforce the per-identity write rate limit. Returns a 429 Response to return as-is when the caller
 * is over the limit, or null to proceed. Fail-open if RL_WRITE is unbound (e.g. a stripped-down dev
 * build) so local work never 429s spuriously — production always binds it.
 */
export async function checkWriteRateLimit(githubId: number): Promise<Response | null> {
  const limiter = (env as { RL_WRITE?: RateLimit }).RL_WRITE;
  if (!limiter) return null;

  const { success } = await limiter.limit({ key: writeRateLimitKey(githubId) });
  if (success) return null;

  return new Response(
    JSON.stringify({
      error: "rate_limited",
      message: "Too many writes — slow down and try again shortly.",
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(WRITE_RETRY_AFTER),
        "cache-control": "no-store",
      },
    },
  );
}
