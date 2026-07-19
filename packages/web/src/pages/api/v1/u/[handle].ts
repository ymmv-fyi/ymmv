import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { readCacheControl, resolveProfile } from "../../../../lib/profile-read.ts";

// GET /api/v1/u/<handle> — the public JSON contract (shared/src/types.ts → Profile).
// Precedence + edge cache live in the shared resolveProfile/readCacheControl, so this JSON
// and the SSR /[handle] page can never disagree on what a handle resolves to:
//   live → 200 · renamed-away → 301 (Location stays under /api/v1/u for the JSON contract) ·
//   reclaimed → 200 new owner · unknown / reserved / unpublished / 301-target-gone → 404.
// Error honesty: 404 only on genuine absence; a D1 throw surfaces 500 + log, never masked.
// Errors are JSON envelopes ({"error":"not_found"} / {"error":"internal_error"}) like the rest
// of /api/v1, and the 500 is no-store so a future edge-cache rule can't pin an outage.
// Consumer-facing contract: docs/api.md — keep it in sync with any change here.

// Public read-only data: the whole handler surface (including errors) is cross-origin readable.
// Errors carry it too — without ACAO a browser fetch sees an opaque CORS TypeError instead of
// the status, so a consumer couldn't tell an outage from a network failure.
const CORS = { "access-control-allow-origin": "*" } as const;

export const GET: APIRoute = async ({ params }) => {
  try {
    const result = await resolveProfile(env.DB, params.handle);

    if (result.kind === "renamed") {
      return new Response(null, {
        status: 301,
        headers: {
          ...CORS,
          location: `/api/v1/u/${result.handle}`,
          "cache-control": readCacheControl("renamed"),
        },
      });
    }

    if (result.kind === "notfound") {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: {
          ...CORS,
          "content-type": "application/json",
          "cache-control": readCacheControl("notfound"),
        },
      });
    }

    return new Response(JSON.stringify(result.profile), {
      status: 200,
      headers: {
        ...CORS,
        "content-type": "application/json",
        "cache-control": readCacheControl("live"),
      },
    });
  } catch (e) {
    console.error("D1 read failed for handle", params.handle, e);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
    });
  }
};

// Preflight: a browser fetch with any non-safelisted request header (axios instance defaults,
// X-Requested-With, ...) sends OPTIONS first; without this handler that preflight falls through
// to the HTML 404 with no ACAO and the request dies as an opaque CORS TypeError — the exact
// failure the ACAO grant above exists to eliminate. GET-only surface, no credentials, so the
// grant is maximal and static.
export const OPTIONS: APIRoute = () =>
  new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      // HEAD rides the GET handler (Astro serves it automatically), so grant it too.
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      // Per the Fetch spec the `*` wildcard does NOT cover Authorization, so a browser client
      // whose HTTP lib attaches a default bearer would still fail preflight without naming it.
      "access-control-allow-headers": "*, authorization",
      "access-control-max-age": "86400",
    },
  });
