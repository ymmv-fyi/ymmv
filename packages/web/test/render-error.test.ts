import type { APIContext } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HSTS } from "../src/lib/canonical-origin.ts";
import { onRequest } from "../src/middleware.ts";

// A route that throws answers a fixed 500 from the middleware. Left to Astro, the throw rendered
// the `/500` error route, which the dynamic /[handle] page matches, so a failed /<a>/vs/<b>
// became a cached not-found 404. web.e2e.ts proves the page case through the built Worker. The
// stubbed next() below stands in for Astro 7 rethrowing a page's or endpoint's throw out of its
// pages handler; no seed row can make an API route throw, so recheck the /api/ case on an Astro
// upgrade.

const SITE = new URL("https://ymmv.fyi");

// routePattern is the route Astro matched, e.g. "/[handle]/vs/[viewer]" for /antfu/vs/bardisty.
function ctx(href: string, routePattern: string): APIContext {
  return {
    request: new Request(href),
    url: new URL(href),
    routePattern,
    site: SITE,
  } as unknown as APIContext;
}

function nextThrowing(err: unknown) {
  return vi.fn(async (): Promise<Response> => {
    throw err;
  });
}

describe("a route that throws", () => {
  const err = new Error("D1_ERROR: no such table: users: SQLITE_ERROR");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers 500 no-store with a fixed page that names nothing of the error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await onRequest(
      ctx("https://ymmv.fyi/antfu/vs/bardisty", "/[handle]/vs/[viewer]"),
      nextThrowing(err),
    )) as Response;
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // A null body would send the 500 back through Astro's /500 -> /[handle] reroute.
    const body = await res.text();
    expect(body).toContain("Server error. Try again in a moment.");
    expect(body).not.toMatch(/D1_ERROR|SQLITE|no such table/);
    // HSTS still wraps it on the canonical origin.
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
    // The error is logged; the request (and any bearer on it) is not.
    expect(log).toHaveBeenCalledExactlyOnceWith("render failed", err);
  });

  it("answers the bearer endpoints' JSON 500 envelope on an API route, with no CORS grant", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const route of ["/api/v1/profile", "/api/v1/auth/whoami"]) {
      const res = (await onRequest(
        ctx(`https://ymmv.fyi${route}`, route),
        nextThrowing(err),
      )) as Response;
      expect(res.status, route).toBe(500);
      expect(res.headers.get("cache-control"), route).toBe("no-store");
      expect(res.headers.get("content-type"), route).toBe("application/json");
      // Bearer endpoints send no CORS; the public read catches its own errors and never lands here.
      expect(res.headers.get("access-control-allow-origin"), route).toBeNull();
      expect(await res.json(), route).toEqual({
        error: "internal_error",
        message: "The server hit an error. Try again shortly.",
      });
      // Either body is a fresh Response, so HSTS lands on the JSON 500 as on the page.
      expect(res.headers.get("strict-transport-security"), route).toBe(HSTS);
    }
  });

  it("picks the body by the matched route, so a page under an /api-looking path gets HTML", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [path, route] of [
      ["/api/vs/antfu", "/[handle]/vs/[viewer]"], // the diff page, handle `api`
      ["/apiary", "/[handle]"],
      ["/no/such/route", "/404"],
    ]) {
      const res = (await onRequest(
        ctx(`https://ymmv.fyi${path}`, route),
        nextThrowing(err),
      )) as Response;
      expect(res.status, path).toBe(500);
      expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
    }
  });

  it("answers 500 off the canonical origin and with no site configured, without HSTS", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const context of [
      ctx("http://localhost:8788/antfu", "/[handle]"),
      { ...ctx("https://ymmv.fyi/antfu", "/[handle]"), site: undefined },
    ]) {
      const res = (await onRequest(context, nextThrowing(err))) as Response;
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("strict-transport-security")).toBeNull();
    }
  });
});
