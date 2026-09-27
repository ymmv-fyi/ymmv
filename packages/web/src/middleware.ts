import type { APIContext, MiddlewareHandler, MiddlewareNext } from "astro";
import {
  canonicalRedirect,
  httpsRequired,
  isCanonicalHost,
  withHsts,
} from "./lib/canonical-origin.ts";
import { noStoreJson } from "./lib/json.ts";

// Static on purpose: nothing about the failure (message, stack, route) reaches the client.
const SERVER_ERROR_PAGE =
  '<!doctype html><html lang="en"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="color-scheme" content="light dark">' +
  "<title>ymmv.fyi</title><p>Server error. Try again in a moment.</p></html>";

// A route that throws inside next() answers a fixed 500 from here, never through Astro's error
// path. That path renders the error page by matching `/500` against the route table, and with no
// 500.astro the dynamic /[handle] page takes it (a 500.astro would claim the handle `500`):
// /<a>/vs/<b> then renders as a cached not-found 404, and /<handle> reruns the failed D1 read. The
// body must not be null, or Astro sends the 500 down that same path. A throw after a page has
// started streaming is past saving here: its status line is already sent.
async function nextOr500(context: APIContext, next: MiddlewareNext): Promise<Response> {
  try {
    return await next();
  } catch (err) {
    // The error only: Workers Logs already ties this line to the request's URL, and nothing
    // from the request (its bearer included) belongs in a log.
    console.error("render failed", err);
    // `astro dev` gets this generic page too, not its stack overlay: the stack is in the terminal.
    // The matched route decides, not the path: /api/vs/<viewer> is the diff page (handle `api`).
    // The public read catches its own errors, so an API route that lands here is a bearer
    // endpoint: its 500 envelope (profile.ts), whose message the CLI prints, and no CORS grant.
    return context.routePattern.startsWith("/api/")
      ? noStoreJson(500, {
          error: "internal_error",
          message: "The server hit an error. Try again shortly.",
        })
      : new Response(SERVER_ERROR_PAGE, {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
  }
}

// Canonical origin + HSTS for every page and API route, and the 403 for a credentialed or writing
// request on plain http (src/lib/canonical-origin.ts). What never reaches middleware, so is
// neither redirected, refused, nor given HSTS:
//   • static assets (/_astro/*, public/*), which Workers Static Assets serves before the Worker,
//     and the adapter's fall-through to them. Pages link assets root-relative, so they load from
//     the origin the page is on, and every page is Worker-rendered, so HSTS still reaches the
//     browser on its first page view.
//   • Astro's own early replies: the 400 for a path percent-encoded more than 10 levels deep and
//     the root-relative 301 that collapses a doubled trailing slash.
// Local dev never matches (localhost). But `wrangler dev` on a PRODUCTION-built dist/ takes the
// first route (ymmv.fyi) as its origin and rewrites the redirect's Location back to localhost,
// so every request loops; build without CLOUDFLARE_ENV for local runs.
//
// `defineMiddleware` is an identity helper from the astro:middleware virtual module, which the
// vitest pool can't resolve, so the handler is typed directly.
export const onRequest: MiddlewareHandler = async (context, next) => {
  const { site } = context;
  if (!site) return nextOr500(context, next);
  // The raw request URL, not context.url: Astro has already decoded context.url.pathname and
  // collapsed its `//`, which would corrupt %2F / %25 in the redirect target.
  const url = new URL(context.request.url);
  const res =
    httpsRequired(context.request, url, site) ??
    canonicalRedirect(url, context.request.method, site) ??
    (await nextOr500(context, next));
  // Canonical hosts only, so an https localhost (`wrangler dev --local-protocol https`) is never
  // pinned for a year. An http response skips it: browsers ignore HSTS sent over http.
  return url.protocol === "https:" && isCanonicalHost(url, site) ? withHsts(res) : res;
};
