import { afterEach, describe, expect, it, vi } from "vitest";
import { mintYmmvToken, revokeYmmvToken } from "../src/auth-http.js";

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

  it('sets redirect:"manual" so a 3xx can never masquerade as a successful mint', async () => {
    // A stubbed fetch can't reproduce real redirect-following, so lock in the guard-option itself:
    // absent it, Node follows the 30x and re-POSTs the access_token to the redirect target.
    stubFetch({ token: "ymmv_x", handle: "carol" }, 200);
    await mintYmmvToken("gho_x");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/auth/token"),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("a thrown fetch reads as can't-reach, never a raw TypeError (post-approval moment)", async () => {
    const err = new TypeError("fetch failed");
    (err as Error & { cause: Error }).cause = new Error("getaddrinfo ENOTFOUND ymmv.fyi");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(
      /Can't reach .*Check your connection.*ENOTFOUND/,
    );
  });

  it("a 200 with a token-less body throws instead of poisoning the token store", async () => {
    // A middlebox 200 `{}` used to cast straight through; saveToken would then overwrite a
    // previously valid token.json with a token-less blob, destroying an existing login.
    stubFetch({}, 200);
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/Unexpected response from/);
  });

  it("a 200 with a non-JSON body throws the same clear error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>portal</html>", { status: 200 })),
    );
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/Unexpected response from/);
  });

  it("sanitizes the minted handle at the boundary — every downstream print inherits it clean", async () => {
    const esc = String.fromCharCode(0x1b);
    stubFetch({ token: "ymmv_x", handle: `car${esc}[31mol` }, 200);
    expect(await mintYmmvToken("gho_x")).toEqual({ token: "ymmv_x", handle: "carol" });
  });

  it("preserves a null handle (reserved GitHub username)", async () => {
    stubFetch({ token: "ymmv_x", handle: null }, 200);
    expect(await mintYmmvToken("gho_x")).toEqual({ token: "ymmv_x", handle: null });
  });
});

describe("revokeYmmvToken", () => {
  it('sets redirect:"manual" so a 3xx can never masquerade as a successful logout', async () => {
    stubFetch({ revoked: true }, 200);
    await revokeYmmvToken("ymmv_x");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/auth/logout"),
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});
