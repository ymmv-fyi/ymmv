import { env } from "cloudflare:test";
import { SCHEMA_VERSION } from "@ymmv/shared";
import type { APIContext } from "astro";
import { beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/lib/auth.ts";
import { writeRateLimitKey } from "../src/lib/rate-limit.ts";
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
// (no D1), so even ~60 iterations are cheap.
async function exhaust(key: string, cap = 500): Promise<{ allowed: number; denied: boolean }> {
  let allowed = 0;
  for (let i = 0; i < cap; i++) {
    const { success } = await env.RL_WRITE.limit({ key });
    if (!success) return { allowed, denied: true };
    allowed++;
  }
  return { allowed, denied: false };
}

beforeEach(async () => {
  await seedToken(TOK_POST, GID_POST);
  await seedToken(TOK_DELETE, GID_DELETE);
  await seedToken(TOK_FRESH, GID_FRESH);
});

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
    const res = await POST(postCtx(TOK_FRESH, "rlfresh"));
    expect(res.status).toBe(200);
  });
});

describe("writeRateLimitKey", () => {
  it("namespaces by github_id so distinct identities never share a counter", () => {
    expect(writeRateLimitKey(42)).toBe("w:42");
    expect(writeRateLimitKey(42)).not.toBe(writeRateLimitKey(43));
  });
});
