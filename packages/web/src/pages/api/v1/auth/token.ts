import { env } from "cloudflare:workers";
import { isReserved, isValidHandle } from "@ymmv/shared";
import type { APIRoute } from "astro";
import { mintToken } from "../../../../lib/auth.ts";
import { fetchGithubUser } from "../../../../lib/github.ts";
import { handleBindStatements } from "../../../../lib/users.ts";

// Bearer-token responses must never be cached by any intermediary.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// POST /api/v1/auth/token — device-flow mint. The body carries the GitHub access token the CLI just
// obtained; THAT is the credential (there is no ymmv bearer yet). The Worker re-verifies identity
// via api.github.com/user (never trusting a client-supplied id/login), binds the handle to the
// github_id authoritatively, and mints an opaque ymmv token. Do not log the tokens.
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

  const user = await fetchGithubUser(accessToken);
  if (user.kind === "auth_failed") return json(401, { error: "github_auth_failed" });
  if (user.kind === "transient") {
    return json(503, {
      error: "github_unavailable",
      message: "GitHub is unavailable — try again.",
    });
  }

  try {
    const now = new Date().toISOString();
    const { id, login } = user;
    let handle: string | null;
    if (isValidHandle(login) && !isReserved(login.toLowerCase())) {
      // Authoritative bind — GitHub's /user just proved the caller owns `login`. release:true takes
      // it from any stale holder; stampPublish:false — a login is not a publish (updated_at stays NULL).
      await env.DB.batch(
        handleBindStatements(env.DB, id, login, now, { stampPublish: false, release: true }),
      );
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
