import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalRedirect,
  HSTS,
  httpsRequired,
  isCanonicalHost,
  withHsts,
} from "../src/lib/canonical-origin.ts";
import { onRequest } from "../src/middleware.ts";

const SITE = new URL("https://ymmv.fyi");

function redirectFor(href: string, method = "GET"): Response | null {
  return canonicalRedirect(new URL(href), method, SITE);
}

describe("canonicalRedirect", () => {
  it("301s http and www GET/HEAD to https://ymmv.fyi with path and query", () => {
    for (const [href, method, location] of [
      ["http://ymmv.fyi/bardisty?x=1", "GET", "https://ymmv.fyi/bardisty?x=1"],
      ["https://www.ymmv.fyi/", "GET", "https://ymmv.fyi/"],
      ["http://www.ymmv.fyi/a", "HEAD", "https://ymmv.fyi/a"],
      ["http://ymmv.fyi/api/v1/u/bardisty", "GET", "https://ymmv.fyi/api/v1/u/bardisty"],
    ]) {
      const res = redirectFor(href, method);
      expect(res?.status, href).toBe(301);
      expect(res?.headers.get("location"), href).toBe(location);
    }
  });

  it("308s every other method so the method and body are kept", () => {
    for (const method of ["POST", "DELETE", "OPTIONS", "PUT"]) {
      const res = redirectFor("http://ymmv.fyi/api/v1/profile", method);
      expect(res?.status, method).toBe(308);
      expect(res?.headers.get("location"), method).toBe("https://ymmv.fyi/api/v1/profile");
    }
  });

  it("leaves the canonical origin and every other host alone", () => {
    for (const href of [
      "https://ymmv.fyi/x",
      "https://ymmv.fyi/",
      "http://localhost:8788/",
      "http://127.0.0.1:8788/bardisty",
      "http://localhost:4321/",
      "https://localhost:8788/",
      "https://ymmv-staging.acct.workers.dev/bardisty",
      "https://ymmv.test/api/v1/auth/token",
      "https://api.ymmv.fyi/",
      "http://notymmv.fyi/",
      "http://ymmv.fyi.evil.com/",
      "http://www.ymmv.fyi.evil.com/",
    ]) {
      expect(redirectFor(href, "POST"), href).toBeNull();
    }
  });

  it("never redirects off-host: a //host or /\\host path stays on ymmv.fyi", () => {
    for (const href of ["http://ymmv.fyi//evil.com/x", "http://www.ymmv.fyi/\\evil.com/x"]) {
      const location = redirectFor(href)?.headers.get("location") ?? "";
      expect(new URL(location).host, href).toBe("ymmv.fyi");
      expect(location, href).toBe("https://ymmv.fyi//evil.com/x");
    }
  });

  it("keeps the path and query encoding byte for byte", () => {
    expect(redirectFor("http://www.ymmv.fyi/a%2Fb/100%25?q=%26&r")?.headers.get("location")).toBe(
      "https://ymmv.fyi/a%2Fb/100%25?q=%26&r",
    );
  });

  it("canonicalizes a port, a trailing dot, and upper case (path case kept)", () => {
    for (const [href, location] of [
      ["https://ymmv.fyi:8443/x", "https://ymmv.fyi/x"],
      ["http://ymmv.fyi./x", "https://ymmv.fyi/x"],
      ["https://ymmv.fyi./x", "https://ymmv.fyi/x"],
      ["https://www.ymmv.fyi./x", "https://ymmv.fyi/x"],
      ["HTTP://WWW.YMMV.FYI/X", "https://ymmv.fyi/X"],
    ]) {
      expect(redirectFor(href)?.headers.get("location"), href).toBe(location);
    }
  });

  it("treats an explicit default port as the canonical origin, so it never redirects to itself", () => {
    expect(redirectFor("https://ymmv.fyi:443/x")).toBeNull();
    for (const [href, location] of [
      ["http://ymmv.fyi:80/x", "https://ymmv.fyi/x"],
      ["https://www.ymmv.fyi:443/x", "https://ymmv.fyi/x"],
    ]) {
      expect(redirectFor(href)?.headers.get("location"), href).toBe(location);
    }
  });

  it("sends an empty body, a bounded cache policy, and a CORS grant", async () => {
    const res = redirectFor("https://www.ymmv.fyi/api/v1/u/bardisty");
    expect(res?.body).toBeNull();
    expect(await res?.text()).toBe("");
    expect(res?.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("varies an http redirect on authorization (a credentialed GET gets the 403 instead)", () => {
    // Cacheable 301, but httpsRequired answers the same URL differently when a bearer rides along:
    // a shared cache must not serve this redirect to that request.
    expect(redirectFor("http://ymmv.fyi/api/v1/u/bardisty")?.headers.get("vary")).toBe(
      "authorization",
    );
    expect(redirectFor("http://www.ymmv.fyi/", "POST")?.headers.get("vary")).toBe("authorization");
    // https has no 403 twin, so its redirect varies on nothing.
    expect(redirectFor("https://www.ymmv.fyi/bardisty")?.headers.get("vary")).toBeNull();
  });
});

describe("httpsRequired", () => {
  function refusalFor(href: string, method = "GET", headers: HeadersInit = {}): Response | null {
    return httpsRequired(new Request(href, { method, headers }), new URL(href), SITE);
  }

  it("403s a writing method on plain http, apex or www, API or not", () => {
    for (const [href, method] of [
      ["http://ymmv.fyi/api/v1/profile", "POST"],
      ["http://ymmv.fyi/api/v1/profile", "DELETE"],
      ["http://ymmv.fyi/api/v1/profile", "PUT"],
      ["http://ymmv.fyi/api/v1/auth/token", "POST"],
      ["http://www.ymmv.fyi/api/v1/auth/logout", "POST"],
      ["http://ymmv.fyi//api/v1/profile", "POST"],
      ["http://ymmv.fyi:8080/bardisty", "POST"],
    ]) {
      expect(refusalFor(href, method)?.status, `${method} ${href}`).toBe(403);
    }
  });

  it("403s a read that carries a credential: the bearer must not be taught to repeat", () => {
    const auth = { authorization: "Bearer ymmv_x" };
    expect(refusalFor("http://ymmv.fyi/api/v1/auth/whoami", "GET", auth)?.status).toBe(403);
    expect(refusalFor("http://ymmv.fyi/api/v1/u/bardisty", "HEAD", auth)?.status).toBe(403);
  });

  it("leaves an uncredentialed read to the redirect (public JSON and pages keep their 301)", () => {
    for (const [href, method] of [
      ["http://ymmv.fyi/api/v1/u/bardisty", "GET"],
      ["http://ymmv.fyi/bardisty", "HEAD"],
      ["http://www.ymmv.fyi/api/v1/u/bardisty", "OPTIONS"],
    ]) {
      expect(refusalFor(href, method), `${method} ${href}`).toBeNull();
    }
  });

  it("leaves https (www keeps its 308) and every non-canonical host alone", () => {
    const auth = { authorization: "Bearer ymmv_x" };
    for (const href of [
      "https://ymmv.fyi/api/v1/profile",
      "https://www.ymmv.fyi/api/v1/profile",
      "http://localhost:8788/api/v1/profile",
      "http://127.0.0.1:8788/api/v1/profile",
      "http://ymmv.fyi.evil.com/api/v1/profile",
    ]) {
      expect(refusalFor(href, "POST", auth), href).toBeNull();
    }
  });

  it("normalizes the host like the redirect does: a trailing dot or upper case is still ymmv.fyi", () => {
    for (const href of [
      "http://ymmv.fyi./api/v1/profile",
      "http://www.ymmv.fyi./api/v1/profile",
      "HTTP://YMMV.FYI/api/v1/profile",
    ]) {
      expect(refusalFor(href, "POST")?.status, href).toBe(403);
    }
  });

  it("fails closed on any other method, and on an OPTIONS that carries a credential", () => {
    expect(refusalFor("http://ymmv.fyi/api/v1/profile", "PATCH")?.status).toBe(403);
    const auth = { authorization: "Bearer ymmv_x" };
    expect(refusalFor("http://ymmv.fyi/api/v1/profile", "OPTIONS", auth)?.status).toBe(403);
  });

  it("sends the https_required envelope, no-store, a CORS grant, and no Location", async () => {
    const res = refusalFor("http://ymmv.fyi/api/v1/profile", "POST");
    expect(res?.headers.get("content-type")).toBe("application/json");
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    expect(res?.headers.get("location")).toBeNull();
    expect(await res?.json()).toEqual({
      error: "https_required",
      message: "This request must use https://ymmv.fyi, not plain http.",
    });
  });
});

describe("isCanonicalHost", () => {
  it("matches apex and www on any scheme, and nothing else", () => {
    expect(isCanonicalHost(new URL("http://ymmv.fyi/"), SITE)).toBe(true);
    expect(isCanonicalHost(new URL("https://www.ymmv.fyi/"), SITE)).toBe(true);
    expect(isCanonicalHost(new URL("https://ymmv.fyi./"), SITE)).toBe(true);
    expect(isCanonicalHost(new URL("https://localhost/"), SITE)).toBe(false);
    expect(isCanonicalHost(new URL("https://staging.ymmv.fyi/"), SITE)).toBe(false);
  });
});

describe("withHsts", () => {
  it("sets the header on a mutable response in place", () => {
    const res = new Response("ok", { headers: { "cache-control": "no-store" } });
    expect(withHsts(res)).toBe(res);
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
  });

  it("copies a response whose headers are read-only", () => {
    const redirect = Response.redirect("https://ymmv.fyi/x", 302);
    expect(() => redirect.headers.set("x-probe", "1")).toThrow();
    const res = withHsts(redirect);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://ymmv.fyi/x");
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
  });

  it("keeps the body, status text and headers when it has to copy (a fetch() passthrough)", async () => {
    const upstream = new Response("from upstream", {
      status: 203,
      statusText: "Non-Authoritative",
      headers: { "content-type": "text/plain", etag: '"v1"' },
    });
    // workerd hands out read-only headers only on redirect/fetch responses; stand one in here.
    vi.spyOn(upstream.headers, "set").mockImplementation(() => {
      throw new TypeError("Can't modify immutable headers.");
    });
    const res = withHsts(upstream);
    expect(res).not.toBe(upstream);
    expect(res.status).toBe(203);
    expect(res.statusText).toBe("Non-Authoritative");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
    expect(await res.text()).toBe("from upstream");
  });
});

describe("onRequest middleware", () => {
  function ctx(href: string, method = "GET"): APIContext {
    return { request: new Request(href, { method }), site: SITE } as unknown as APIContext;
  }

  function nextReturning(res: () => Response) {
    return vi.fn(async () => res());
  }

  it("refuses an http POST before any handler runs: 403, no redirect to repeat it against", async () => {
    const next = nextReturning(() => new Response("handled"));
    const res = (await onRequest(ctx("http://ymmv.fyi/api/v1/profile", "POST"), next)) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("strict-transport-security")).toBeNull(); // an http response
  });

  it("refuses an http GET carrying a bearer before its 301 could teach the client to resend it", async () => {
    const next = nextReturning(() => new Response("handled"));
    const withBearer = {
      request: new Request("http://www.ymmv.fyi/api/v1/auth/whoami", {
        headers: { authorization: "Bearer ymmv_x" },
      }),
      site: SITE,
    } as unknown as APIContext;
    const res = (await onRequest(withBearer, next)) as Response;
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("strict-transport-security")).toBeNull();
    // The same read without the bearer keeps its 301.
    const plain = (await onRequest(
      ctx("http://www.ymmv.fyi/api/v1/auth/whoami"),
      next,
    )) as Response;
    expect(plain.status).toBe(301);
    expect(next).not.toHaveBeenCalled();
  });

  it("still 308s a write on https www before any handler runs", async () => {
    const next = nextReturning(() => new Response("handled"));
    const res = (await onRequest(
      ctx("https://www.ymmv.fyi/api/v1/auth/token", "POST"),
      next,
    )) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://ymmv.fyi/api/v1/auth/token");
  });

  it("adds HSTS to a canonical https response and keeps everything else", async () => {
    const next = nextReturning(
      () =>
        new Response("page", {
          status: 404,
          headers: { "cache-control": "public, max-age=0", "content-type": "text/html" },
        }),
    );
    const res = (await onRequest(ctx("https://ymmv.fyi/nope"), next)) as Response;
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("page");
    expect(res.headers.get("cache-control")).toBe("public, max-age=0");
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
  });

  it("builds the Location from the raw request URL, not Astro's decoded context.url", async () => {
    // Astro decodes context.url.pathname and collapses `//`; redirecting from it would turn
    // %2F into a real path separator and drop the empty segment.
    const context = {
      request: new Request("http://www.ymmv.fyi//a%2Fb/100%25?q=%26"),
      url: new URL("http://www.ymmv.fyi/a/b/100%?q=%26"),
      site: SITE,
    } as unknown as APIContext;
    const next = nextReturning(() => new Response("never"));
    const res = (await onRequest(context, next)) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://ymmv.fyi//a%2Fb/100%25?q=%26");
  });

  it("pins HSTS on the https www 308 for a write, and the route never runs", async () => {
    const next = nextReturning(() => new Response("handled"));
    const res = (await onRequest(
      ctx("https://www.ymmv.fyi/api/v1/profile", "DELETE"),
      next,
    )) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://ymmv.fyi/api/v1/profile");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
  });

  it("pins HSTS on the https www redirect, not on an http one", async () => {
    const next = nextReturning(() => new Response("never"));
    const www = (await onRequest(ctx("https://www.ymmv.fyi/bardisty"), next)) as Response;
    expect(www.status).toBe(301);
    expect(www.headers.get("strict-transport-security")).toBe(HSTS);

    const http = (await onRequest(ctx("http://ymmv.fyi/bardisty"), next)) as Response;
    expect(http.status).toBe(301);
    expect(http.headers.get("strict-transport-security")).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it("passes other hosts through untouched, with no HSTS even over https", async () => {
    for (const href of [
      "http://localhost:8788/",
      "https://localhost:8788/",
      "https://ymmv.test/api/v1/auth/whoami",
      "https://ymmv-staging.acct.workers.dev/",
    ]) {
      const handled = new Response("handled");
      const res = await onRequest(
        ctx(href),
        nextReturning(() => handled),
      );
      expect(res, href).toBe(handled);
      expect(handled.headers.get("strict-transport-security"), href).toBeNull();
    }
  });

  it("adds HSTS to a read-only response from the route", async () => {
    const next = nextReturning(() => Response.redirect("https://ymmv.fyi/x", 302));
    const res = (await onRequest(ctx("https://ymmv.fyi/y"), next)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://ymmv.fyi/x");
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
  });

  it("passes through when no site is configured", async () => {
    const handled = new Response("handled");
    const noSite = { request: new Request("http://www.ymmv.fyi/") } as unknown as APIContext;
    const res = await onRequest(
      noSite,
      nextReturning(() => handled),
    );
    expect(res).toBe(handled);
    expect(handled.headers.get("strict-transport-security")).toBeNull();
  });
});
