import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { readCacheControl, resolveProfile } from "../../../../lib/profile-read.ts";

// GET /api/v1/u/<handle> — the public JSON contract (shared/src/types.ts → Profile).
// Precedence + edge cache live in the shared resolveProfile/readCacheControl, so this JSON
// and the SSR /[handle] page can never disagree on what a handle resolves to:
//   live → 200 · renamed-away → 301 (Location stays under /api/v1/u for the JSON contract) ·
//   reclaimed → 200 new owner · unknown / reserved / unpublished / 301-target-gone → 404.
// Error honesty: 404 only on genuine absence; a D1 throw surfaces 500 + log, never masked.
export const GET: APIRoute = async ({ params }) => {
  try {
    const result = await resolveProfile(env.DB, params.handle);

    if (result.kind === "renamed") {
      return new Response(null, {
        status: 301,
        headers: {
          location: `/api/v1/u/${result.handle}`,
          "cache-control": readCacheControl("renamed"),
        },
      });
    }

    if (result.kind === "notfound") {
      return new Response("not found", {
        status: 404,
        headers: { "cache-control": readCacheControl("notfound") },
      });
    }

    return new Response(JSON.stringify(result.profile), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": readCacheControl("live"),
      },
    });
  } catch (e) {
    console.error("D1 read failed for handle", params.handle, e);
    return new Response("internal error", { status: 500 });
  }
};
