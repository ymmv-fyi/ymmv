import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWhoami,
  MintRejected,
  mintYmmvToken,
  parseIdentity,
  revokeYmmvToken,
} from "../src/auth-http.js";
import { REVOKE_CAP_MS, RedirectError } from "../src/http.js";

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

  it("sends `revoke` in the body when given, and no `revoke` key otherwise", async () => {
    stubFetch({ token: "ymmv_x", handle: "carol", github_id: 4242, revoked: true }, 200);
    await mintYmmvToken("gho_x", "ymmv_old");
    let init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ access_token: "gho_x", revoke: "ymmv_old" });
    stubFetch({ token: "ymmv_x", handle: "carol", github_id: 4242 }, 200);
    await mintYmmvToken("gho_x");
    init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ access_token: "gho_x" });
  });

  it("a confirmed retire, true or false, is a normal login: the flag itself stays on the wire", async () => {
    for (const revoked of [true, false]) {
      stubFetch({ token: "ymmv_x", handle: "carol", github_id: 4242, revoked }, 200);
      expect(await mintYmmvToken("gho_x", "ymmv_old")).toEqual({
        token: "ymmv_x",
        handle: "carol",
        github_id: 4242,
      });
      expect(fetch).toHaveBeenCalledTimes(1); // nothing to revoke: the server did it
    }
  });

  it("a retire the reply doesn't confirm (older Worker) is MintRejected: the minted token is revoked, the stored one stays", async () => {
    // A Worker without the field ignores `revoke` and mints anyway. Storing that reply would
    // strand the previous token live with no local reference left; refuse instead, like a
    // missing github_id. Copy names the next step by who runs the server (same split as whoami).
    for (const reply of [
      { token: "ymmv_x", handle: "carol", github_id: 4242 },
      { token: "ymmv_x", handle: "carol", github_id: 4242, revoked: "yes" },
    ]) {
      stubFetch(reply, 200);
      const err = await mintYmmvToken("gho_x", "ymmv_old").catch((e: Error) => e);
      expect(err).toBeInstanceOf(MintRejected);
      expect((err as Error).message).toMatch(/did not retire the previous login/);
      expect((err as Error).message).toMatch(/behind this CLI release/);
      expect((err as Error).message).toMatch(/Nothing was saved/);
      expect((err as Error).message).toMatch(/run `ymmv logout` first/); // the escape hatch
      expect(fetch).toHaveBeenCalledTimes(2); // mint + revoke of what it minted
      const [url, init] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
      expect(url).toContain("/api/v1/auth/logout");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer ymmv_x");
    }
    vi.stubEnv("YMMV_API", "https://staging.example");
    try {
      stubFetch({ token: "ymmv_x", handle: "carol", github_id: 4242 }, 200);
      await expect(mintYmmvToken("gho_x", "ymmv_old")).rejects.toThrow(
        /Point YMMV_API at an up-to-date server/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the older-Worker refusal says when the minted token could not be revoked, and stays plain when it could", async () => {
    // stubFetch hands out ONE Response: the mint parse drains it, so the revoke's body read fails
    // (same trick as the cap test below). Both facts must reach the user: the previous login is
    // still live AND so is the one just minted.
    stubFetch({ token: "ymmv_x", handle: "carol", github_id: 4242 }, 200);
    let err = await mintYmmvToken("gho_x", "ymmv_old").catch((e: Error) => e);
    expect(err).toBeInstanceOf(MintRejected);
    expect((err as Error).message).toMatch(/did not retire the previous login/);
    expect((err as Error).message).toMatch(/could not be revoked/);
    const mint = new Response(
      JSON.stringify({ token: "ymmv_x", handle: "carol", github_id: 4242 }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
    const revoked = new Response(JSON.stringify({ revoked: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mint).mockResolvedValueOnce(revoked));
    err = await mintYmmvToken("gho_x", "ymmv_old").catch((e: Error) => e);
    expect(err).toBeInstanceOf(MintRejected);
    expect((err as Error).message).toMatch(/did not retire the previous login/);
    expect((err as Error).message).not.toMatch(/could not be revoked/);
  });

  it("a token-less reply to a retire request is the plain refusal, with nothing to revoke", async () => {
    // The older-Worker diagnosis needs a usable token: with none there is no minted login to
    // strand, so the generic copy applies and no revoke request goes out.
    for (const reply of [
      { handle: "carol", github_id: 4242 },
      { token: "", handle: "carol", github_id: 4242 },
    ]) {
      stubFetch(reply, 200);
      const err = await mintYmmvToken("gho_x", "ymmv_old").catch((e: Error) => e);
      expect(err).toBeInstanceOf(MintRejected);
      expect((err as Error).message).toMatch(/Unexpected response from/);
      expect((err as Error).message).not.toMatch(/did not retire/);
      // The Worker may have committed the rotate before mangling the reply: say so.
      expect((err as Error).message).toMatch(/may have been signed out/);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("a confirmed retire never rescues an identity-less reply: still the plain refusal", async () => {
    stubFetch({ token: "ymmv_x", handle: "carol", revoked: true }, 200);
    const err = await mintYmmvToken("gho_x", "ymmv_old").catch((e: Error) => e);
    expect(err).toBeInstanceOf(MintRejected);
    expect((err as Error).message).toMatch(/Unexpected response from/);
    expect((err as Error).message).not.toMatch(/did not retire/);
    expect((err as Error).message).toMatch(/may have been signed out/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("without a `revoke`, a refused reply never claims the previous login may be gone", async () => {
    stubFetch({ token: "ymmv_x", handle: "carol" }, 200);
    const err = await mintYmmvToken("gho_x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(MintRejected);
    expect((err as Error).message).not.toMatch(/signed out/);
  });

  it("a non-JSON 200 to a retire request is still a TRANSIENT plain Error, with the sign-out hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>portal</html>", { status: 200 })),
    );
    const err = await mintYmmvToken("gho_x", "ymmv_old").catch((e: Error) => e);
    expect(err).not.toBeInstanceOf(MintRejected);
    expect((err as Error).message).toMatch(/Unexpected response from/);
    expect((err as Error).message).toMatch(/may have been signed out/);
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it("a 3xx is MintRejected naming the redirect, not `login failed: 308` (a retry draws the same)", async () => {
    // MintRejected is what makes the interactive loop exit instead of running the device flow again.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 308,
          headers: { location: "https://ymmv.fyi/api/v1/auth/token" },
        }),
      ),
    );
    const err = await mintYmmvToken("gho_x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(MintRejected);
    expect((err as Error).message).toMatch(/answered with a redirect \(308\)/);
    expect((err as Error).message).not.toContain("login failed");
    expect(fetch).toHaveBeenCalledTimes(1); // nothing minted, so nothing to revoke
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

  it("a 3xx throws a RedirectError (logout words its own copy from the type)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 308, headers: { location: "/" } })),
    );
    await expect(revokeYmmvToken("ymmv_x")).rejects.toBeInstanceOf(RedirectError);
  });

  it("a non-redirect failure stays `logout failed: <status>`, never a RedirectError", async () => {
    // logout words a RedirectError as final; a D1 hiccup must keep its "run it again" copy.
    stubFetch({ error: "internal_error" }, 500);
    const err = await revokeYmmvToken("ymmv_x").catch((e: Error) => e);
    expect(err).not.toBeInstanceOf(RedirectError);
    expect((err as Error).message).toBe("logout failed: 500");
  });

  it("under an alias base, a redirect and a can't-reach name https://ymmv.fyi, the origin actually hit", async () => {
    vi.resetModules();
    vi.stubEnv("YMMV_API", "https://www.ymmv.fyi");
    try {
      const fresh = await import("../src/auth-http.js");
      const http = await import("../src/http.js");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(null, {
            status: 308,
            headers: { location: "https://ymmv.fyi/api/v1/auth/logout" },
          }),
        ),
      );
      const err = await fresh.revokeYmmvToken("ymmv_x").catch((e: Error) => e);
      expect(err).toBeInstanceOf(http.RedirectError);
      expect((err as Error).message).toMatch(
        /^https:\/\/ymmv\.fyi answered with a redirect \(308\)/,
      );
      expect((err as Error).message).not.toContain("www.");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
      await expect(fresh.revokeYmmvToken("ymmv_x")).rejects.toThrow(
        /^Can't reach https:\/\/ymmv\.fyi\. /,
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("under a ymmv.fyi alias base, revokes over https at ymmv.fyi itself (never plain http)", async () => {
    // BASE bakes at import, so this re-imports the module graph under the alias. Only logout can
    // run there (it skips the gate); a token an older CLI stored under the alias stays revocable.
    vi.resetModules();
    vi.stubEnv("YMMV_API", "http://ymmv.fyi");
    try {
      const fresh = await import("../src/auth-http.js");
      stubFetch({ revoked: true }, 200);
      expect(await fresh.revokeYmmvToken("ymmv_x")).toBe(true);
      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://ymmv.fyi/api/v1/auth/logout");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
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

// The one identity shape-check, shared by the mint reply and whoami (the mint suite above keeps
// exercising it through mintYmmvToken, including the revoke-on-refusal that wraps it there).
describe("parseIdentity", () => {
  it("accepts a valid handle + GitHub id, and a null handle", () => {
    expect(parseIdentity({ github_id: 4242, handle: "carol" })).toEqual({
      github_id: 4242,
      handle: "carol",
    });
    expect(parseIdentity({ github_id: 50, handle: null })).toEqual({ github_id: 50, handle: null });
  });

  it("carries nothing but the two identity fields (a mint reply's token never rides along)", () => {
    expect(parseIdentity({ github_id: 1, handle: "a", token: "ymmv_x", extra: true })).toEqual({
      github_id: 1,
      handle: "a",
    });
  });

  it("sanitizes the handle BEFORE validating, so a control-char-wrapped name comes out clean", () => {
    const esc = String.fromCharCode(0x1b); // explicit code point, never a raw literal
    expect(parseIdentity({ github_id: 1, handle: `car${esc}[31mol` })).toEqual({
      github_id: 1,
      handle: "carol",
    });
  });

  it("refuses anything a real Worker never sends", () => {
    const esc = String.fromCharCode(0x1b);
    for (const bad of [
      null,
      undefined,
      "carol",
      42,
      [],
      {},
      { github_id: 4242 }, // handle absent (undefined is not null)
      { handle: "carol" }, // id absent
      { github_id: 4242, handle: "" },
      { github_id: 4242, handle: esc },
      { github_id: 4242, handle: "a/b" },
      { github_id: 4242, handle: "-bad-" },
      { github_id: 4242, handle: 7 },
      { github_id: "4242", handle: "carol" },
      { github_id: 0, handle: "carol" },
      { github_id: 1.5, handle: "carol" },
      { github_id: 2 ** 53, handle: "carol" },
    ]) {
      expect(parseIdentity(bad)).toBeNull();
    }
  });
});

describe("fetchWhoami", () => {
  const TOKEN = "ymmv_secret_bearer";
  /** Every failure path: the message must never carry the bearer. */
  async function failure(): Promise<Error> {
    const err = await fetchWhoami(TOKEN).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(TOKEN);
    return err as Error;
  }

  it("GETs /api/v1/auth/whoami with the bearer and redirect:manual, returning the identity", async () => {
    stubFetch({ github_id: 4242, handle: "carol" }, 200);
    expect(await fetchWhoami(TOKEN)).toEqual({ github_id: 4242, handle: "carol" });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/auth/whoami");
    expect(init.method).toBeUndefined(); // a GET
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("preserves a null handle (no handle bound to the account)", async () => {
    stubFetch({ github_id: 50, handle: null }, 200);
    expect(await fetchWhoami(TOKEN)).toEqual({ github_id: 50, handle: null });
  });

  it("401 names YMMV_TOKEN and the way out", async () => {
    stubFetch({ error: "unauthorized" }, 401);
    const err = await failure();
    expect(err.message).toContain("The server rejected the token in YMMV_TOKEN");
    expect(err.message).toContain("`ymmv login`");
    expect(err.message).toContain("update YMMV_TOKEN");
  });

  it("404 is diagnosed as a server without the endpoint; the next step depends on who runs it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>404</html>", { status: 404 })),
    );
    // A YMMV_API override names a Worker the user can update.
    vi.stubEnv("YMMV_API", "https://staging.example");
    let err = await failure();
    expect(err.message).toContain("has no identity lookup for YMMV_TOKEN");
    expect(err.message).toContain("Point YMMV_API at an up-to-date server.");
    // The default base is ymmv.fyi itself: never prescribe a variable the user has not set.
    vi.stubEnv("YMMV_API", "");
    err = await failure();
    expect(err.message).toContain("has no identity lookup for YMMV_TOKEN");
    expect(err.message).not.toContain("YMMV_API");
    expect(err.message).toContain("behind this CLI release");
    vi.unstubAllEnvs();
  });

  it("429 surfaces the server message + retry hint; a bodyless one falls back", async () => {
    stubFetch({ error: "rate_limited", message: "Slow down." }, 429, { "retry-after": "60" });
    expect((await failure()).message).toMatch(/Slow down.*retry in 60s/i);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("blocked", { status: 429 })));
    expect((await failure()).message).toMatch(/rate limited/i);
  });

  it("a 5xx carries the server's message when there is one, else finished retry copy with the status", async () => {
    // Every env-token command depends on this call: an outage must read as one, with a next step.
    stubFetch({ error: "internal_error", message: "D1 is having a moment." }, 503, {
      "retry-after": "30",
    });
    expect((await failure()).message).toMatch(/D1 is having a moment\..*retry in 30s/i);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 })),
    );
    const err = await failure();
    expect(err.message).toContain("couldn't look up your token (502)");
    expect(err.message).toContain("Try again shortly.");
    expect(err.message).not.toContain("<html>");
  });

  it("a redirect is a FAILURE: redirect:manual yields a non-ok response, never a followed 200", async () => {
    // What undici hands back for a 30x under redirect:"manual": the 3xx itself.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 302, headers: new Headers() }),
    );
    const err = await failure();
    expect(err).toBeInstanceOf(RedirectError);
    // Deterministic for this base: never the transient-outage copy that says to retry.
    expect(err.message).toBe(
      "https://ymmv.fyi answered with a redirect (302), which the CLI doesn't follow with your login.",
    );
    expect(err.message).not.toMatch(/try again/i);
  });

  it("a thrown fetch reads as can't-reach, never a raw TypeError", async () => {
    const thrown = new TypeError("fetch failed");
    (thrown as Error & { cause: Error }).cause = new Error("getaddrinfo ENOTFOUND ymmv.fyi");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(thrown));
    expect((await failure()).message).toMatch(/Can't reach .*Check your connection.*ENOTFOUND/);
  });

  it("a body-read TIMEOUT propagates as a timeout, never 'unexpected response'", async () => {
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
    await expect(fetchWhoami(TOKEN)).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && e.name === "TimeoutError",
    );
  });

  it("a 200 that is not JSON, or not an identity, is refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    expect((await failure()).message).toMatch(/^Unexpected response from /);
    for (const bad of [{}, { github_id: 4242 }, { github_id: "1", handle: "carol" }]) {
      stubFetch(bad, 200);
      expect((await failure()).message).toMatch(/^Unexpected response from /);
    }
  });

  it("refuses a handle that could smuggle terminal escapes or a path into a delete prompt", async () => {
    const esc = String.fromCharCode(0x1b);
    for (const handle of [`${esc}]0;pwned`, "a/b", "", "../x"]) {
      stubFetch({ github_id: 4242, handle }, 200);
      expect((await failure()).message).toMatch(/^Unexpected response from /);
    }
  });
});
