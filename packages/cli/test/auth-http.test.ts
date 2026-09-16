import { afterEach, describe, expect, it, vi } from "vitest";
import { MintRejected, mintYmmvToken, revokeYmmvToken } from "../src/auth-http.js";
import { REVOKE_CAP_MS } from "../src/http.js";

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
  it("returns {token, handle, github_id} on 200", async () => {
    stubFetch({ token: "ymmv_x", handle: "carol", github_id: 4242 }, 200);
    expect(await mintYmmvToken("gho_x")).toEqual({
      token: "ymmv_x",
      handle: "carol",
      github_id: 4242,
    });
  });

  it("a 200 WITHOUT github_id throws MintRejected AND revokes the token the Worker already minted", async () => {
    // Tolerating a missing id would store null and silently drop the reauth guard back to the
    // handle-only check — the exact hole issue #57 closes. Deploy the Worker before the CLI.
    // The token in that reply is already live in D1 and nothing local will ever hold it: the
    // refusal must revoke it (best-effort) or every such login leaves an orphaned session.
    stubFetch({ token: "ymmv_x", handle: "carol" }, 200);
    const err = await mintYmmvToken("gho_x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(MintRejected); // api.ts turns this into a loop-exiting refusal
    expect((err as Error).message).toMatch(/Unexpected response from/);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/api/v1/auth/logout");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ymmv_x");
  });

  it("a 200 with a github_id that is not a positive safe integer throws the same way", async () => {
    for (const bad of ["4242", 0, -5, 1.5, 2 ** 53, null]) {
      stubFetch({ token: "ymmv_x", handle: "carol", github_id: bad }, 200);
      await expect(mintYmmvToken("gho_x")).rejects.toThrow(/Unexpected response from/);
      expect(fetch).toHaveBeenCalledTimes(2); // revoke attempted here too
    }
  });

  it("a rejected reply with no usable token has nothing to revoke: one request only", async () => {
    stubFetch({ token: "", handle: "carol", github_id: 4242 }, 200);
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/Unexpected response from/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a handle a real Worker never binds (empty, control-only, invalid), revoking the token", async () => {
    // A foreign YMMV_API origin is the only source of these. Stored, "" would be falsy-but-not-null
    // and slip past every `=== null` no-handle check; a control-only string sanitizes to exactly
    // that; a slash-bearing one would reach the publish body and printed URLs.
    const esc = String.fromCharCode(0x1b);
    for (const bad of ["", `${esc}[31m`, "a/b", " ", "x".repeat(10_000), 42, undefined]) {
      const body: Record<string, unknown> = { token: "ymmv_x", github_id: 4242 };
      if (bad !== undefined) body.handle = bad; // undefined = the handle key is missing entirely
      stubFetch(body, 200);
      const err = await mintYmmvToken("gho_x").catch((e: Error) => e);
      expect(err).toBeInstanceOf(MintRejected);
      expect(fetch).toHaveBeenCalledTimes(2); // mint + revoke
    }
  });

  it("caps the best-effort revoke at REVOKE_CAP_MS and reports when it fails", async () => {
    // stubFetch hands out ONE Response object: the mint parse drains it, so the revoke's json()
    // rejects and revokeYmmvToken throws. A failed revoke must make the refusal SAY the minted
    // login is still live. safeFetch attaches a signal to every request, so the cap itself is
    // only observable through the spy.
    const spy = vi.spyOn(AbortSignal, "timeout");
    stubFetch({ token: "ymmv_x", handle: "carol" }, 200);
    const err = await mintYmmvToken("gho_x").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/could not be revoked/);
    expect(spy).toHaveBeenCalledWith(REVOKE_CAP_MS);
    spy.mockRestore();
  });

  it("a revoke that succeeds keeps the plain refusal copy", async () => {
    const mint = new Response(JSON.stringify({ token: "ymmv_x", handle: "carol" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const revoked = new Response(JSON.stringify({ revoked: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mint).mockResolvedValueOnce(revoked));
    const err = await mintYmmvToken("gho_x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(MintRejected);
    expect((err as Error).message).not.toMatch(/could not be revoked/);
  });

  it("surfaces a 429 (login rate limit) with the server message + retry hint", async () => {
    stubFetch(
      {
        error: "rate_limited",
        message: "Too many login attempts. Slow down and try again shortly.",
      },
      429,
      { "retry-after": "60" },
    );
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/too many login attempts.*retry in 60s/i);
  });

  it("surfaces a 503 (GitHub unavailable) with a friendly message", async () => {
    stubFetch({ error: "github_unavailable", message: "GitHub is unavailable. Try again." }, 503);
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/github is unavailable/i);
  });

  it("503 with a non-JSON body (edge WAF page) falls back to the friendly GitHub-unavailable line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>blocked</html>", { status: 503 })),
    );
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/GitHub is unavailable/);
  });

  it("429 with a message-less body falls back and still appends the retry hint", async () => {
    stubFetch({ error: "rate_limited" }, 429, { "retry-after": "30" });
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/Too many login attempts.*retry in 30s/i);
  });

  it("a body-read TIMEOUT on the mint response propagates as a timeout, never 'unexpected response'", async () => {
    // Headers landed, body stalled past the signal's budget: rejecting json() with the signal's
    // TimeoutError must not be mistaken for a middlebox token-less body.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.reject(
            new DOMException("The operation was aborted due to timeout", "TimeoutError"),
          ),
      }),
    );
    await expect(mintYmmvToken("gho_x")).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && e.name === "TimeoutError",
    );
  });

  it("maps 401 github_auth_failed to human copy — the post-approval moment must not print a slug", async () => {
    stubFetch({ error: "github_auth_failed" }, 401);
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(
      /GitHub rejected the authorization\. Run `ymmv login` to try again\./,
    );
  });

  it("maps 500 internal_error to human copy with a retry instruction", async () => {
    stubFetch({ error: "internal_error" }, 500);
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(
      /The server hit an error minting your login\. Run `ymmv login` again shortly\./,
    );
  });

  it("keeps the raw login-failed form for unknown slugs — the slug is the debugging signal", async () => {
    stubFetch({ error: "missing_access_token" }, 400);
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/login failed: 400 missing_access_token/);
  });

  it("a mapped STATUS with an unknown slug stays raw too (both must match to map)", async () => {
    stubFetch({ error: "weird_new_code" }, 401);
    await expect(mintYmmvToken("gho_x")).rejects.toThrow(/login failed: 401 weird_new_code/);
  });

  it('sets redirect:"manual" so a 3xx can never masquerade as a successful mint', async () => {
    // A stubbed fetch can't reproduce real redirect-following, so lock in the guard-option itself:
    // absent it, Node follows the 30x and re-POSTs the access_token to the redirect target.
    stubFetch({ token: "ymmv_x", handle: "carol", github_id: 4242 }, 200);
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

  it("a 200 with a non-JSON body throws the same clear error, as a TRANSIENT plain Error", async () => {
    // A mid-body reset or captive portal is a transport event, not a Worker this binary can't
    // use: not MintRejected, so the interactive loop keeps the user's answers. Nothing to revoke.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>portal</html>", { status: 200 })),
    );
    const err = await mintYmmvToken("gho_x").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Unexpected response from/);
    expect(err).not.toBeInstanceOf(MintRejected);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sanitizes the minted handle at the boundary — every downstream print inherits it clean", async () => {
    const esc = String.fromCharCode(0x1b);
    stubFetch({ token: "ymmv_x", handle: `car${esc}[31mol`, github_id: 4242 }, 200);
    expect(await mintYmmvToken("gho_x")).toEqual({
      token: "ymmv_x",
      handle: "carol",
      github_id: 4242,
    });
  });

  it("preserves a null handle (reserved GitHub username)", async () => {
    stubFetch({ token: "ymmv_x", handle: null, github_id: 4242 }, 200);
    expect(await mintYmmvToken("gho_x")).toEqual({
      token: "ymmv_x",
      handle: null,
      github_id: 4242,
    });
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

  it("rides safeFetch now: a thrown fetch reads as can't-reach and carries the timeout signal", async () => {
    // Behavior contract with logout(): ANY throw (can't-reach and timeout alike) lands in its
    // catch-all, which keeps the local token. The revoke is no longer the bare-fetch exception.
    const spy = vi.spyOn(AbortSignal, "timeout");
    stubFetch({ revoked: true }, 200);
    await revokeYmmvToken("ymmv_x");
    expect(spy).toHaveBeenCalledWith(30_000);
    spy.mockRestore();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(revokeYmmvToken("ymmv_x")).rejects.toThrow(/Can't reach .*Check your connection/);
  });

  it("returns the server's verdict only from a well-shaped body", async () => {
    stubFetch({ revoked: true }, 200);
    expect(await revokeYmmvToken("ymmv_x")).toBe(true);
    stubFetch({ revoked: false }, 200);
    expect(await revokeYmmvToken("ymmv_x")).toBe(false);
  });

  it("a 200 with an unreadable or shapeless body THROWS — never a false 'no active session'", async () => {
    // A middlebox-minted 200 (captive portal) or a stalled body must not read as a completed
    // revoke: logout() would delete the local file while the server token stays live, stranding
    // the only credential that can revoke it. Throwing keeps the token via logout's catch-all.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>portal</html>", { status: 200 })),
    );
    await expect(revokeYmmvToken("ymmv_x")).rejects.toThrow(/unexpected response/);
    stubFetch({}, 200);
    await expect(revokeYmmvToken("ymmv_x")).rejects.toThrow(/unexpected response/);
    stubFetch({ revoked: "yes" }, 200);
    await expect(revokeYmmvToken("ymmv_x")).rejects.toThrow(/unexpected response/);
  });

  it("a body-read TIMEOUT on the revoke response propagates (token kept, not deleted)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.reject(
            new DOMException("The operation was aborted due to timeout", "TimeoutError"),
          ),
      }),
    );
    await expect(revokeYmmvToken("ymmv_x")).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && e.name === "TimeoutError",
    );
  });
});
