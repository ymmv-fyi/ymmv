import { env } from "cloudflare:test";
import { SCHEMA_VERSION } from "@ymmv/shared";
import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/lib/auth.ts";
import { authRateLimitKey, writeRateLimitKey } from "../src/lib/rate-limit.ts";
import { handleBindStatements } from "../src/lib/users.ts";
import { POST as MINT } from "../src/pages/api/v1/auth/token.ts";
import { DELETE, POST } from "../src/pages/api/v1/profile.ts";

// The Workers rate-limit binding (RL_WRITE) emulated by miniflare/vitest-pool-workers. Its
// counter is NOT reset between tests (workers-sdk#14392), so every identity here is unique (90xxx,
// disjoint from api.test.ts / auth.test.ts) and each test keys a fresh counter — no cross-test bleed.
const GID_PROBE = 90000;
const GID_POST = 90001;
const GID_DELETE = 90002;
const GID_FRESH = 90003;

const TOK_POST = "rl-post-tok";
const TOK_DELETE = "rl-delete-tok";
const TOK_FRESH = "rl-fresh-tok";

async function seedToken(token: string, githubId: number) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO tokens (hash, github_id, created_at, revoked_at) VALUES (?, ?, ?, NULL)",
  )
    .bind(await hashToken(token), githubId, "2026-06-29T00:00:00.000Z")
    .run();
}

function postCtx(token: string, handle: string): APIContext {
  return {
    request: new Request("https://ymmv.test/api/v1/profile", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ schema_version: SCHEMA_VERSION, handle, entries: [], extras: [] }),
    }),
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

// Hammer a key until the binding denies, returning {allowed, denied}. Bounded so a misconfigured
// (never-denying) binding fails the test instead of looping forever. Each .limit() is in-memory
// (no D1), so even ~60 iterations are cheap. Defaults to RL_WRITE; pass RL_AUTH for the per-IP cap.
async function exhaust(
  key: string,
  limiter: RateLimit = env.RL_WRITE,
  cap = 500,
): Promise<{ allowed: number; denied: boolean }> {
  let allowed = 0;
  for (let i = 0; i < cap; i++) {
    const { success } = await limiter.limit({ key });
    if (!success) return { allowed, denied: true };
    allowed++;
  }
  return { allowed, denied: false };
}

// The mint handler's outbound GitHub introspection call, stubbed via the global fetch (same isolate).
// Returns the introspection 200 shape for a fixed identity.
function stubIntrospect(id: number, login: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify({ user: { id, login } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function mintCtx(accessToken: string, ip?: string): APIContext {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ip) headers["cf-connecting-ip"] = ip;
  return {
    request: new Request("https://ymmv.test/api/v1/auth/token", {
      method: "POST",
      headers,
      body: JSON.stringify({ access_token: accessToken }),
    }),
  } as unknown as APIContext;
}

// Disjoint from the profile-write ids above (90000-90003) and IPs, so the never-reset limiter counters
// don't bleed across tests (workers-sdk#14392).
const GID_MINT_CAP = 90010;
const GID_MINT_IPCAP = 90011;
const GID_MINT_OK = 90012;
const IP_MINT_CAP = "203.0.113.10";

beforeEach(async () => {
  await seedToken(TOK_POST, GID_POST);
  await seedToken(TOK_DELETE, GID_DELETE);
  await seedToken(TOK_FRESH, GID_FRESH);
});

afterEach(() => vi.unstubAllGlobals());

describe("rate limiting", () => {
  it("the RL_WRITE binding denies after its configured threshold", async () => {
    const { allowed, denied } = await exhaust(`probe:${GID_PROBE}`);
    expect(denied).toBe(true); // the binding actually limits (not a no-op stub)
    expect(allowed).toBeGreaterThan(0); // ...but lets the first writes through
  });

  it("POST /profile returns 429 once the identity's write limit is exhausted", async () => {
    // Pre-trip the SAME key the handler keys on, so the next handler call is over the limit.
    const { denied } = await exhaust(writeRateLimitKey(GID_POST));
    expect(denied).toBe(true);

    const res = await POST(postCtx(TOK_POST, "rlpost"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");

    // 429 short-circuits before any D1 write — the handle was never claimed.
    const row = await env.DB.prepare(
      "SELECT github_id FROM users WHERE handle_lower = 'rlpost'",
    ).first();
    expect(row).toBeNull();
  });

  it("DELETE /profile is rate-limited on the same per-identity write budget", async () => {
    const { denied } = await exhaust(writeRateLimitKey(GID_DELETE));
    expect(denied).toBe(true);

    const res = await DELETE(deleteCtx(TOK_DELETE));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
  });

  it("a fresh identity under the limit publishes normally (200) — limiter doesn't block real traffic", async () => {
    // Publish requires the login-bound handle, so bind first (the statements login runs).
    await env.DB.batch(
      handleBindStatements(env.DB, GID_FRESH, "rlfresh", new Date().toISOString()),
    );
    const res = await POST(postCtx(TOK_FRESH, "rlfresh"));
    expect(res.status).toBe(200);
  });
});

describe("mint rate limiting (POST /api/v1/auth/token)", () => {
  it("mint 429s once the identity's write budget is exhausted, writing nothing", async () => {
    const fetchFn = stubIntrospect(GID_MINT_CAP, "mintcap");
    // Pre-trip the SAME per-identity key the mint handler keys on (post-introspection).
    expect((await exhaust(writeRateLimitKey(GID_MINT_CAP))).denied).toBe(true);

    const res = await MINT(mintCtx("gho_x"));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
    expect(fetchFn).toHaveBeenCalled(); // identity WAS resolved — the write cap is post-introspection

    // 429 short-circuits before the D1 batch: no token AND no user/handle row for this identity.
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens WHERE github_id = ?")
          .bind(GID_MINT_CAP)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE github_id = ?")
          .bind(GID_MINT_CAP)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("mint 429s per IP BEFORE the outbound introspection call", async () => {
    const fetchFn = stubIntrospect(GID_MINT_IPCAP, "ipcap");
    expect((await exhaust(authRateLimitKey(IP_MINT_CAP), env.RL_AUTH)).denied).toBe(true);

    const res = await MINT(mintCtx("gho_x", IP_MINT_CAP));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
    expect(fetchFn).not.toHaveBeenCalled(); // IP cap short-circuits before GitHub is ever hit
  });

  it("mint with no cf-connecting-ip fails open (RL_AUTH doesn't block it)", async () => {
    stubIntrospect(GID_MINT_OK, "noip");
    const res = await MINT(mintCtx("gho_x")); // no IP header, not pre-tripped → proceeds
    expect(res.status).toBe(200);
  });
});

describe("rate-limit keys", () => {
  it("writeRateLimitKey namespaces by github_id so distinct identities never share a counter", () => {
    expect(writeRateLimitKey(42)).toBe("w:42");
    expect(writeRateLimitKey(42)).not.toBe(writeRateLimitKey(43));
  });

  it("authRateLimitKey namespaces by IP, disjoint from the write namespace (no w:/a: collision)", () => {
    expect(authRateLimitKey("1.2.3.4")).toBe("a:1.2.3.4");
    // An IP string that looks like a github_id must NOT collide with a write key.
    expect(authRateLimitKey("42")).not.toBe(writeRateLimitKey(42));
  });
});
