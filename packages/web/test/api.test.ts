import { env } from "cloudflare:test";
import { type Profile, SCHEMA_VERSION } from "@ymmv/shared";
import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/lib/auth.ts";
import { noStoreJson } from "../src/lib/json.ts";
import { handleBindStatements } from "../src/lib/users.ts";
import { DELETE, GET as OWN, POST } from "../src/pages/api/v1/profile.ts";
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

function postCtx(
  token: string | null,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIContext {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
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

/** GET /api/v1/profile — the bearer-authed own-profile read (no params: the token names the account). */
function ownCtx(token: string | null): APIContext {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return {
    request: new Request("https://ymmv.test/api/v1/profile", { headers }),
  } as unknown as APIContext;
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
/** A conditional publish: the If-Match precondition the CLI's read-modify-write commands send. */
const publishIfMatch = (token: string, p: unknown, tag: string) =>
  POST(postCtx(token, p, { "if-match": tag }));

// Login-equivalent authoritative bind (the exact statements POST /api/v1/auth/token runs after
// GitHub introspection proves the handle). Publish REQUIRES a prior bind — its bound-handle guard
// refuses any handle login didn't bind — so tests bind before they publish, like a real login does.
async function bindHandle(githubId: number, handle: string) {
  await env.DB.batch(handleBindStatements(env.DB, githubId, handle, new Date().toISOString()));
}

async function readProfile(handle: string): Promise<Profile> {
  const res = await GET(getCtx(handle));
  expect(res.status).toBe(200);
  return (await res.json()) as Profile;
}

beforeEach(async () => {
  await seedToken(TOKEN, GID1);
  await seedToken(TOKEN2, GID2);
  await bindHandle(GID1, "alice"); // most tests publish as gid1/"alice"; gid2 stays unbound
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
  it("422 reserved handle: 404 (a valid GitHub login shadowed by the static /404 route)", async () => {
    expect((await publish(TOKEN, profile("404"))).status).toBe(422);
  });
  it("422 reserved handle: version/publish (CLI verb words)", async () => {
    expect((await publish(TOKEN, profile("version"))).status).toBe(422);
    expect((await publish(TOKEN, profile("publish"))).status).toBe(422);
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
  it("422 zero-width-only entry value (invisible, but survives trim())", async () => {
    // Mirrors the extras rule: a value of only U+200B has no visible content, so it is rejected
    // like a blank one rather than stored as a blank row.
    expect((await publish(TOKEN, profile("alice", [{ key: "editor", value: "​" }]))).status).toBe(
      422,
    );
  });
  it("422 Arabic-letter-mark-only entry value (U+061C, outside any hand-rolled class)", async () => {
    // The Default_Ignorable_Code_Point property escape covers what the old literal class missed.
    expect((await publish(TOKEN, profile("alice", [{ key: "editor", value: "؜" }]))).status).toBe(
      422,
    );
  });
  it("422 variation-selector-only entry value (U+FE0F)", async () => {
    expect((await publish(TOKEN, profile("alice", [{ key: "editor", value: "️" }]))).status).toBe(
      422,
    );
  });
  it("422 control-character-only entry value (U+0001: not Default_Ignorable, still renders blank)", async () => {
    const soh = String.fromCodePoint(0x01);
    expect((await publish(TOKEN, profile("alice", [{ key: "editor", value: soh }]))).status).toBe(
      422,
    );
  });
  it("200 for a control character decorating real text — stored verbatim, not the rule's target", async () => {
    const value = `Neo${String.fromCodePoint(0x01)}vim`;
    expect((await publish(TOKEN, profile("alice", [{ key: "editor", value }]))).status).toBe(200);
  });
  it("422 non-string entry value", async () => {
    expect(
      (await publish(TOKEN, profile("alice", [{ key: "editor", value: 42 as unknown as string }])))
        .status,
    ).toBe(422);
  });
  it("200 for a padded entry value at the cap — the cap applies to the trimmed string", async () => {
    const padded = `  ${"x".repeat(256)}  `;
    expect(
      (await publish(TOKEN, profile("alice", [{ key: "editor", value: padded }]))).status,
    ).toBe(200);
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
  it("422 empty extra label/value", async () => {
    expect((await publish(TOKEN, profile("alice", [], [{ label: "", value: "" }]))).status).toBe(
      422,
    );
  });
  it("422 invisible extra names its row: the label cannot be quoted back, the ordinal can", async () => {
    const res = await publish(
      TOKEN,
      profile(
        "alice",
        [],
        [
          { label: "Keyboard", value: "HHKB" },
          { label: String.fromCodePoint(0x200b), value: "x" },
        ],
      ),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid_extra",
      message: "Extra 2 needs a visible label and value.",
    });
  });
  it("422 over-cap extra names its row and both caps", async () => {
    const res = await publish(
      TOKEN,
      profile(
        "alice",
        [],
        [
          { label: "Keyboard", value: "HHKB" },
          { label: "x".repeat(65), value: "v" },
        ],
      ),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "extra_too_long",
      message: "Extra 2 is over the cap: labels at most 64 characters, values 256.",
    });
  });
  it("422 whitespace-only extra label/value", async () => {
    expect(
      (await publish(TOKEN, profile("alice", [], [{ label: "   ", value: " " }]))).status,
    ).toBe(422);
  });
  it("422 single-sided blank extra (label set, value blank)", async () => {
    expect(
      (await publish(TOKEN, profile("alice", [], [{ label: "Launcher", value: "  " }]))).status,
    ).toBe(422);
  });
  it("422 zero-width-only extra label (invisible, but survives trim())", async () => {
    // ​ is a format char, not whitespace: "​".trim() is still length 1, so an
    // emptiness check alone stores it and the page renders a blank row.
    expect((await publish(TOKEN, profile("alice", [], [{ label: "​", value: "v" }]))).status).toBe(
      422,
    );
  });
  it("422 zero-width-only extra value", async () => {
    expect(
      (await publish(TOKEN, profile("alice", [], [{ label: "Launcher", value: "‍" }]))).status,
    ).toBe(422);
  });
  it("422 bidi-control-only extra label", async () => {
    expect((await publish(TOKEN, profile("alice", [], [{ label: "‮", value: "v" }]))).status).toBe(
      422,
    );
  });
  it("200 when an invisible char merely decorates real content", async () => {
    // Only WHOLLY invisible labels are rejected; the stored string keeps the user's bytes.
    expect(
      (await publish(TOKEN, profile("alice", [], [{ label: "Laun​cher", value: "v" }]))).status,
    ).toBe(200);
  });
  it("200 for a padded label at the cap — the cap applies to the trimmed string", async () => {
    const padded = `  ${"x".repeat(64)}  `;
    expect(
      (await publish(TOKEN, profile("alice", [], [{ label: padded, value: "v" }]))).status,
    ).toBe(200);
  });
});

describe("POST 422 messages", () => {
  // Every 422 must carry a human `message` alongside the machine `error` slug — the CLI surfaces
  // {message} verbatim, so a message-less 422 degrades to a raw JSON dump in the terminal. One
  // row per err() call site in profile.ts; a new 422 site without a message should fail here.
  //
  // Own identity: checkWriteRateLimit runs BEFORE validation and keys on github_id, so this
  // sweep's requests spend rate-limit budget even though none reaches D1. A dedicated id keeps
  // the sweep from starving GID1's budget for the suites below. No bind needed — every payload
  // 422s at validation, ahead of the bound-handle guard.
  const SWEEP_TOKEN = "test-token-sweep";
  beforeEach(async () => {
    await seedToken(SWEEP_TOKEN, 3003);
  });
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `l${i}`, value: "v" }));
  it.each<[string, unknown]>([
    ["invalid_handle", profile("bad handle!")],
    ["invalid_entries", { ...profile("alice"), entries: "nope" }],
    [
      "too_many_entries",
      profile(
        "alice",
        Array.from({ length: 51 }, () => ({ key: "editor", value: "v" })),
      ),
    ],
    ["invalid_key", profile("alice", [{ key: "hairstyle", value: "mohawk" }])],
    ["invalid_value", profile("alice", [{ key: "editor", value: 42 as unknown as string }])],
    ["invalid_value", profile("alice", [{ key: "editor", value: "​" }])],
    ["value_too_long", profile("alice", [{ key: "editor", value: "x".repeat(257) }])],
    ["invalid_extras", { ...profile("alice"), extras: "nope" }],
    ["too_many_extras", profile("alice", [], many(33))],
    ["invalid_extra", profile("alice", [], [{ label: "x" } as { label: string; value: string }])],
    ["invalid_extra", profile("alice", [], [{ label: "​", value: "v" }])],
    ["extra_too_long", profile("alice", [], [{ label: "x".repeat(65), value: "v" }])],
  ])("422 %s carries a human message", async (slug, payload) => {
    const res = await publish(SWEEP_TOKEN, payload);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe(slug);
    expect(typeof body.message).toBe("string");
    expect((body.message as string).length).toBeGreaterThan(0);
  });
  it("names the value cap", async () => {
    const res = await publish(TOKEN, profile("alice", [{ key: "editor", value: "x".repeat(257) }]));
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/capped at 256 characters/);
  });
  it("names the extras cap", async () => {
    const res = await publish(TOKEN, profile("alice", [], many(33)));
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/at most 32 extras/);
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

  it("stores extras trimmed, so a padded label never renders padded", async () => {
    await publish(TOKEN, profile("alice", [], [{ label: "  Launcher  ", value: "  Raycast  " }]));
    const p = await readProfile("alice");
    expect(p.extras).toEqual([{ label: "Launcher", value: "Raycast" }]);
  });

  it("stores entry values trimmed, so a padded value never renders padded", async () => {
    await publish(TOKEN, profile("alice", [{ key: "editor", value: "  Vim  " }]));
    expect((await readProfile("alice")).entries).toEqual([{ key: "editor", value: "Vim" }]);
  });

  it("keeps an invisible char that merely decorates a real entry value", async () => {
    // Only wholly-invisible values are rejected; a zero-width joiner inside real text is the
    // user's data and survives into the stored (trimmed) value verbatim.
    await publish(TOKEN, profile("alice", [{ key: "editor", value: "  Vi​m  " }]));
    expect((await readProfile("alice")).entries).toEqual([{ key: "editor", value: "Vi​m" }]);
  });

  it("a reserved handle 404s the JSON even when a live row exists (HTML/JSON parity)", async () => {
    // The static /404 page shadows the dynamic [handle] page, so HTML can only ever render
    // NotFound for this handle. Seed a live published row straight into D1 — the shape a
    // grandfathered claim would leave behind, which the write API now refuses to create —
    // and the read path must still refuse to serve it, or the two surfaces disagree.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO users (github_id, handle, handle_lower, extras, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        9009,
        "404",
        "404",
        '[{"label":"Launcher","value":"Raycast"}]',
        "2026-07-09T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      )
      .run();

    const res = await GET(getCtx("404"));
    expect(res.status).toBe(404);
    // Not just the status: the body must not echo the row either. resolveProfile short-circuits
    // on isReserved before it reads D1, and this pins that ordering — a refactor that reserved
    // AFTER the read would still 404 while leaking the profile in the body.
    expect(await res.text()).not.toContain("Raycast");
  });

  it("round-trips the three 13-key-taxonomy additions through POST validation", async () => {
    await publish(
      TOKEN,
      profile("alice", [
        { key: "version-manager", value: "mise" }, // submitted in reverse on purpose
        { key: "theme", value: "Gruvbox" },
        { key: "prompt", value: "Starship" },
      ]),
    );
    const p = await readProfile("alice");
    expect(p.entries.map((e) => e.key)).toEqual(["prompt", "theme", "version-manager"]);
    expect(p.entries.map((e) => e.value)).toEqual(["Starship", "Gruvbox", "mise"]);
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
    await bindHandle(GID1, "bob");
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
  it("rename (via re-login bind): old handle 301s to the new one; new is live; history recorded", async () => {
    await publish(TOKEN, profile("alice", [{ key: "editor", value: "Vim" }]));
    await bindHandle(GID1, "alice2"); // GitHub rename lands at the next login (alice → history)
    await publish(TOKEN, profile("alice2", [{ key: "editor", value: "Vim" }]));

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

  it("publish CANNOT rename — a handle the account did not bind at login is refused (409)", async () => {
    await publish(TOKEN, profile("alice", [{ key: "editor", value: "Vim" }])); // gid1 bound + publishes alice
    // "renametry" is unique to this test — D1 state persists across tests in this file, so a
    // handle another test renamed away would 301 here and fake a claim.
    const res = await publish(TOKEN, profile("renametry", [{ key: "editor", value: "Vim" }])); // same gid, unbound name
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("handle_not_bound");
    expect((await GET(getCtx("renametry"))).status).toBe(404); // nothing claimed
    expect((await GET(getCtx("alice"))).status).toBe(200); // original untouched
  });

  it("publish CANNOT reclaim a handle another account vacated (409) — reclaim is login-only", async () => {
    await publish(TOKEN, profile("alice", [{ key: "editor", value: "Vim" }])); // gid1 → alice
    await bindHandle(GID1, "alice2"); // gid1 renames away at re-login (alice → history)
    await publish(TOKEN, profile("alice2", [{ key: "editor", value: "Vim" }]));
    expect((await GET(getCtx("alice"))).status).toBe(301);

    // gid2 tries to grab the vacated "alice" via a crafted publish → rejected (would hijack the 301).
    const res = await publish(TOKEN2, profile("alice", [{ key: "shell", value: "fish" }]));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("handle_not_bound");
    // "alice" still redirects to gid1's current handle — not hijacked (login is the only reclaim path).
    expect((await GET(getCtx("alice"))).headers.get("location")).toBe("/api/v1/u/alice2");
  });

  it("cross-account login-reclaim of a recycled handle: stale history cleared, reclaimer publishes, GET resolves to them", async () => {
    // gid 5101 owns "reclaimme", then renames away (re-login bind) → history row under 5101.
    await seedToken("rcl-a", 5101);
    await bindHandle(5101, "reclaimme");
    await publish("rcl-a", profile("reclaimme", [{ key: "editor", value: "Vim" }]));
    await bindHandle(5101, "rclnew");
    await publish("rcl-a", profile("rclnew", [{ key: "editor", value: "Vim" }]));
    // Sanity: with only the history row (no live owner), "reclaimme" 301s to 5101's current handle.
    expect((await GET(getCtx("reclaimme"))).status).toBe(301);

    // GitHub frees "reclaimme"; gid 5102 acquires it and logs in. The authoritative reclaim is the
    // GitHub-proven login bind (release:true, stampPublish:false → updated_at NULL) — the exact
    // statements POST /api/v1/auth/token runs. (The prior version of this test faked this with a direct
    // updated_at INSERT, an unreachable state that masked the bug.)
    const now = new Date().toISOString();
    await env.DB.batch(handleBindStatements(env.DB, 5102, "reclaimme", now));

    // The stale handle_history row from 5101 must be gone — current GitHub-proven ownership supersedes
    // it. So the freshly-reclaimed-but-unpublished handle reads as 404, NOT a 301 back to 5101.
    expect((await GET(getCtx("reclaimme"))).status).toBe(404);

    // …and 5102 can now publish it: no permanent 409 from a leftover history row.
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
    await bindHandle(GID1, "famous");
    await publish(TOKEN, profile("famous", [{ key: "editor", value: "Vim" }])); // gid1 holds famous live

    // gid2 (a different account) submits handle "famous". A token only proves github_id, so publish
    // refuses — a live handle only transfers through `login` (GitHub /user proof).
    const res = await publish(TOKEN2, profile("famous", [{ key: "shell", value: "fish" }]));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("handle_not_bound");

    // victim (gid1) still owns "famous", unchanged — not displaced to limbo.
    const owner = await env.DB.prepare("SELECT handle, handle_lower FROM users WHERE github_id = ?")
      .bind(GID1)
      .first<{ handle: string | null; handle_lower: string | null }>();
    expect(owner?.handle).toBe("famous");
    expect(owner?.handle_lower).toBe("famous");
    expect((await readProfile("famous")).entries).toEqual([{ key: "editor", value: "Vim" }]);
  });

  it("409 when a token claims an UNCLAIMED handle it never bound — the pre-owner squat (SEC-1)", async () => {
    // gid2 has a valid token but no login bind for "torvalds"; nobody holds the handle at all.
    // Pre-guard this stored and served attacker content at /torvalds until the real owner's first
    // login self-healed it. Now publish refuses: only login (GitHub /user proof) introduces a handle.
    const unbound = await publish(TOKEN2, profile("torvalds", [{ key: "shell", value: "fish" }]));
    expect(unbound.status).toBe(409);
    expect(((await unbound.json()) as { error: string }).error).toBe("handle_not_bound");

    // Same refusal when the account IS bound — just to a different name.
    await bindHandle(GID2, "mallory");
    const mismatch = await publish(TOKEN2, profile("torvalds", [{ key: "shell", value: "fish" }]));
    expect(mismatch.status).toBe(409);

    expect((await GET(getCtx("torvalds"))).status).toBe(404); // nothing was claimed or stored
  });

  it("a login-bound handle publishes and republishes freely (the guard only demands the bind)", async () => {
    await bindHandle(GID2, "freehandle");
    expect(
      (await publish(TOKEN2, profile("freehandle", [{ key: "shell", value: "fish" }]))).status,
    ).toBe(200);
    expect(
      (await publish(TOKEN2, profile("freehandle", [{ key: "shell", value: "zsh" }]))).status,
    ).toBe(200);
    expect((await readProfile("freehandle")).entries).toEqual([{ key: "shell", value: "zsh" }]);
  });

  it("a case VARIANT of the bound handle publishes (guard compares lowercase) but cannot drift the display casing", async () => {
    // GitHub logins are case-insensitive but display-cased; login binds the exact casing. A guard
    // regression comparing raw payload to users.handle would 409 every capitalized-login user.
    await seedToken("case-tok", 6001);
    await bindHandle(6001, "CamelCase");
    const res = await publish("case-tok", profile("camelcase", [{ key: "editor", value: "Vim" }]));
    expect(res.status).toBe(200);
    // The response echoes the STORED (login-proven) casing, not the payload's.
    expect(((await res.json()) as { handle: string }).handle).toBe("CamelCase");
    expect(
      (await publish("case-tok", profile("CAMELCASE", [{ key: "os", value: "Arch" }]))).status,
    ).toBe(200);
    // Publish writes neither handle nor handle_lower — display casing stays GitHub's.
    const row = await env.DB.prepare("SELECT handle FROM users WHERE github_id = ?")
      .bind(6001)
      .first<{ handle: string }>();
    expect(row?.handle).toBe("CamelCase");
    expect((await readProfile("camelcase")).handle).toBe("CamelCase");
  });

  it("a D1 failure in the publish batch maps to 500 internal_error with a human message", async () => {
    await seedToken("boom-tok", 8001);
    await bindHandle(8001, "boomer");
    const spy = vi.spyOn(env.DB, "batch").mockRejectedValueOnce(new Error("D1_ERROR: boom"));
    const res = await publish("boom-tok", profile("boomer", [{ key: "editor", value: "Vim" }]));
    spy.mockRestore();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("internal_error");
    // Same contract as the 422 sweep: the CLI surfaces {message} verbatim, so a message-less 500
    // would print as a raw JSON dump mid-publish while the identical slug during login gets copy.
    expect(body.message).toMatch(/error saving your profile/);
  });

  it("a D1 failure in the delete batch maps to 500 internal_error with a human message", async () => {
    await seedToken("boom-del", 8002);
    await bindHandle(8002, "boomdel");
    const spy = vi.spyOn(env.DB, "batch").mockRejectedValueOnce(new Error("D1_ERROR: boom"));
    const res = await DELETE({
      request: new Request("https://ymmv.test/api/v1/profile", {
        method: "DELETE",
        headers: { authorization: "Bearer boom-del" },
      }),
    } as unknown as APIContext);
    spy.mockRestore();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("internal_error");
    expect(body.message).toMatch(/error deleting your profile/);
  });

  it("a same-handle re-bind leaves NO history row (history records renames only)", async () => {
    // Both bind statements target this: statement 1's WHERE excludes a same-handle claim, and 2b
    // clears any marker for the claimed handle. The observable invariant is what matters: re-login
    // under an unchanged GitHub login must not seed handle_history.
    await bindHandle(9101, "samesame");
    await bindHandle(9101, "samesame");
    const hist = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM handle_history WHERE old_handle_lower = ?",
    )
      .bind("samesame")
      .first<{ n: number }>();
    expect(hist?.n).toBe(0);
  });

  it("guard-to-batch race: a login rebinding the handle mid-flight no-ops the publish (409, nothing written)", async () => {
    // The bound-handle guard is a pre-read; the batch re-checks the bind in every statement (CAS).
    // Interleave a competing GitHub-proven login (gid 7002 now owns "racer") between the two by
    // wrapping the handler's batch call — the exact TOCTOU window.
    await seedToken("race-tok", 7001);
    await bindHandle(7001, "racer");
    const realBatch = env.DB.batch.bind(env.DB);
    const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (stmts) => {
      await realBatch(handleBindStatements(env.DB, 7002, "racer", new Date().toISOString()));
      return realBatch(stmts);
    });
    const res = await publish("race-tok", profile("racer", [{ key: "editor", value: "Vim" }]));
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("handle_not_bound");

    // The stale publish wrote NOTHING: gid 7002 keeps the handle, gid 7001 stays released and
    // unpublished, and no entries landed for 7001.
    const owner = await env.DB.prepare("SELECT github_id FROM users WHERE handle_lower = ?")
      .bind("racer")
      .first<{ github_id: number }>();
    expect(owner?.github_id).toBe(7002);
    const stale = await env.DB.prepare(
      "SELECT handle_lower, updated_at FROM users WHERE github_id = ?",
    )
      .bind(7001)
      .first<{ handle_lower: string | null; updated_at: string | null }>();
    expect(stale?.handle_lower).toBeNull();
    expect(stale?.updated_at).toBeNull();
    const entries = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM profile_entries WHERE github_id = ?",
    )
      .bind(7001)
      .first<{ n: number }>();
    expect(entries?.n).toBe(0);
  });
});

describe("GET status matrix", () => {
  it("404 unknown handle", async () => {
    expect((await GET(getCtx("nobody-here-xyz"))).status).toBe(404);
  });
  it("404 reserved handles", async () => {
    expect((await GET(getCtx("api"))).status).toBe(404);
    expect((await GET(getCtx("login"))).status).toBe(404);
    expect((await GET(getCtx("version"))).status).toBe(404);
    expect((await GET(getCtx("publish"))).status).toBe(404);
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
    await bindHandle(GID1, "alice2"); // rename at re-login → history alice→gid1
    await publish(TOKEN, profile("alice2", [{ key: "editor", value: "Vim" }]));
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

  it("protects the vacated handle from a publish-squat; the owner re-claims it via re-login", async () => {
    await publish(TOKEN, profile("alice"));
    await del(TOKEN);

    // a different account cannot grab "alice" via publish — reclaim flows through GitHub-proven login
    expect((await publish(TOKEN2, profile("alice", [{ key: "os", value: "Arch" }]))).status).toBe(
      409,
    );

    // delete cleared the owner's own bind too, so even THEIR publish needs the re-login first —
    // which the real flow forces anyway (delete revoked every token). Fresh login = token + bind.
    await seedToken("alice-fresh", GID1);
    expect(
      (await publish("alice-fresh", profile("alice", [{ key: "os", value: "macOS" }]))).status,
    ).toBe(409);
    await bindHandle(GID1, "alice");
    expect(
      (await publish("alice-fresh", profile("alice", [{ key: "os", value: "macOS" }]))).status,
    ).toBe(200);
    expect((await readProfile("alice")).entries).toEqual([{ key: "os", value: "macOS" }]);
  });
});

describe("GET error contract + CORS (the public read surface)", () => {
  it("404 returns the JSON envelope with content-type, ACAO, and the unchanged cache-control", async () => {
    const res = await GET(getCtx("nobody-here-xyz"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // Not just presence: the exact value pins that the envelope change didn't drop or alter the
    // short not-found TTL (a freshly published handle must appear within ~10s).
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=10, stale-while-revalidate=60",
    );
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("500 returns the JSON envelope with ACAO and no-store when D1 throws", async () => {
    const spy = vi.spyOn(env.DB, "prepare").mockImplementationOnce(() => {
      throw new Error("D1_ERROR: boom");
    });
    const res = await GET(getCtx("alice"));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // no-store: profile-read.ts contemplates a future Cache-Everything edge rule; an unmarked
    // 500 could be edge-cached and outlive the outage.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "internal_error" });
  });

  it("200 carries content-type, ACAO, and an ETag equal to the body's quoted updated_at", async () => {
    // Dedicated identity: the RL_WRITE limiter keys on github_id and its state persists across
    // tests in this file, so new tests must not spend gid1's write budget (past flake class).
    await seedToken("cors-tok", 4104);
    await bindHandle(4104, "corsy");
    await publish("cors-tok", profile("corsy", [{ key: "editor", value: "Vim" }]));
    const res = await GET(getCtx("corsy"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // The validator the write API accepts back as If-Match. Additive header, not a body change,
    // and exposed: ETag is not CORS-safelisted, so a browser reads null without the grant.
    const body = (await res.json()) as Profile;
    expect(res.headers.get("etag")).toBe(`"${body.updated_at}"`);
    expect(res.headers.get("access-control-expose-headers")).toBe("etag");
  });

  it("404 and 301 carry no ETag (only a live profile has a validator)", async () => {
    expect((await GET(getCtx("nobody-here-xyz"))).headers.get("etag")).toBeNull();
    await seedToken("etag-tok", 5201);
    await bindHandle(5201, "etagold");
    await publish("etag-tok", profile("etagold", [{ key: "editor", value: "Vim" }]));
    await bindHandle(5201, "etagnew");
    await publish("etag-tok", profile("etagnew", [{ key: "editor", value: "Vim" }]));
    const res = await GET(getCtx("etagold"));
    expect(res.status).toBe(301);
    expect(res.headers.get("etag")).toBeNull();
  });

  it("301 carries ACAO and keeps the renamed cache policy (a cross-origin fetch may observe the hop)", async () => {
    await seedToken("cors-tok2", 4105);
    await bindHandle(4105, "corsyold");
    await publish("cors-tok2", profile("corsyold", [{ key: "editor", value: "Vim" }]));
    await bindHandle(4105, "corsynew");
    await publish("cors-tok2", profile("corsynew", [{ key: "editor", value: "Vim" }]));
    const res = await GET(getCtx("corsyold"));
    expect(res.status).toBe(301);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // The 301 branch's header object was rewritten with the CORS spread; pin its cache policy
    // exactly like the 404/500 pins so dropping readCacheControl("renamed") fails a test.
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=30, stale-while-revalidate=86400",
    );
  });

  it("OPTIONS preflight gets 204 + the CORS grant (custom-header clients preflight before GET)", async () => {
    // Dynamic import so a missing export fails THIS test, not the module load for the whole file.
    const mod = (await import("../src/pages/api/v1/u/[handle].ts")) as {
      OPTIONS?: (ctx: APIContext) => Promise<Response> | Response;
    };
    expect(mod.OPTIONS).toBeDefined();
    const res = await mod.OPTIONS?.(getCtx("alice"));
    expect(res?.status).toBe(204);
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    expect(res?.headers.get("access-control-allow-methods")).toContain("GET");
    // The wildcard does not cover Authorization per the Fetch spec; it must be named for
    // browser clients whose HTTP lib attaches a default bearer.
    expect(res?.headers.get("access-control-allow-headers")).toBe("*, authorization");
  });
});

describe("live read is one atomic statement (no torn read)", () => {
  it("a live-profile GET runs exactly ONE D1 statement (owner + entries in one snapshot)", async () => {
    // Dedicated identity, same RL_WRITE-budget rationale as the CORS describe above.
    await seedToken("atomic-tok", 4106);
    await bindHandle(4106, "atomica");
    await publish(
      "atomic-tok",
      profile("atomica", [
        { key: "editor", value: "Vim" },
        { key: "os", value: "Arch" },
      ]),
    );
    const spy = vi.spyOn(env.DB, "prepare");
    const p = await readProfile("atomica");
    // Two sequential reads here reopen the mid-delete torn-200 window (a delete committing
    // between owner read and entries read served a live 200 with entries: []).
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(p.entries).toEqual([
      { key: "editor", value: "Vim" },
      { key: "os", value: "Arch" },
    ]);
  });

  it("a zero-entry live profile (extras only) still reads entries: [] through the JOIN", async () => {
    await seedToken("atomic-tok2", 4107);
    await bindHandle(4107, "extrasonly");
    await publish(
      "atomic-tok2",
      profile("extrasonly", [], [{ label: "Launcher", value: "Raycast" }]),
    );
    const spy = vi.spyOn(env.DB, "prepare");
    const p = await readProfile("extrasonly");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(p.entries).toEqual([]);
    expect(p.extras).toEqual([{ label: "Launcher", value: "Raycast" }]);
  });
});

// The read-modify-write contract (issue #56): the CLI reads its own profile through the authed,
// never-cached GET, and sends that read's ETag back as If-Match so a write built on a stale read
// can never clobber one that landed in between. Fresh github_ids throughout (RL_WRITE persists).
describe("GET /api/v1/profile — own profile (uncached RMW read)", () => {
  it("401 on a missing, unknown, or revoked bearer; no-store, no CORS", async () => {
    await seedToken("own-revoked", 5202, { revoked: true });
    for (const token of [null, "not-a-real-token", "own-revoked"]) {
      const res = await OWN(ownCtx(token));
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("404 not_found envelope for a bound-but-unpublished account and for one with no handle", async () => {
    await seedToken("own-unpub", 5203);
    await bindHandle(5203, "ownunpub");
    const unpub = await OWN(ownCtx("own-unpub"));
    expect(unpub.status).toBe(404);
    expect(unpub.headers.get("cache-control")).toBe("no-store");
    expect(await unpub.json()).toEqual({ error: "not_found" });

    await seedToken("own-nohandle", 5204); // token exists, no users row at all
    const none = await OWN(ownCtx("own-nohandle"));
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: "not_found" });

    // Handle limbo: another account proved the name at login, which clears handle/handle_lower
    // but leaves the old stamp behind. Keyed on github_id, the read must still say "no profile".
    await seedToken("own-limbo", 5219);
    await bindHandle(5219, "ownlimbo");
    await publish("own-limbo", profile("ownlimbo", [{ key: "editor", value: "Vim" }]));
    await env.DB.prepare("UPDATE users SET handle = NULL, handle_lower = NULL WHERE github_id = ?")
      .bind(5219)
      .run();
    const limbo = await OWN(ownCtx("own-limbo"));
    expect(limbo.status).toBe(404);
    expect(await limbo.json()).toEqual({ error: "not_found" });
  });

  it("200 equals the public read, with the same ETag, no-store, no CORS — and reads its own writes", async () => {
    await seedToken("own-tok", 5205);
    await bindHandle(5205, "owner");
    await publish("own-tok", profile("owner", [{ key: "editor", value: "Vim" }]));
    const res = await OWN(ownCtx("own-tok"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const own = (await res.json()) as Profile;
    expect(own).toEqual(await readProfile("owner"));
    expect(res.headers.get("etag")).toBe(`"${own.updated_at}"`);

    // Read-your-writes: a republish is visible immediately, with a new tag.
    await publish("own-tok", profile("owner", [{ key: "editor", value: "Helix" }]));
    const again = await OWN(ownCtx("own-tok"));
    const fresh = (await again.json()) as Profile;
    expect(fresh.entries).toEqual([{ key: "editor", value: "Helix" }]);
    expect(again.headers.get("etag")).not.toBe(res.headers.get("etag"));
  });

  it("500 envelope, no-store, when the PROFILE READ throws (never masked as a 404)", async () => {
    // Throw on the SECOND statement (the read), not the first (auth): a failure at the read stage
    // has 404 as its neighbour, and a masked one would make the CLI publish from scratch.
    await seedToken("own-500", 5206);
    await bindHandle(5206, "own500");
    await publish("own-500", profile("own500", [{ key: "editor", value: "Vim" }]));
    const real = env.DB.prepare.bind(env.DB);
    const spy = vi
      .spyOn(env.DB, "prepare")
      .mockImplementationOnce(real)
      .mockImplementationOnce(() => {
        throw new Error("D1_ERROR: boom");
      });
    const res = await OWN(ownCtx("own-500"));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { error: string }).error).toBe("internal_error");
  });

  it("consults neither rate-limit binding, for a live bearer or a junk one (the documented design)", async () => {
    // Same choice whoami makes, and the reason every RMW command now reads before it writes: a
    // limiter here would spend a write-budget token on each publish, or 429 shared CI egress IPs.
    // The zone WAF rule (infra/waf-ratelimit.sh names this GET) is the only cover.
    await seedToken("own-rl", 5216);
    await bindHandle(5216, "ownrl");
    await publish("own-rl", profile("ownrl", [{ key: "editor", value: "Vim" }]));
    const writeSpy = vi.spyOn(env.RL_WRITE, "limit");
    const authSpy = vi.spyOn(env.RL_AUTH, "limit");
    try {
      expect((await OWN(ownCtx("own-rl"))).status).toBe(200);
      expect((await OWN(ownCtx("ymmv_junk"))).status).toBe(401);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(authSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      authSpy.mockRestore();
    }
  });

  it("the extra headers it carries can never override no-store or the content type", async () => {
    // noStoreJson gained a `headers` argument for the ETag. It merges UNDER the fixed pair on
    // purpose: a caller that could set cache-control would make a bearer reply cacheable.
    const res = noStoreJson(
      200,
      { ok: true },
      {
        "cache-control": "public, max-age=86400",
        "content-type": "text/html",
        etag: '"x"',
      },
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("etag")).toBe('"x"');
  });
});

describe("POST If-Match precondition (RMW CAS)", () => {
  async function seedPublished(token: string, gid: number, handle: string): Promise<string> {
    await seedToken(token, gid);
    await bindHandle(gid, handle);
    await publish(token, profile(handle, [{ key: "editor", value: "Vim" }]));
    const tag = (await OWN(ownCtx(token))).headers.get("etag");
    expect(tag).toMatch(/^".+"$/);
    return tag as string;
  }

  it("a matching quoted tag (as read) publishes and advances updated_at", async () => {
    const tag = await seedPublished("im-tok1", 5207, "imatch");
    const res = await publishIfMatch(
      "im-tok1",
      profile("imatch", [{ key: "editor", value: "Helix" }]),
      tag,
    );
    expect(res.status).toBe(200);
    const after = await readProfile("imatch");
    expect(after.entries).toEqual([{ key: "editor", value: "Helix" }]);
    expect(`"${after.updated_at}"`).not.toBe(tag);
  });

  it("a bare (unquoted) tag matches too", async () => {
    const tag = await seedPublished("im-tok2", 5208, "imbare");
    const res = await publishIfMatch("im-tok2", profile("imbare"), tag.slice(1, -1));
    expect(res.status).toBe(200);
  });

  it("a stale tag → 412 precondition_failed with human copy, and NOTHING is written", async () => {
    const stale = await seedPublished("im-tok3", 5209, "imstale");
    // A competing writer lands first (unconditional, like an older CLI).
    await publish(
      "im-tok3",
      profile("imstale", [{ key: "editor", value: "Emacs" }], [{ label: "K", value: "HHKB" }]),
    );
    const between = await readProfile("imstale");
    const res = await publishIfMatch(
      "im-tok3",
      profile("imstale", [{ key: "editor", value: "Vim" }]), // the stale merge: would drop K
      stale,
    );
    expect(res.status).toBe(412);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("precondition_failed");
    expect(body.message).toMatch(/changed since this command read it/);
    // The write that landed in between survives intact: entries, extras, and the stamp.
    expect(await readProfile("imstale")).toEqual(between);
  });

  it("a tag against a bound-but-unpublished handle (updated_at NULL) → 412, nothing written", async () => {
    await seedToken("im-tok4", 5210);
    await bindHandle(5210, "imnull");
    const res = await publishIfMatch(
      "im-tok4",
      profile("imnull", [{ key: "editor", value: "Vim" }]),
      '"2026-01-01T00:00:00.000Z"',
    );
    expect(res.status).toBe(412);
    expect((await GET(getCtx("imnull"))).status).toBe(404);
  });

  it("no header stays unconditional (deployed CLIs) even after a competing publish", async () => {
    await seedPublished("im-tok5", 5211, "imuncond");
    await publish("im-tok5", profile("imuncond", [{ key: "editor", value: "Emacs" }]));
    const res = await publish("im-tok5", profile("imuncond", [{ key: "editor", value: "Vim" }]));
    expect(res.status).toBe(200);
    expect((await readProfile("imuncond")).entries).toEqual([{ key: "editor", value: "Vim" }]);
  });

  it("a blank header is no precondition at all; an empty TAG still fails closed", async () => {
    // The two halves of ifMatchTag's empty case: nothing to compare (unconditional, what a
    // deployed CLI sends) versus a tag that is the empty string, which no stamp ever equals.
    await seedPublished("im-tok9", 5217, "imblank");
    expect((await publishIfMatch("im-tok9", profile("imblank"), "   ")).status).toBe(200);
    expect((await publishIfMatch("im-tok9", profile("imblank"), '""')).status).toBe(412);
  });

  it("malformed preconditions fail closed: `*` and a list are 412", async () => {
    const tag = await seedPublished("im-tok6", 5212, "imweak");
    for (const bad of ["*", `${tag}, "other"`]) {
      expect((await publishIfMatch("im-tok6", profile("imweak"), bad)).status).toBe(412);
    }
  });

  it("a weak tag (W/) matches: an edge that compresses the read may weaken the validator", async () => {
    const tag = await seedPublished("im-tok9", 5220, "imweakok");
    const res = await publishIfMatch(
      "im-tok9",
      profile("imweakok", [{ key: "editor", value: "Helix" }]),
      `W/${tag}`,
    );
    expect(res.status).toBe(200);
    expect((await readProfile("imweakok")).entries).toEqual([{ key: "editor", value: "Helix" }]);
  });

  it("guard-to-batch race: a write landing inside the TOCTOU window → 412, and that write survives", async () => {
    // Same interleave technique as the handle-rebind race above: the competing stamp lands
    // between the handler's pre-read and its batch, i.e. after any pre-check could have seen it.
    const tag = await seedPublished("im-tok7", 5213, "imrace");
    const realBatch = env.DB.batch.bind(env.DB);
    const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (stmts) => {
      await realBatch([
        env.DB.prepare("UPDATE users SET updated_at = ? WHERE github_id = ?").bind(
          "2099-01-01T00:00:00.000Z",
          5213,
        ),
      ]);
      return realBatch(stmts);
    });
    const res = await publishIfMatch(
      "im-tok7",
      profile("imrace", [{ key: "editor", value: "Helix" }]),
      tag,
    );
    spy.mockRestore();
    expect(res.status).toBe(412);
    const after = await readProfile("imrace");
    expect(after.updated_at).toBe("2099-01-01T00:00:00.000Z");
    expect(after.entries).toEqual([{ key: "editor", value: "Vim" }]);
  });

  it("a bind moved mid-flight is still 409 handle_not_bound, even with a matching tag (409 wins)", async () => {
    // The deployed CLIs' self-heal (re-login on 409) must keep working: a moved bind is never
    // reported as a stale read, whatever the tag says.
    const tag = await seedPublished("im-tok8", 5214, "imbind");
    const realBatch = env.DB.batch.bind(env.DB);
    const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (stmts) => {
      await realBatch(handleBindStatements(env.DB, 5215, "imbind", new Date().toISOString()));
      return realBatch(stmts);
    });
    const res = await publishIfMatch(
      "im-tok8",
      profile("imbind", [{ key: "editor", value: "Helix" }]),
      tag,
    );
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("handle_not_bound");
  });
});
