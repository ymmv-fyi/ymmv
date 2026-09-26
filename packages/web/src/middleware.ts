import type { MiddlewareHandler } from "astro";
import {
  canonicalRedirect,
  httpsRequired,
  isCanonicalHost,
  withHsts,
} from "./lib/canonical-origin.ts";

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
  if (!site) return next();
  // The raw request URL, not context.url: Astro has already decoded context.url.pathname and
  // collapsed its `//`, which would corrupt %2F / %25 in the redirect target.
  const url = new URL(context.request.url);
  const res =
    httpsRequired(context.request, url, site) ??
    canonicalRedirect(url, context.request.method, site) ??
    (await next());
  // Canonical hosts only, so an https localhost (`wrangler dev --local-protocol https`) is never
  // pinned for a year. An http response skips it: browsers ignore HSTS sent over http.
  return url.protocol === "https:" && isCanonicalHost(url, site) ? withHsts(res) : res;
};
