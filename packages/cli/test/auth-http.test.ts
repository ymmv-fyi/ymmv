import { afterEach, describe, expect, it, vi } from "vitest";
import { mintYmmvToken } from "../src/auth-http.js";

// Real mintYmmvToken (NOT mocked here — other CLI suites mock auth-http.js; Vitest isolates files, so
// no bleed). Stub the global fetch to drive each Worker response the mint handler can return.
function stubFetch(body: unknown, status: number, headers: Record<string, string> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("mintYmmvToken", () => {
  it("returns {token, handle} on 200", async () => {
    stubFetch({ token: "ymmv_x", handle: "carol" }, 200);
    expect(await mintYmmvToken("gho_x")).toEqual({ token: "ymmv_x", handle: "carol" });
  });

  it("surfaces a 429 (login rate limit) with the server message + retry hint", async () => {
    stubFetch(
      {
        error: "rate_limited",
        message: "Too many login attempts — slow down and try again shortly.",
      },
      429,
      { "retry-after": "60" },
    );
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/too many login attempts.*retry in 60s/i);
  });

  it("surfaces a 503 (GitHub unavailable) with a friendly message", async () => {
    stubFetch({ error: "github_unavailable", message: "GitHub is unavailable — try again." }, 503);
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/github is unavailable/i);
  });

  it("throws a generic login-failed error on other non-ok statuses (e.g. foreign-token 401)", async () => {
    stubFetch({ error: "github_auth_failed" }, 401);
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/login failed: 401/i);
  });
});
