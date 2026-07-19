import { env } from "cloudflare:workers";
import { GITHUB_CLIENT_ID, isReserved, isValidHandle } from "@ymmv/shared";
import type { APIRoute } from "astro";
import { mintToken } from "../../../../lib/auth.ts";
import { githubClientSecret, verifyGithubToken } from "../../../../lib/github.ts";
import { checkAuthRateLimit, checkWriteRateLimit } from "../../../../lib/rate-limit.ts";
import { handleBindStatements } from "../../../../lib/users.ts";

// Bearer-token responses must never be cached by any intermediary.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// POST /api/v1/auth/token — device-flow mint. The body carries the GitHub access token the CLI just
// obtained; THAT is the credential (there is no ymmv bearer yet). The Worker verifies via GitHub token
// introspection that the token was issued to ymmv's OWN OAuth app (audience binding — a token minted
// for any other app, or a leaked PAT, is rejected), binds the handle to the github_id authoritatively,
// and mints an opaque ymmv token. Do not log the tokens or the client secret.
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "bad_json" });
  }
  const accessToken = (body as { access_token?: unknown })?.access_token;
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    return json(400, { error: "missing_access_token" });
  }

  // Per-IP cap on this unauthenticated endpoint, BEFORE the outbound introspection call, so a
  // junk-token flood from one IP can't amplify into unbounded GitHub subrequests. No identity yet → IP.
  const ipLimited = await checkAuthRateLimit(request.headers.get("cf-connecting-ip"));
  if (ipLimited) return ipLimited;

  // Fail CLOSED: without the app secret the Worker cannot verify token audience, and must NOT fall back
  // to an unauthenticated identity read. A missing secret is an operator misconfig — set it (in prod +
  // staging) BEFORE deploying this code, or every login 500s.
  const clientSecret = githubClientSecret(env);
  if (!clientSecret) {
    console.error("mint misconfigured: GITHUB_CLIENT_SECRET is unset");
    return json(500, { error: "internal_error" });
  }

  const user = await verifyGithubToken(accessToken, GITHUB_CLIENT_ID, clientSecret);
  if (user.kind === "auth_failed") return json(401, { error: "github_auth_failed" });
  if (user.kind === "transient") {
    return json(503, {
      error: "github_unavailable",
      message: "GitHub is unavailable. Try again.",
    });
  }

  // Identity is proven — cap the mint's D1 writes on the same per-identity budget as publish/delete
  // (a login is a write), before any DB work.
  const writeLimited = await checkWriteRateLimit(user.id);
  if (writeLimited) return writeLimited;

  try {
    const now = new Date().toISOString();
    const { id, login } = user;
    let handle: string | null;
    if (isValidHandle(login) && !isReserved(login.toLowerCase())) {
      // Authoritative bind — introspection just proved the caller owns `login`. It takes the handle
      // from any stale holder; a login is not a publish (updated_at stays NULL).
      await env.DB.batch(handleBindStatements(env.DB, id, login, now));
      handle = login;
    } else {
      // Rare: the GitHub username collides with a reserved route/verb, so this identity can't hold a
      // handle. Mint a token (the user can still act on their github_id) but DISPLACE any prior handle
      // to limbo — record it to history + clear it — so a stale /handle doesn't keep resolving here.
      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR REPLACE INTO handle_history (old_handle_lower, github_id, changed_at) " +
            "SELECT handle_lower, github_id, ? FROM users WHERE github_id = ? AND handle_lower IS NOT NULL",
        ).bind(now, id),
        env.DB.prepare(
          "INSERT INTO users (github_id, handle, handle_lower, extras, updated_at, created_at) " +
            "VALUES (?, NULL, NULL, '[]', NULL, ?) " +
            "ON CONFLICT(github_id) DO UPDATE SET handle = NULL, handle_lower = NULL",
        ).bind(id, now),
      ]);
      handle = null;
    }
    const token = await mintToken(env.DB, id);
    return json(200, { token, handle });
  } catch {
    console.error("mint failed for github_id", user.id);
    return json(500, { error: "internal_error" });
  }
};
