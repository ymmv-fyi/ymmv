import { env } from "cloudflare:test";
import { SCHEMA_VERSION } from "@ymmv/shared";
import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/lib/auth.ts";
import { handleBindStatements } from "../src/lib/users.ts";
import { POST as LOGOUT } from "../src/pages/api/v1/auth/logout.ts";
import { POST as MINT } from "../src/pages/api/v1/auth/token.ts";
import { GET as WHOAMI } from "../src/pages/api/v1/auth/whoami.ts";
import { DELETE as DELETE_PROFILE, POST as PUBLISH } from "../src/pages/api/v1/profile.ts";

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

function whoamiCtx(token: string | null): APIContext {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return {
    request: new Request("https://ymmv.test/api/v1/auth/whoami", { headers }),
  } as unknown as APIContext;
}

function deleteCtx(token: string): APIContext {
  return {
    request: new Request("https://ymmv.test/api/v1/profile", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
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

type MintBody = { token: string; handle: string | null; github_id: number; revoked?: boolean };

async function mint(accessToken = "gho_valid", revoke?: string): Promise<MintBody> {
  const body = { access_token: accessToken, ...(revoke === undefined ? {} : { revoke }) };
  return (await (await MINT(mintCtx(body))).json()) as MintBody;
}

/** How many token rows (live or revoked) and users rows one account has. */
async function accountRows(githubId: number): Promise<{ tokens: number; users: number }> {
  const [tokens, users] = await env.DB.batch<{ n: number }>(
    ["tokens", "users"].map((table) =>
      env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE github_id = ?`).bind(githubId),
    ),
  );
  return { tokens: tokens?.results[0]?.n ?? -1, users: users?.results[0]?.n ?? -1 };
}

async function activeTokens(githubId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tokens WHERE github_id = ? AND revoked_at IS NULL",
  )
    .bind(githubId)
    .first<{ n: number }>();
  if (!row) throw new Error("COUNT(*) returned no row");
  return row.n;
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
    const body = (await res.json()) as MintBody;
    expect(body.handle).toBe("carol");
    expect(body.github_id).toBe(4242); // the identity the token row below is bound to
    expect(body.token.startsWith("ymmv_")).toBe(true);
    expect(body).not.toHaveProperty("revoked"); // present iff the request carried `revoke`
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
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("github_unavailable");
      // serverMessage() prints this verbatim in the terminal — copy rules: no em dash.
      expect(body.message).toBeTruthy();
      expect(body.message).not.toContain("—");
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
    // A JSON null or primitive body destructures as "no fields", never a crash on the read.
    for (const raw of ["null", "42", '"gho_x"']) {
      const res = await MINT(mintCtx(raw));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("missing_access_token");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("400 bad_json", async () => {
    stubGithub(() => introspectOk(1, "x"));
    expect((await MINT(mintCtx("{not json"))).status).toBe(400);
  });

  it("400 bad_revoke on a present-but-unusable revoke, without calling GitHub or minting", async () => {
    const fetchFn = stubGithub(() => introspectOk(1, "x"));
    for (const revoke of ["", "  \n", 42, null, { token: "x" }]) {
      const res = await MINT(mintCtx({ access_token: "gho_valid", revoke }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("bad_revoke");
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it("reserved GitHub username → handle:null, token still minted", async () => {
    stubGithub(() => introspectOk(50, "login")); // "login" is a reserved route/verb
    const { token, handle, github_id } = await mint();
    expect(handle).toBeNull();
    expect(github_id).toBe(50); // identity exists even when no handle does
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
    expect(first.github_id).toBe(4242);
    await PUBLISH(publishCtx(first.token, "carol", [{ key: "editor", value: "Vim" }]));
    const published = await env.DB.prepare(
      "SELECT updated_at, extras FROM users WHERE github_id = ?",
    )
      .bind(4242)
      .first<{ updated_at: string; extras: string }>();
    expect(published?.updated_at).not.toBeNull();

    stubGithub(() => introspectOk(4242, "caroline")); // GitHub rename
    const renamed = await mint("gho_2");
    expect(renamed.github_id).toBe(first.github_id); // the id is what survives a rename
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

  // `revoke`: the CLI's stored token, retired in the SAME D1 batch that inserts the new one, so a
  // login can't be interrupted between "new live" and "old dead" (issue #58). The CLI refuses a
  // reply without `revoked` when it sent `revoke`, so the field's presence is part of the contract.
  describe("revoke: atomic rotate of the stored token", () => {
    it("retires the named token in the mint step: revoked:true, old 401s, new works, no-store", async () => {
      stubGithub(() => introspectOk(4242, "carol"));
      const a = await mint("t1");
      const res = await MINT(mintCtx({ access_token: "t2", revoke: a.token }));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const b = (await res.json()) as MintBody;
      expect(b.revoked).toBe(true);
      expect(b.token).not.toBe(a.token);
      expect((await WHOAMI(whoamiCtx(a.token))).status).toBe(401);
      expect((await PUBLISH(publishCtx(a.token, "carol"))).status).toBe(401);
      expect((await WHOAMI(whoamiCtx(b.token))).status).toBe(200);
      expect(await activeTokens(4242)).toBe(1);
    });

    it("retires exactly the named token: the account's other sessions stay live (multi-device)", async () => {
      stubGithub(() => introspectOk(4242, "carol"));
      const laptop = await mint("t1");
      const desktop = await mint("t2");
      const relogin = await mint("t3", desktop.token);
      expect(relogin.revoked).toBe(true);
      expect((await WHOAMI(whoamiCtx(laptop.token))).status).toBe(200);
      expect((await WHOAMI(whoamiCtx(desktop.token))).status).toBe(401);
      expect(await activeTokens(4242)).toBe(2); // laptop + relogin
    });

    it("idempotent: an unknown or already-revoked revoke is revoked:false, and the mint still happens", async () => {
      stubGithub(() => introspectOk(4242, "carol"));
      const a = await mint("t1");
      await LOGOUT(logoutCtx(a.token));
      const b = await mint("t2", a.token);
      expect(b.revoked).toBe(false);
      expect((await WHOAMI(whoamiCtx(b.token))).status).toBe(200);
      const c = await mint("t3", "ymmv_never_minted");
      expect(c.revoked).toBe(false);
      expect((await WHOAMI(whoamiCtx(c.token))).status).toBe(200);
    });

    it("is unscoped by account: a stored token for a DIFFERENT github_id is retired too", async () => {
      // The file may hold another account's login (the user switched GitHub accounts). Holding
      // the raw token is the credential, exactly as for logout; scoping to the minting account
      // would strand that token live with no local reference left.
      stubGithub(() => introspectOk(1, "alice"));
      const alice = await mint("t1");
      stubGithub(() => introspectOk(2, "bob"));
      const bob = await mint("t2", alice.token);
      expect(bob.github_id).toBe(2);
      expect(bob.revoked).toBe(true);
      expect((await WHOAMI(whoamiCtx(alice.token))).status).toBe(401);
      expect((await WHOAMI(whoamiCtx(bob.token))).status).toBe(200);
    });

    it("revokes nothing when the mint itself is refused (foreign GitHub token → 401)", async () => {
      stubGithub(() => introspectOk(4242, "carol"));
      const a = await mint("t1");
      stubGithub(() => new Response("", { status: 404 }));
      const res = await MINT(mintCtx({ access_token: "gho_foreign", revoke: a.token }));
      expect(res.status).toBe(401);
      expect((await WHOAMI(whoamiCtx(a.token))).status).toBe(200); // the gate ran before the batch
      expect(await activeTokens(4242)).toBe(1);
    });

    it("normalizes `revoke` like a bearer: a stored token with stray whitespace is still retired", async () => {
      // parseBearer trims, so a padded token.json still authenticates; the retire must hash the
      // same bytes or the live row silently survives the rotate.
      stubGithub(() => introspectOk(4242, "carol"));
      const a = await mint("t1");
      const b = await mint("t2", `  ${a.token} \n`);
      expect(b.revoked).toBe(true);
      expect((await WHOAMI(whoamiCtx(a.token))).status).toBe(401);
      expect(await activeTokens(4242)).toBe(1);
    });

    it("a statement failing INSIDE the batch rolls the insert and the bind back: old token live, nothing minted", async () => {
      // The whole point of the batch. A non-atomic implementation (sequential runs) would leave
      // the new token row, or the rebound handle, behind when a later statement fails.
      stubGithub(() => introspectOk(4242, "carol"));
      const a = await mint("t1");
      stubGithub(() => introspectOk(4242, "caroline")); // this sign-in would rebind the handle
      const realBatch = env.DB.batch.bind(env.DB);
      // The revoke is the batch's last statement: swap it for one that fails.
      let batched = 0;
      const batchSpy = vi
        .spyOn(env.DB, "batch")
        .mockImplementationOnce(async (stmts: D1PreparedStatement[]) => {
          batched = stmts.length;
          return realBatch([
            ...stmts.slice(0, -1),
            env.DB.prepare("UPDATE no_such_table SET x = 1"),
          ]);
        });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await MINT(mintCtx({ access_token: "t2", revoke: a.token }));
        expect(res.status).toBe(500);
        expect(batchSpy).toHaveBeenCalledTimes(1);
      } finally {
        batchSpy.mockRestore();
        errSpy.mockRestore();
      }
      // The sabotaged batch was the whole sign-in: the bind, the token insert and the revoke.
      // (Asserted out here: the handler's catch would swallow an expect inside the mock.)
      expect(batched).toBe(handleBindStatements(env.DB, 4242, "caroline", "").length + 2);
      expect((await WHOAMI(whoamiCtx(a.token))).status).toBe(200);
      expect(await activeTokens(4242)).toBe(1); // the INSERT in the same batch was rolled back
      const user = await env.DB.prepare("SELECT handle FROM users WHERE github_id = ?")
        .bind(4242)
        .first<{ handle: string }>();
      expect(user?.handle).toBe("carol"); // and so was the bind
    });

    it("revokes nothing on a GitHub outage (503) or an unset secret (500): every gate runs before the batch", async () => {
      stubGithub(() => introspectOk(4242, "carol"));
      const a = await mint("t1");
      stubGithub(() => new Response("", { status: 503 }));
      expect((await MINT(mintCtx({ access_token: "t2", revoke: a.token }))).status).toBe(503);
      const secretEnv = env as { GITHUB_CLIENT_SECRET?: string };
      const saved = secretEnv.GITHUB_CLIENT_SECRET;
      try {
        secretEnv.GITHUB_CLIENT_SECRET = "";
        expect((await MINT(mintCtx({ access_token: "t2", revoke: a.token }))).status).toBe(500);
      } finally {
        secretEnv.GITHUB_CLIENT_SECRET = saved;
      }
      expect((await WHOAMI(whoamiCtx(a.token))).status).toBe(200);
      expect(await activeTokens(4242)).toBe(1);
    });

    it("a failed sign-in batch answers 500, leaves the old token live, and logs no token", async () => {
      stubGithub(() => introspectOk(4242, "carol"));
      const a = await mint("t1");
      const logged: unknown[][] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      // A sign-in is one batch: the handle bind, the token insert and the revoke.
      const batchSpy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async () => {
        throw new Error(`d1 down while rotating ${a.token}`);
      });
      try {
        const res = await MINT(mintCtx({ access_token: "t2", revoke: a.token }));
        expect(res.status).toBe(500);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: "internal_error" });
        expect(text).not.toContain(a.token);
        expect(JSON.stringify(logged)).not.toContain(a.token);
      } finally {
        batchSpy.mockRestore();
        errSpy.mockRestore();
      }
      expect((await WHOAMI(whoamiCtx(a.token))).status).toBe(200);
      expect(await activeTokens(4242)).toBe(1); // nothing new minted either
    });
  });

  it("login reclaims a handle another account vacated, and the reclaimer can then publish (login is authoritative)", async () => {
    stubGithub(() => introspectOk(1, "alice"));
    const g1 = await mint(); // gid1 binds alice
    expect(g1.github_id).toBe(1);
    stubGithub(() => introspectOk(1, "alice2"));
    await mint("g1b"); // gid1 renames → alice vacated (history under gid1, no live holder)
    stubGithub(() => introspectOk(2, "alice")); // gid2 now owns "alice" on GitHub
    const g2 = await mint();
    expect(g2.handle).toBe("alice");
    // Same handle string as g1's first login, different account: the exact shape a handle-only
    // client compare cannot see (issue #57). The id is the only thing that tells them apart.
    expect(g2.github_id).toBe(2);
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

  it("sign-in after a delete: a fresh users row, a new token that publishes, and the erased token's retire is revoked:false", async () => {
    stubGithub(() => introspectOk(4301, "ada"));
    const first = await mint("t1");
    await PUBLISH(publishCtx(first.token, "ada", [{ key: "editor", value: "Vim" }]));
    expect((await DELETE_PROFILE(deleteCtx(first.token))).status).toBe(200);
    expect(await accountRows(4301)).toEqual({ tokens: 0, users: 0 });

    // A CLI that still holds the erased token sends it as `revoke`. Its row no longer exists, so
    // the retire changes nothing and answers revoked:false, as it does for an already-revoked
    // row. The field is still present, which is what the CLI's login parse requires.
    const res = await MINT(mintCtx({ access_token: "t2", revoke: first.token }));
    expect(res.status).toBe(200);
    const second = (await res.json()) as MintBody;
    expect(second).toMatchObject({ handle: "ada", github_id: 4301, revoked: false });
    expect(second.token).not.toBe(first.token);

    const user = await env.DB.prepare(
      "SELECT handle, extras, updated_at FROM users WHERE github_id = ?",
    )
      .bind(4301)
      .first();
    expect(user).toEqual({ handle: "ada", extras: "[]", updated_at: null });
    expect((await WHOAMI(whoamiCtx(first.token))).status).toBe(401);
    expect(await activeTokens(4301)).toBe(1);
    expect(
      (await PUBLISH(publishCtx(second.token, "ada", [{ key: "editor", value: "Helix" }]))).status,
    ).toBe(200);
  });

  it("a sign-in is one batch, for a bound handle and for a reserved username", async () => {
    // Bind and mint in two batches would let a delete land between them: it would erase the users
    // row, and the insert would then leave a live token for the erased account.
    const batchSpy = vi.spyOn(env.DB, "batch");
    try {
      stubGithub(() => introspectOk(4302, "bea"));
      const bound = await mint("t1");
      expect(batchSpy).toHaveBeenCalledTimes(1);
      await mint("t2", bound.token);
      expect(batchSpy).toHaveBeenCalledTimes(2);
      stubGithub(() => introspectOk(51, "login"));
      expect((await mint("t3")).handle).toBeNull();
      expect(batchSpy).toHaveBeenCalledTimes(3);
    } finally {
      batchSpy.mockRestore();
    }
    expect(await accountRows(4302)).toEqual({ tokens: 2, users: 1 });
    expect(await accountRows(51)).toEqual({ tokens: 1, users: 1 });
  });

  it("reserved username + revoke: `revoked` reads the retire, not a bind statement", async () => {
    // The reserved-username bind is two statements, not four, so the retire sits at another index.
    stubGithub(() => introspectOk(52, "login"));
    const a = await mint("t1");
    expect(a.handle).toBeNull();
    expect(a).not.toHaveProperty("revoked");
    const b = await mint("t2", a.token);
    expect(b.revoked).toBe(true);
    expect((await WHOAMI(whoamiCtx(a.token))).status).toBe(401);
    expect((await mint("t3", a.token)).revoked).toBe(false);
    expect((await mint("t4", "ymmv_never_minted")).revoked).toBe(false);
  });

  it("a delete landing right after a sign-in's batch never leaves a token without its users row", async () => {
    // With the bind and the mint in two batches, this delete would land between them: the mint
    // would then insert a live token for an account with no users row.
    stubGithub(() => introspectOk(4303, "cleo"));
    const first = await mint("t1");
    const realBatch = env.DB.batch.bind(env.DB);
    let deleted: number | undefined;
    const batchSpy = vi
      .spyOn(env.DB, "batch")
      .mockImplementationOnce(async (stmts: D1PreparedStatement[]) => {
        const out = await realBatch(stmts);
        deleted = (await DELETE_PROFILE(deleteCtx(first.token))).status;
        return out;
      });
    let second: MintBody;
    try {
      second = await mint("t2");
    } finally {
      batchSpy.mockRestore();
    }
    expect(deleted).toBe(200);
    expect(await accountRows(4303)).toEqual({ tokens: 0, users: 0 });
    expect((await WHOAMI(whoamiCtx(second.token))).status).toBe(401);
  });

  it("a delete that passed auth before a sign-in and lands after it erases that sign-in too", async () => {
    // The other order of the same race. The delete's batch runs after the whole sign-in, so it
    // removes the new users row and the new token with the rest: nothing is left, and the machine
    // that just signed in is signed out.
    stubGithub(() => introspectOk(4304, "dot"));
    const first = await mint("t1");
    await PUBLISH(publishCtx(first.token, "dot", [{ key: "editor", value: "Vim" }]));
    const realBatch = env.DB.batch.bind(env.DB);
    let second: MintBody | undefined;
    const batchSpy = vi
      .spyOn(env.DB, "batch")
      .mockImplementationOnce(async (stmts: D1PreparedStatement[]) => {
        second = await mint("t2"); // another machine signs in; its batch is the real one
        return realBatch(stmts);
      });
    try {
      expect((await DELETE_PROFILE(deleteCtx(first.token))).status).toBe(200);
    } finally {
      batchSpy.mockRestore();
    }
    expect(second?.handle).toBe("dot");
    expect(await accountRows(4304)).toEqual({ tokens: 0, users: 0 });
    for (const token of [first.token, second?.token ?? ""]) {
      expect((await WHOAMI(whoamiCtx(token))).status).toBe(401);
    }
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

describe("GET /api/v1/auth/whoami — identity lookup", () => {
  async function mintThenUnstub(id: number, login: string): Promise<MintBody> {
    stubGithub(() => introspectOk(id, login));
    const minted = await mint();
    vi.unstubAllGlobals();
    return minted;
  }

  it("200 with the bound identity; no-store, no CORS, and the token is never echoed", async () => {
    const { token } = await mintThenUnstub(4242, "Carol");
    const res = await WHOAMI(whoamiCtx(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull(); // bearer endpoint, not public API
    const text = await res.text();
    expect(text).not.toContain(token);
    // Display casing, exactly as login bound it — the same value the mint returned.
    expect(JSON.parse(text)).toEqual({ github_id: 4242, handle: "Carol" });
  });

  it("200 handle:null for an account with no bound handle (reserved username)", async () => {
    const { token } = await mintThenUnstub(50, "login");
    const res = await WHOAMI(whoamiCtx(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ github_id: 50, handle: null });
  });

  it("200 handle:null after another account proves the handle (limbo), and the token stays live", async () => {
    const nine = await mintThenUnstub(9, "famous");
    await mintThenUnstub(4242, "famous"); // gid 4242 now owns "famous" on GitHub
    expect(await (await WHOAMI(whoamiCtx(nine.token))).json()).toEqual({
      github_id: 9,
      handle: null,
    });
  });

  it("401 for a missing, unknown, or revoked bearer (one answer for all three)", async () => {
    const { token } = await mintThenUnstub(11, "erin");
    expect((await WHOAMI(whoamiCtx(null))).status).toBe(401);
    const unknown = await WHOAMI(whoamiCtx("ymmv_not_a_real_token"));
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(await unknown.json()).toEqual({ error: "unauthorized" });
    await LOGOUT(logoutCtx(token));
    expect((await WHOAMI(whoamiCtx(token))).status).toBe(401);
  });

  it("500 internal_error when the lookup throws, and the log line carries no token", async () => {
    const { token } = await mintThenUnstub(12, "frank");
    const logged: unknown[][] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logged.push(a);
    });
    const dbSpy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error(`d1 down while resolving ${token}`);
    });
    try {
      const res = await WHOAMI(whoamiCtx(token));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "internal_error" });
      expect(text).not.toContain(token);
      expect(JSON.stringify(logged)).not.toContain(token);
    } finally {
      dbSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("consults neither rate-limit binding, for a live bearer or a junk one (the documented design)", async () => {
    // A limiter folded into the shared auth path would silently spend a write-budget token on
    // every CI publish (each starts with a whoami), or 429 shared CI egress IPs. Pin the choice.
    const { token } = await mintThenUnstub(13, "gina");
    const writeSpy = vi.spyOn(env.RL_WRITE, "limit");
    const authSpy = vi.spyOn(env.RL_AUTH, "limit");
    try {
      expect((await WHOAMI(whoamiCtx(token))).status).toBe(200);
      expect((await WHOAMI(whoamiCtx("ymmv_junk"))).status).toBe(401);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(authSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      authSpy.mockRestore();
    }
  });

  // authenticateRequest is a projection of the whoami lookup. Pin the LEFT JOIN: an INNER JOIN
  // would silently 401 every authed write for an account whose handle is NULL.
  it("an account with a NULL handle still authenticates writes (DELETE 200, not 401)", async () => {
    const { token } = await mintThenUnstub(50, "login");
    expect((await DELETE_PROFILE(deleteCtx(token))).status).toBe(200);
  });
});
