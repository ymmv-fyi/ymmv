import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { parseBearer, revokeToken } from "../../../../lib/auth.ts";
import { noStoreJson } from "../../../../lib/json.ts";

// POST /api/v1/auth/logout — revoke the presented token server-side, then the CLI deletes the
// local file. Idempotent: an already-revoked or unknown token still returns 200, with `revoked:false`
// so the CLI can tell the user there was no active session here (e.g. logged out against the wrong
// API base) rather than silently claiming success.
export const POST: APIRoute = async ({ request }) => {
  const raw = parseBearer(request);
  if (!raw) return noStoreJson(401, { error: "unauthorized" });
  try {
    const revoked = await revokeToken(env.DB, raw);
    return noStoreJson(200, { ok: true, revoked });
  } catch {
    console.error("logout revoke failed");
    return noStoreJson(500, { error: "internal_error" });
  }
};
