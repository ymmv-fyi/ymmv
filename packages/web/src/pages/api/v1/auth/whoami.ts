import { env } from "cloudflare:workers";
import type { WhoamiResult } from "@ymmv/shared";
import type { APIRoute } from "astro";
import { authenticateIdentity } from "../../../../lib/auth.ts";
import { noStoreJson } from "../../../../lib/json.ts";

// GET /api/v1/auth/whoami — the identity the presented bearer is bound to. The CLI calls this for a
// YMMV_TOKEN credential, which (unlike a stored login) arrives with no server-proven handle or id.
// A missing, unknown, or revoked bearer is one 401, same as the authed writes. No CORS headers: this
// is a bearer endpoint, not part of the public read API. No rate-limit binding (see rate-limit.ts).
export const GET: APIRoute = async ({ request }) => {
  try {
    const identity = await authenticateIdentity(request, env.DB);
    if (!identity) return noStoreJson(401, { error: "unauthorized" });
    const body: WhoamiResult = { github_id: identity.github_id, handle: identity.handle };
    return noStoreJson(200, body);
  } catch (e) {
    // Safe to log: the only value the lookup binds is the token's SHA-256, never the raw bearer.
    console.error("whoami lookup failed", e);
    return noStoreJson(500, { error: "internal_error" });
  }
};
