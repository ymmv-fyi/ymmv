import { env } from "cloudflare:test";
import { type Profile, SCHEMA_VERSION } from "@ymmv/shared";
import type { APIContext } from "astro";
import { beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/lib/auth.ts";
import { handleBindStatements } from "../src/lib/users.ts";
import { DELETE, POST } from "../src/pages/api/v1/profile.ts";
import { GET } from "../src/pages/api/v1/u/[handle].ts";

const TOKEN = "test-token-1";
const TOKEN2 = "test-token-2";
const GID1 = 1001;
const GID2 = 2002;

async function seedToken(token: string, githubId: number, opts: { revoked?: boolean } = {}) {
  const hash = await hashToken(token);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO tokens (hash, github_id, created_at, revoked_at) VALUES (?, ?, ?, ?)",
  )
    .bind(
      hash,
      githubId,
      "2026-06-28T00:00:00.000Z",
      opts.revoked ? "2026-06-28T01:00:00.000Z" : null,
    )
    .run();
}

function postCtx(token: string | null, body: unknown): APIContext {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return {
    request: new Request("https://ymmv.test/api/v1/profile", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  } as unknown as APIContext;
}

function getCtx(handle: string): APIContext {
  return { params: { handle } } as unknown as APIContext;
}

// Returns a plain payload object; the server overwrites updated_at, so the value here is a sentinel.
function profile(
  handle: string,
  entries: { key: string; value: string }[] = [],
  extras: { label: string; value: string }[] = [],
) {
  return {
    schema_version: SCHEMA_VERSION,
    handle,
    entries,
    extras,
    updated_at: "2000-01-01T00:00:00.000Z",
  };
}

const publish = (token: string, p: unknown) => POST(postCtx(token, p));

async function readProfile(handle: string): Promise<Profile> {
  const res = await GET(getCtx(handle));
  expect(res.status).toBe(200);
  return (await res.json()) as Profile;
}

beforeEach(async () => {
  await seedToken(TOKEN, GID1);
  await seedToken(TOKEN2, GID2);
});

describe("POST auth", () => {
  it("401 on a missing bearer", async () => {
    expect((await POST(postCtx(null, profile("alice")))).status).toBe(401);
  });
  it("401 on an unknown token", async () => {
    expect((await publish("not-a-real-token", profile("alice"))).status).toBe(401);
  });
  it("401 on a revoked token", async () => {
    await seedToken("revoked-tok", 7777, { revoked: true });
    expect((await publish("revoked-tok", profile("alice"))).status).toBe(401);
  });
  it("200 on a valid token", async () => {
    expect(
      (await publish(TOKEN, profile("alice", [{ key: "editor", value: "Neovim" }]))).status,
    ).toBe(200);
  });
});

describe("POST validation", () => {
  it("400 on bad json", async () => {
    expect((await POST(postCtx(TOKEN, "{not valid json"))).status).toBe(400);
  });
  it("400 + clear copy on schema_version mismatch (old CLI)", async () => {
    const res = await publish(TOKEN, { ...profile("alice"), schema_version: 999 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; expected: number };
    expect(body.error).toBe("unsupported_schema_version");
    expect(body.expected).toBe(SCHEMA_VERSION);
  });
  it("422 invalid handle", async () => {
    expect((await publish(TOKEN, profile("bad handle!"))).status).toBe(422);
  });
  it("422 reserved handle", async () => {
    expect((await publish(TOKEN, profile("api"))).status).toBe(422);
  });
  it("422 non-curated key", async () => {
    expect(
      (await publish(TOKEN, profile("alice", [{ key: "hairstyle", value: "mohawk" }]))).status,
    ).toBe(422);
  });
  it("422 empty/whitespace value", async () => {
    expect((await publish(TOKEN, profile("alice", [{ key: "editor", value: "   " }]))).status).toBe(
      422,
    );
  });
  it("422 value over length cap", async () => {
    expect(
      (await publish(TOKEN, profile("alice", [{ key: "editor", value: "x".repeat(257) }]))).status,
    ).toBe(422);
  });
  it("422 entries not an array", async () => {
    expect((await publish(TOKEN, { ...profile("alice"), entries: "nope" })).status).toBe(422);
  });
  it("422 too many extras", async () => {
    const extras = Array.from({ length: 33 }, (_, i) => ({ label: `l${i}`, value: "v" }));
    expect((await publish(TOKEN, profile("alice", [], extras))).status).toBe(422);
  });
  it("422 extra label/value over cap", async () => {
    expect(
      (await publish(TOKEN, profile("alice", [], [{ label: "x".repeat(65), value: "v" }]))).status,
    ).toBe(422);
  });
});

describe("publish + read round-trip", () => {
  it("round-trips entries (ordered by CURATED_KEYS) + extras", async () => {
    await publish(
      TOKEN,
      profile(
        "alice",
        [
          { key: "os", value: "Arch" }, // submitted before editor on purpose
          { key: "editor", value: "Neovim" },
        ],
        [{ label: "Launcher", value: "Raycast" }],
      ),
    );
    const p = await readProfile("alice");
    expect(p.handle).toBe("alice");
    expect(p.entries.map((e) => e.key)).toEqual(["editor", "os"]); // canonical order, not input order
    expect(p.extras).toEqual([{ label: "Launcher", value: "Raycast" }]);
    expect(typeof p.updated_at).toBe("string");
  });

  it("dedupes duplicate keys (last wins)", async () => {
    await publish(
      TOKEN,
      profile("alice", [
        { key: "editor", value: "Vim" },
        { key: "editor", value: "Neovim" },
      ]),
    );
    expect((await readProfile("alice")).entries).toEqual([{ key: "editor", value: "Neovim" }]);
  });

  it("server-stamps updated_at (ignores client) and preserves created_at across republish", async () => {
    await publish(TOKEN, profile("alice", [{ key: "editor", value: "Vim" }]));
    const first = await env.DB.prepare(
      "SELECT created_at, updated_at FROM users WHERE github_id = ?",
    )
      .bind(GID1)
      .first<{ created_at: string; updated_at: string }>();
    expect(first?.updated_at).not.toBe("2000-01-01T00:00:00.000Z");

    await publish(TOKEN, profile("alice", [{ key: "editor", value: "Neovim" }]));
    const second = await env.DB.prepare(
      "SELECT created_at, updated_at FROM users WHERE github_id = ?",
    )
      .bind(GID1)
      .first<{ created_at: string; updated_at: string }>();
    expect(second?.created_at).toBe(first?.created_at); // created_at not overwritten on republish
  });
});

describe("republish deletes removed keys (critical)", () => {
  it("a key removed on republish disappears from the read", async () => {
    await publish(
      TOKEN,
      profile("bob", [
        { key: "editor", value: "Neovim" },
        { key: "os", value: "Arch" },
      ]),
    );
    expect((await readProfile("bob")).entries.map((e) => e.key).sort()).toEqual(["editor", "os"]);

    await publish(TOKEN, profile("bob", [{ key: "editor", value: "Neovim" }]));
    expect((await readProfile("bob")).entries.map((e) => e.key)).toEqual(["editor"]);
  });
});

describe("rename + reclaim precedence", () => {
  it("rename: old handle 301s to the new one; new is live; history recorded", async () => {
    await publish(TOKEN, profile("alice", [{ key: "editor", value: "Vim" }]));
    await publish(TOKEN, profile("alice2", [{ key: "editor", value: "Vim" }])); // same github_id

    const old = await GET(getCtx("alice"));
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("/api/v1/u/alice2");
    expect((await GET(getCtx("alice2"))).status).toBe(200);

    const hist = await env.DB.prepare(
      "SELECT github_id FROM handle_history WHERE old_handle_lower = ?",
    )
      .bind("alice")
      .first<{ github_id: number }>();
    expect(hist?.github_id).toBe(GID1);
  });

  it("publish CANNOT reclaim a handle another account vacated (409) — reclaim is login-only", async () => {
    await publish(TOKEN, profile("alice", [{ key: "editor", value: "Vim" }])); // gid1 → alice
    await publish(TOKEN, profile("alice2", [{ key: "editor", value: "Vim" }])); // gid1 renames away (alice → history)
    expect((await GET(getCtx("alice"))).status).toBe(301);

    // gid2 tries to grab the vacated "alice" via a crafted publish → rejected (would hijack the 301).
    const res = await publish(TOKEN2, profile("alice", [{ key: "shell", value: "fish" }]));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("handle_taken");
    // "alice" still redirects to gid1's current handle — not hijacked (login is the only reclaim path).
    expect((await GET(getCtx("alice"))).headers.get("location")).toBe("/api/v1/u/alice2");
  });

  it("cross-account login-reclaim of a recycled handle: stale history cleared, reclaimer publishes, GET resolves to them", async () => {
    // gid 5101 owns "reclaimme", then renames away → "reclaimme" lands in handle_history under 5101.
    await seedToken("rcl-a", 5101);
    await publish("rcl-a", profile("reclaimme", [{ key: "editor", value: "Vim" }]));
    await publish("rcl-a", profile("rclnew", [{ key: "editor", value: "Vim" }]));
    // Sanity: with only the history row (no live owner), "reclaimme" 301s to 5101's current handle.
    expect((await GET(getCtx("reclaimme"))).status).toBe(301);

    // GitHub frees "reclaimme"; gid 5102 acquires it and logs in. The authoritative reclaim is the
    // GitHub-proven login bind (release:true, stampPublish:false → updated_at NULL) — the exact
    // statements POST /api/v1/auth/token runs. (The prior version of this test faked this with a direct
    // updated_at INSERT, an unreachable state that masked the bug — WRITE-02.)
    const now = new Date().toISOString();
    await env.DB.batch(
      handleBindStatements(env.DB, 5102, "reclaimme", now, { stampPublish: false, release: true }),
    );

    // The stale handle_history row from 5101 must be gone — current GitHub-proven ownership supersedes
    // it. So the freshly-reclaimed-but-unpublished handle reads as 404, NOT a 301 back to 5101 (WRITE-01,
    // redirect half).
    expect((await GET(getCtx("reclaimme"))).status).toBe(404);

    // …and 5102 can now publish it: no permanent 409 from a leftover history row (WRITE-01, publish half).
    await seedToken("rcl-b", 5102);
    expect(
      (await publish("rcl-b", profile("reclaimme", [{ key: "shell", value: "fish" }]))).status,
    ).toBe(200);

    // GET now resolves to the reclaimer's live profile, not a 301 to the prior owner.
    const res = await GET(getCtx("reclaimme"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Profile).entries).toEqual([{ key: "shell", value: "fish" }]);
  });
});

describe("handle takeover blocked (login is the authoritative binder)", () => {
  it("409 when a token claims a handle held live by another github_id; victim keeps it intact", async () => {
    await publish(TOKEN, profile("famous", [{ key: "editor", value: "Vim" }])); // gid1 holds famous live

    // gid2 (a different account) submits handle "famous". A token only proves github_id, so publish
    // refuses — a live handle only transfers through `login` (GitHub /user proof).
    const res = await publish(TOKEN2, profile("famous", [{ key: "shell", value: "fish" }]));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("handle_taken");

    // victim (gid1) still owns "famous", unchanged — not displaced to limbo.
    const owner = await env.DB.prepare("SELECT handle, handle_lower FROM users WHERE github_id = ?")
      .bind(GID1)
      .first<{ handle: string | null; handle_lower: string | null }>();
    expect(owner?.handle).toBe("famous");
    expect(owner?.handle_lower).toBe("famous");
    expect((await readProfile("famous")).entries).toEqual([{ key: "editor", value: "Vim" }]);
  });

  it("still allows claiming a FREE handle and republishing your own (the guard only blocks live foreign handles)", async () => {
    expect(
      (await publish(TOKEN2, profile("freehandle", [{ key: "shell", value: "fish" }]))).status,
    ).toBe(200);
    expect(
      (await publish(TOKEN2, profile("freehandle", [{ key: "shell", value: "zsh" }]))).status,
    ).toBe(200);
    expect((await readProfile("freehandle")).entries).toEqual([{ key: "shell", value: "zsh" }]);
  });
});

describe("GET status matrix", () => {
  it("404 unknown handle", async () => {
    expect((await GET(getCtx("nobody-here-xyz"))).status).toBe(404);
  });
  it("404 reserved handles", async () => {
    expect((await GET(getCtx("api"))).status).toBe(404);
    expect((await GET(getCtx("login"))).status).toBe(404);
  });
  it("404 when a user row exists but was never published (updated_at NULL)", async () => {
    await env.DB.prepare(
      "INSERT INTO users (github_id, handle, handle_lower, extras, updated_at, created_at) VALUES (?, ?, ?, '[]', NULL, ?)",
    )
      .bind(3003, "ghost", "ghost", "2026-06-28T00:00:00.000Z")
      .run();
    expect((await GET(getCtx("ghost"))).status).toBe(404);
  });
  it("404 when the 301 target was deleted", async () => {
    await publish(TOKEN, profile("alice", [{ key: "editor", value: "Vim" }]));
    await publish(TOKEN, profile("alice2", [{ key: "editor", value: "Vim" }])); // history alice→gid1
    await env.DB.prepare("DELETE FROM users WHERE github_id = ?").bind(GID1).run(); // hard delete
    await env.DB.prepare("DELETE FROM profile_entries WHERE github_id = ?").bind(GID1).run();
    expect((await GET(getCtx("alice"))).status).toBe(404);
  });
});

function deleteCtx(token: string | null): APIContext {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return {
    request: new Request("https://ymmv.test/api/v1/profile", { method: "DELETE", headers }),
  } as unknown as APIContext;
}
const del = (token: string) => DELETE(deleteCtx(token));

describe("DELETE — hard delete + reclaim protection", () => {
  it("401 without a token", async () => {
    expect((await DELETE(deleteCtx(null))).status).toBe(401);
  });

  it("removes the profile (404), drops the entries, and revokes the token", async () => {
    await publish(
      TOKEN,
      profile("alice", [{ key: "editor", value: "Neovim" }], [{ label: "L", value: "V" }]),
    );
    expect((await GET(getCtx("alice"))).status).toBe(200);

    expect((await del(TOKEN)).status).toBe(200);

    expect((await GET(getCtx("alice"))).status).toBe(404); // gone, not 301
    const entries = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM profile_entries WHERE github_id = ?",
    )
      .bind(GID1)
      .first<{ n: number }>();
    expect(entries?.n).toBe(0);
    // the user row is unpublished + extras cleared (so a later re-login can't resurface stale data)
    const userRow = await env.DB.prepare("SELECT extras, updated_at FROM users WHERE github_id = ?")
      .bind(GID1)
      .first<{ extras: string; updated_at: string | null }>();
    expect(userRow?.extras).toBe("[]");
    expect(userRow?.updated_at).toBeNull();
    // every token for the account is revoked → a follow-up write is unauthorized
    expect((await publish(TOKEN, profile("alice"))).status).toBe(401);
  });

  it("protects the vacated handle from a publish-squat; the owner can re-claim it", async () => {
    await publish(TOKEN, profile("alice"));
    await del(TOKEN);

    // a different account cannot grab "alice" via publish — reclaim flows through GitHub-proven login
    expect((await publish(TOKEN2, profile("alice", [{ key: "os", value: "Arch" }]))).status).toBe(
      409,
    );

    // the original owner, re-authenticated (fresh token, same github_id), republishes it freely
    await seedToken("alice-fresh", GID1);
    expect(
      (await publish("alice-fresh", profile("alice", [{ key: "os", value: "macOS" }]))).status,
    ).toBe(200);
    expect((await readProfile("alice")).entries).toEqual([{ key: "os", value: "macOS" }]);
  });
});
