import { env } from "cloudflare:test";
import { SCHEMA_VERSION } from "@ymmv/shared";
import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/lib/auth.ts";
import { POST as LOGOUT } from "../src/pages/api/v1/auth/logout.ts";
import { POST as MINT } from "../src/pages/api/v1/auth/token.ts";
import { POST as PUBLISH } from "../src/pages/api/v1/profile.ts";

// The mint handler runs in the SAME workerd isolate as the test, so a global fetch stub intercepts
// its outbound token-introspection call to api.github.com/applications/{client_id}/token.
function stubGithub(handler: (url: string) => Response) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    return handler(url);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// GitHub token introspection (POST /applications/{id}/token) nests the owner under `user` on a 200.
const introspectOk = (id: number, login: string): Response =>
  new Response(JSON.stringify({ user: { id, login } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function mintCtx(body: unknown): APIContext {
  return {
    request: new Request("https://ymmv.test/api/v1/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  } as unknown as APIContext;
}

function logoutCtx(token: string | null): APIContext {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return {
    request: new Request("https://ymmv.test/api/v1/auth/logout", { method: "POST", headers }),
  } as unknown as APIContext;
}

function publishCtx(token: string, handle: string, entries: { key: string; value: string }[] = []) {
  return {
    request: new Request("https://ymmv.test/api/v1/profile", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        handle,
        entries,
        extras: [],
        updated_at: "x",
      }),
    }),
  } as unknown as APIContext;
}

async function mint(accessToken = "gho_valid"): Promise<{ token: string; handle: string | null }> {
  return (await (await MINT(mintCtx({ access_token: accessToken }))).json()) as {
    token: string;
    handle: string | null;
  };
}

// Pool storage isn't rolled back per-test here, so start each test from a clean slate (these tests
// assert on absolute row counts, e.g. "no token minted on a bad GitHub token").
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tokens"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM profile_entries"),
    env.DB.prepare("DELETE FROM handle_history"),
  ]);
});

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/v1/auth/token — mint", () => {
  it("verifies via introspection, binds the handle, mints a token (no-store)", async () => {
    const fetchFn = stubGithub(() => introspectOk(4242, "carol"));
    const res = await MINT(mintCtx({ access_token: "gho_valid" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { token: string; handle: string };
    expect(body.handle).toBe("carol");
    expect(body.token.startsWith("ymmv_")).toBe(true);
    // Verifies via introspection (audience check), not a bare /user identity read.
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/applications/"),
      expect.objectContaining({ method: "POST" }),
    );
    const introInit = fetchFn.mock.calls[0][1] as RequestInit;
    expect((introInit.headers as Record<string, string>).authorization).toMatch(/^Basic /);

    const tok = await env.DB.prepare("SELECT github_id, revoked_at FROM tokens WHERE hash = ?")
      .bind(await hashToken(body.token))
      .first<{ github_id: number; revoked_at: string | null }>();
    expect(tok).toEqual({ github_id: 4242, revoked_at: null });

    const user = await env.DB.prepare(
      "SELECT handle, handle_lower, updated_at FROM users WHERE github_id = ?",
    )
      .bind(4242)
      .first<{ handle: string; handle_lower: string; updated_at: string | null }>();
    expect(user).toEqual({ handle: "carol", handle_lower: "carol", updated_at: null }); // login != publish
  });

  // Regression: a token NOT issued to ymmv's OAuth app (leaked PAT, or phished for another app)
  // introspects as 404 → 401. Pre-fix, the Worker read /user and minted a session for the token's
  // owner (confused-deputy takeover). Assert nothing is minted AND no victim user row is squatted.
  it("401 github_auth_failed on a foreign/invalid token (introspection 404); no rows minted", async () => {
    const fetchFn = stubGithub(() => new Response("", { status: 404 }));
    const res = await MINT(mintCtx({ access_token: "gho_foreign_app_token" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("github_auth_failed");
    expect(fetchFn).toHaveBeenCalled(); // it DID call introspection (audience check), just got 404
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it("503 github_unavailable on a GitHub outage / spam-throttle (not a misleading 401)", async () => {
    // 5xx and 422 (validation/spammed) are GitHub's problem, not the user's token.
    for (const status of [503, 422]) {
      stubGithub(() => new Response("", { status }));
      const res = await MINT(mintCtx({ access_token: "gho_valid" }));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("github_unavailable");
    }
  });

  it("fail-closed: 500 when GITHUB_CLIENT_SECRET is unset — never falls back to an identity read", async () => {
    const secretEnv = env as { GITHUB_CLIENT_SECRET?: string };
    const saved = secretEnv.GITHUB_CLIENT_SECRET;
    const fetchFn = stubGithub(() => introspectOk(1, "x"));
    try {
      secretEnv.GITHUB_CLIENT_SECRET = ""; // simulate an unprovisioned secret
      const res = await MINT(mintCtx({ access_token: "gho_x" }));
      expect(res.status).toBe(500);
      expect(fetchFn).not.toHaveBeenCalled(); // never reached the outbound introspection call
      expect(
        (await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first<{ n: number }>())?.n,
      ).toBe(0);
    } finally {
      secretEnv.GITHUB_CLIENT_SECRET = saved;
    }
  });

  it("400 on missing/empty access_token, without calling GitHub", async () => {
    const fetchFn = stubGithub(() => introspectOk(1, "x"));
    expect((await MINT(mintCtx({}))).status).toBe(400);
    expect((await MINT(mintCtx({ access_token: "" }))).status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("400 bad_json", async () => {
    stubGithub(() => introspectOk(1, "x"));
    expect((await MINT(mintCtx("{not json"))).status).toBe(400);
  });

  it("reserved GitHub username → handle:null, token still minted", async () => {
    stubGithub(() => introspectOk(50, "login")); // "login" is a reserved route/verb
    const { token, handle } = await mint();
    expect(handle).toBeNull();
    expect(token.startsWith("ymmv_")).toBe(true);
    const user = await env.DB.prepare("SELECT handle FROM users WHERE github_id = ?")
      .bind(50)
      .first<{ handle: string | null }>();
    expect(user?.handle).toBeNull();
  });

  it("an all-numeric reserved GitHub username (404) → handle:null, token still minted", async () => {
    // "404" passes isValidHandle (GitHub allows all-numeric logins), so only the reserved
    // check keeps it out of the users table. Distinct from the "login"/"set" cases, which
    // are word-shaped and could pass for a verb collision test alone.
    stubGithub(() => introspectOk(404_404, "404"));
    const { token, handle } = await mint();
    expect(handle).toBeNull();
    expect(token.startsWith("ymmv_")).toBe(true);
    const user = await env.DB.prepare("SELECT handle, handle_lower FROM users WHERE github_id = ?")
      .bind(404_404)
      .first<{ handle: string | null; handle_lower: string | null }>();
    expect(user?.handle).toBeNull();
    expect(user?.handle_lower).toBeNull();
  });

  it("re-login refreshes the handle + records history, preserving a published row's updated_at/extras", async () => {
    stubGithub(() => introspectOk(4242, "carol"));
    const first = await mint();
    await PUBLISH(publishCtx(first.token, "carol", [{ key: "editor", value: "Vim" }]));
    const published = await env.DB.prepare(
      "SELECT updated_at, extras FROM users WHERE github_id = ?",
    )
      .bind(4242)
      .first<{ updated_at: string; extras: string }>();
    expect(published?.updated_at).not.toBeNull();

    stubGithub(() => introspectOk(4242, "caroline")); // GitHub rename
    await mint("gho_2");
    const after = await env.DB.prepare(
      "SELECT handle, handle_lower, updated_at, extras FROM users WHERE github_id = ?",
    )
      .bind(4242)
      .first<{ handle: string; handle_lower: string; updated_at: string; extras: string }>();
    expect(after?.handle).toBe("caroline");
    expect(after?.handle_lower).toBe("caroline");
    expect(after?.updated_at).toBe(published?.updated_at); // login didn't restamp updated_at
    expect(after?.extras).toBe(published?.extras); // login didn't clobber extras

    const hist = await env.DB.prepare(
      "SELECT github_id FROM handle_history WHERE old_handle_lower = ?",
    )
      .bind("carol")
      .first<{ github_id: number }>();
    expect(hist?.github_id).toBe(4242);
  });

  it("re-login releases a stale live holder of the handle (self-heal)", async () => {
    stubGithub(() => introspectOk(9, "famous"));
    await mint();
    stubGithub(() => introspectOk(4242, "famous")); // gid 4242 now owns "famous" on GitHub
    await mint("gho_2");
    const nine = await env.DB.prepare("SELECT handle, handle_lower FROM users WHERE github_id = ?")
      .bind(9)
      .first<{ handle: string | null; handle_lower: string | null }>();
    expect(nine?.handle).toBeNull();
    const owner = await env.DB.prepare("SELECT github_id FROM users WHERE handle_lower = ?")
      .bind("famous")
      .first<{ github_id: number }>();
    expect(owner?.github_id).toBe(4242);
  });

  it("two logins for one github_id mint two active tokens (multi-device; revoke is per-token)", async () => {
    stubGithub(() => introspectOk(4242, "carol"));
    const a = await mint("t1");
    const b = await mint("t2");
    expect(a.token).not.toBe(b.token);
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM tokens WHERE github_id = ? AND revoked_at IS NULL",
    )
      .bind(4242)
      .first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it("login reclaims a handle another account vacated, and the reclaimer can then publish (login is authoritative)", async () => {
    stubGithub(() => introspectOk(1, "alice"));
    await mint(); // gid1 binds alice
    stubGithub(() => introspectOk(1, "alice2"));
    await mint("g1b"); // gid1 renames → alice vacated (history under gid1, no live holder)
    stubGithub(() => introspectOk(2, "alice")); // gid2 now owns "alice" on GitHub
    const g2 = await mint();
    expect(g2.handle).toBe("alice");
    const owner = await env.DB.prepare("SELECT github_id FROM users WHERE handle_lower = ?")
      .bind("alice")
      .first<{ github_id: number }>();
    expect(owner?.github_id).toBe(2);

    // …and the reclaimer is not locked out: the login bind is what authorizes gid2's publish (the
    // bound-handle guard), and it also cleared the stale handle_history["alice"]={gid1} row so GET
    // resolves to gid2 instead of 301ing to gid1. (The since-removed takeover guard used to 409 the
    // new legitimate owner forever on that leftover row.)
    expect(
      (await PUBLISH(publishCtx(g2.token, "alice", [{ key: "editor", value: "Helix" }]))).status,
    ).toBe(200);
  });

  it("a reserved GitHub username displaces the user's prior handle to limbo (no stale /handle)", async () => {
    stubGithub(() => introspectOk(60, "bob"));
    await mint(); // gid60 owns "bob"
    stubGithub(() => introspectOk(60, "set")); // GitHub login becomes a reserved verb
    expect((await mint("g2")).handle).toBeNull();
    const user = await env.DB.prepare("SELECT handle, handle_lower FROM users WHERE github_id = ?")
      .bind(60)
      .first<{ handle: string | null; handle_lower: string | null }>();
    expect(user?.handle).toBeNull(); // displaced, not left as a stale "bob"
    expect(user?.handle_lower).toBeNull();
    const hist = await env.DB.prepare(
      "SELECT github_id FROM handle_history WHERE old_handle_lower = ?",
    )
      .bind("bob")
      .first<{ github_id: number }>();
    expect(hist?.github_id).toBe(60); // prior handle recorded
  });

  it("a minted token round-trips a real publish", async () => {
    stubGithub(() => introspectOk(7, "dave"));
    const { token } = await mint();
    expect(
      (await PUBLISH(publishCtx(token, "dave", [{ key: "editor", value: "Helix" }]))).status,
    ).toBe(200);
  });
});

describe("POST /api/v1/auth/logout — revoke", () => {
  async function mintThenUnstub(id: number, login: string): Promise<string> {
    stubGithub(() => introspectOk(id, login));
    const { token } = await mint();
    vi.unstubAllGlobals();
    return token;
  }

  it("401 without a bearer", async () => {
    expect((await LOGOUT(logoutCtx(null))).status).toBe(401);
  });

  it("revokes the presented token; it then fails auth; response is no-store", async () => {
    const token = await mintThenUnstub(11, "erin");
    const res = await LOGOUT(logoutCtx(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()) as { ok: boolean; revoked: boolean }).toEqual({
      ok: true,
      revoked: true,
    });
    expect((await PUBLISH(publishCtx(token, "erin"))).status).toBe(401); // token no longer authenticates
  });

  it("idempotent: a second logout returns 200 with revoked:false", async () => {
    const token = await mintThenUnstub(12, "frank");
    expect(((await (await LOGOUT(logoutCtx(token))).json()) as { revoked: boolean }).revoked).toBe(
      true,
    );
    expect(((await (await LOGOUT(logoutCtx(token))).json()) as { revoked: boolean }).revoked).toBe(
      false,
    );
  });
});
