// One public origin: https://ymmv.fyi (astro.config `site`). The production Worker also answers
// on www.ymmv.fyi (a second custom domain) and on plain http, so src/middleware.ts sends both to
// the canonical origin and pins HTTPS with HSTS. Pure (no astro: imports) so tests load it
// directly. Only the canonical hosts are touched: localhost, the workers.dev staging Worker and
// the unit tests' ymmv.test pass through as-is.

// One year, covering every *.ymmv.fyi host. No `preload`: listing is a separate, slower-to-undo
// commitment. Browsers keep this for the full max-age once seen, so lowering it later only
// affects browsers that come back.
export const HSTS = "max-age=31536000; includeSubDomains";

// A 301 with no cache-control is cached by browsers indefinitely; a day keeps the www→apex hop
// cheap without making it permanent. http→https is pinned by HSTS anyway.
const REDIRECT_CACHE_CONTROL = "public, max-age=86400";

/** Apex + www. Must match the production custom domains in wrangler.jsonc (pinned by
 *  test/wrangler-config.test.ts), or a newly routed host would serve pages without a redirect. */
export function canonicalHosts(site: URL): string[] {
  return [site.hostname, `www.${site.hostname}`];
}

/** Whether `url` is on one of the canonical hosts, any scheme or port. One trailing dot is
 *  stripped first: the URL parser keeps `ymmv.fyi.`, which is the same host. */
export function isCanonicalHost(url: URL, site: URL): boolean {
  return canonicalHosts(site).includes(url.hostname.replace(/\.$/, ""));
}

/** The redirect to `site` for a request on a canonical host that isn't the canonical origin
 *  (http, www, a port, a trailing dot), or null. 301 for GET/HEAD; 308 for the rest so a
 *  method and body survive. */
export function canonicalRedirect(url: URL, method: string, site: URL): Response | null {
  if (!isCanonicalHost(url, site) || url.origin === site.origin) return null;
  return new Response(null, {
    status: method === "GET" || method === "HEAD" ? 301 : 308,
    headers: {
      // String concat, never `new URL(path, site)`: a `//evil.com` path would resolve to that host.
      location: site.origin + url.pathname + url.search,
      "cache-control": REDIRECT_CACHE_CONTROL,
      // Browsers run the CORS check on a redirect too; without this a cross-origin GET of
      // www.ymmv.fyi/api/v1/u/<handle> fails before reaching the apex (see api/v1/u/[handle].ts).
      "access-control-allow-origin": "*",
    },
  });
}

/** `res` with HSTS set. A Response.redirect() or fetch() passthrough has read-only headers, so
 *  those are copied first (the Cloudflare adapter handles the same case the same way). */
export function withHsts(res: Response): Response {
  try {
    res.headers.set("strict-transport-security", HSTS);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    copy.headers.set("strict-transport-security", HSTS);
    return copy;
  }
}
