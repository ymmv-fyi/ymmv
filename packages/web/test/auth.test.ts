import { env } from "cloudflare:test";
import { SCHEMA_VERSION } from "@ymmv/shared";
import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/lib/auth.ts";
import { POST as LOGOUT } from "../src/pages/api/v1/auth/logout.ts";
import { POST as MINT } from "../src/pages/api/v1/auth/token.ts";
import { POST as PUBLISH } from "../src/pages/api/v1/profile.ts";

// The mint handler runs in the SAME workerd isolate as the test, so a global fetch stub intercepts
// its outbound call to api.github.com/user.
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

const githubUser = (id: number, login: string): Response =>
  new Response(JSON.stringify({ id, login }), {
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
  it("verifies via /user, binds the handle, mints a token (no-store)", async () => {
    const fetchFn = stubGithub(() => githubUser(4242, "carol"));
    const res = await MINT(mintCtx({ access_token: "gho_valid" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { token: string; handle: string };
    expect(body.handle).toBe("carol");
    expect(body.token.startsWith("ymmv_")).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith("https://api.github.com/user", expect.anything());

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

  it("401 github_auth_failed on a bad GitHub token; no rows minted", async () => {
    stubGithub(() => new Response("", { status: 401 }));
    const res = await MINT(mintCtx({ access_token: "gho_bad" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("github_auth_failed");
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it("503 github_unavailable on a GitHub outage (not a misleading 401)", async () => {
    stubGithub(() => new Response("", { status: 503 }));
    const res = await MINT(mintCtx({ access_token: "gho_valid" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("github_unavailable");
  });

  it("400 on missing/empty access_token, without calling GitHub", async () => {
    const fetchFn = stubGithub(() => githubUser(1, "x"));
    expect((await MINT(mintCtx({}))).status).toBe(400);
    expect((await MINT(mintCtx({ access_token: "" }))).status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("400 bad_json", async () => {
    stubGithub(() => githubUser(1, "x"));
    expect((await MINT(mintCtx("{not json"))).status).toBe(400);
  });

  it("reserved GitHub username → handle:null, token still minted", async () => {
    stubGithub(() => githubUser(50, "login")); // "login" is a reserved route/verb
    const { token, handle } = await mint();
    expect(handle).toBeNull();
    expect(token.startsWith("ymmv_")).toBe(true);
    const user = await env.DB.prepare("SELECT handle FROM users WHERE github_id = ?")
      .bind(50)
      .first<{ handle: string | null }>();
    expect(user?.handle).toBeNull();
  });

  it("re-login refreshes the handle + records history, preserving a published row's updated_at/extras", async () => {
    stubGithub(() => githubUser(4242, "carol"));
    const first = await mint();
    await PUBLISH(publishCtx(first.token, "carol", [{ key: "editor", value: "Vim" }]));
    const published = await env.DB.prepare(
      "SELECT updated_at, extras FROM users WHERE github_id = ?",
    )
      .bind(4242)
      .first<{ updated_at: string; extras: string }>();
    expect(published?.updated_at).not.toBeNull();

    stubGithub(() => githubUser(4242, "caroline")); // GitHub rename
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
    stubGithub(() => githubUser(9, "famous"));
    await mint();
    stubGithub(() => githubUser(4242, "famous")); // gid 4242 now owns "famous" on GitHub
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
    stubGithub(() => githubUser(4242, "carol"));
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
    stubGithub(() => githubUser(1, "alice"));
    await mint(); // gid1 binds alice
    stubGithub(() => githubUser(1, "alice2"));
    await mint("g1b"); // gid1 renames → alice vacated (history under gid1, no live holder)
    stubGithub(() => githubUser(2, "alice")); // gid2 now owns "alice" on GitHub
    const g2 = await mint();
    expect(g2.handle).toBe("alice");
    const owner = await env.DB.prepare("SELECT github_id FROM users WHERE handle_lower = ?")
      .bind("alice")
      .first<{ github_id: number }>();
    expect(owner?.github_id).toBe(2);

    // …and the reclaimer is not locked out: the GitHub-proven login bind clears the stale
    // handle_history["alice"]={gid1} row, so gid2 can publish. Pre-fix that leftover row made the
    // takeover guard 409 the new legitimate owner forever (WRITE-01).
    expect(
      (await PUBLISH(publishCtx(g2.token, "alice", [{ key: "editor", value: "Helix" }]))).status,
    ).toBe(200);
  });

  it("a reserved GitHub username displaces the user's prior handle to limbo (no stale /handle)", async () => {
    stubGithub(() => githubUser(60, "bob"));
    await mint(); // gid60 owns "bob"
    stubGithub(() => githubUser(60, "set")); // GitHub login becomes a reserved verb
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
    stubGithub(() => githubUser(7, "dave"));
    const { token } = await mint();
    expect(
      (await PUBLISH(publishCtx(token, "dave", [{ key: "editor", value: "Helix" }]))).status,
    ).toBe(200);
  });
});

describe("POST /api/v1/auth/logout — revoke", () => {
  async function mintThenUnstub(id: number, login: string): Promise<string> {
    stubGithub(() => githubUser(id, login));
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
