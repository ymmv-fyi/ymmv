import { ProfileParseError, SCHEMA_VERSION } from "@ymmv/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOwnProfile, fetchProfileJson } from "../src/api.js";
import type { Credential } from "../src/token-store.js";

// Stub the global fetch to drive fetchProfileJson's response handling (real parseProfile — the shared
// unit suite covers its branches; here we prove the CLI fetch boundary WIRES it, converting a
// malformed origin response into a typed error rather than a downstream crash).
function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

/** Stub the global fetch with one prepared Response (headers and non-JSON bodies included). */
function stubResponse(res: Response): ReturnType<typeof vi.fn> {
  const fetchFn = vi.fn().mockResolvedValue(res);
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchProfileJson", () => {
  const profile = {
    schema_version: SCHEMA_VERSION,
    handle: "carol",
    entries: [{ key: "editor", value: "Vim" }],
    extras: [],
    updated_at: "2026-06-30T00:00:00Z",
  };

  it("returns a typed Profile on a conforming 200", async () => {
    stubFetch(profile, 200);
    expect(await fetchProfileJson("carol")).toEqual(profile);
  });

  it("returns null on 404 (no profile / reserved)", async () => {
    stubFetch({}, 404);
    expect(await fetchProfileJson("ghost")).toBeNull();
  });

  it("throws a typed ProfileParseError (not a raw crash) on a malformed body", async () => {
    stubFetch({ ...profile, entries: null }, 200);
    await expect(fetchProfileJson("carol")).rejects.toThrow(ProfileParseError);
  });

  it("a network-level failure surfaces as can't-reach with the cause, never raw fetch failed", async () => {
    const netErr = new TypeError("fetch failed");
    (netErr as Error & { cause: Error }).cause = new Error("getaddrinfo ENOTFOUND ymmv.fyi");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(netErr));
    await expect(fetchProfileJson("carol")).rejects.toThrow(
      /Can't reach .*Check your connection.*ENOTFOUND/,
    );
  });
});

// The transport contract of the own-profile read: pure status/body/header mappings.
describe("fetchOwnProfile", () => {
  const CRED: Credential = {
    base: "B",
    token: "secret-token-xyz",
    handle: "carol",
    github_id: 1001,
    source: "file",
  };
  const profile = {
    schema_version: SCHEMA_VERSION,
    handle: "carol",
    entries: [{ key: "editor", value: "Vim" }],
    extras: [],
    updated_at: "2026-06-30T00:00:00.000Z",
  };
  const okRes = (headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(profile), { status: 200, headers });

  it("GETs /api/v1/profile with the bearer and redirect: manual", async () => {
    const fetchFn = stubResponse(okRes({ etag: '"2026-06-30T00:00:00.000Z"' }));
    await fetchOwnProfile(CRED);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ymmv.fyi/api/v1/profile");
    expect(init.method).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token-xyz");
    expect(init.redirect).toBe("manual");
  });

  it("returns the typed Profile with the tag built from the body stamp", async () => {
    stubResponse(okRes({ etag: '"2026-06-30T00:00:00.000Z"' }));
    expect(await fetchOwnProfile(CRED)).toEqual({
      profile,
      etag: '"2026-06-30T00:00:00.000Z"',
    });
  });

  it.each([
    ["absent", {}],
    ["blank (an edge stripped it)", { etag: "" }],
    ["weak (an edge compressed the reply)", { etag: 'W/"2026-06-30T00:00:00.000Z"' }],
    ["different from the body", { etag: '"something-else"' }],
  ])("the ETag header is never trusted: %s → the body stamp is the tag", async (_, headers) => {
    // A blank header would otherwise silently turn the write unconditional (the fail-open the
    // precondition exists to prevent); a weak one would 412 forever.
    stubResponse(okRes(headers));
    expect((await fetchOwnProfile(CRED))?.etag).toBe('"2026-06-30T00:00:00.000Z"');
  });

  it("a stamp that is not header-safe fails loudly instead of riding in If-Match", async () => {
    stubResponse(
      new Response(JSON.stringify({ ...profile, updated_at: "2026-06-30 00:00" }), {
        status: 200,
      }),
    );
    await expect(fetchOwnProfile(CRED)).rejects.toThrow(/Unexpected response from/);
  });

  it("401 on a file credential is the login instruction (no auto-reauth inside a read)", async () => {
    stubResponse(new Response("{}", { status: 401 }));
    await expect(fetchOwnProfile(CRED)).rejects.toThrow(
      "Session expired. Run `ymmv login`, then re-run the command.",
    );
  });

  it("401 on an env credential is the mint-again copy", async () => {
    stubResponse(new Response("{}", { status: 401 }));
    await expect(fetchOwnProfile({ ...CRED, source: "env" })).rejects.toThrow(/YMMV_TOKEN/);
  });

  it("refuses an unverified env credential before any request reaches the wire", async () => {
    // Only verifyEnvCredential sets an env credential's github_id, so a null one means a call
    // site skipped ensureLogin and is about to merge onto the unverified YMMV_HANDLE.
    const fetchFn = stubResponse(okRes());
    const unverified: Credential = { ...CRED, source: "env", github_id: null };
    await expect(fetchOwnProfile(unverified)).rejects.toThrow(/was not verified/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns null ONLY for the Worker's own not_found envelope", async () => {
    stubResponse(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    expect(await fetchOwnProfile(CRED)).toBeNull();
  });

  it("an old Worker's HTML 404 throws the behind-this-release diagnosis, never null, never the token", async () => {
    stubResponse(new Response("<html>Not Found</html>", { status: 404 }));
    const err = await fetchOwnProfile(CRED).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/has no profile lookup.*behind this CLI release/);
    expect((err as Error).message).not.toContain("secret-token-xyz");
  });

  it("a 404 with a different slug throws too (only not_found means no profile)", async () => {
    stubResponse(new Response(JSON.stringify({ error: "gone" }), { status: 404 }));
    await expect(fetchOwnProfile(CRED)).rejects.toThrow(/has no profile lookup/);
  });

  it("under a YMMV_API override the 404 advice points at the server the user controls", async () => {
    vi.stubEnv("YMMV_API", "https://staging.example");
    stubResponse(new Response("nope", { status: 404 }));
    await expect(fetchOwnProfile(CRED)).rejects.toThrow(/Point YMMV_API at an up-to-date server/);
  });

  it("a 429 surfaces the server message with the retry hint", async () => {
    stubResponse(
      new Response(JSON.stringify({ error: "rate_limited", message: "slow down" }), {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    );
    await expect(fetchOwnProfile(CRED)).rejects.toThrow(/slow down \(retry in 7s\)/);
  });

  it("a 5xx throws fetch failed with the status (the commands' abort-on-read contract)", async () => {
    stubResponse(new Response("boom", { status: 500 }));
    await expect(fetchOwnProfile(CRED)).rejects.toThrow(/fetch failed: 500 boom/);
  });

  it("a redirect under redirect: manual is a failure, never followed into a false profile", async () => {
    stubResponse(
      new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    );
    await expect(fetchOwnProfile(CRED)).rejects.toThrow(/fetch failed: 302/);
  });

  it("throws a typed ProfileParseError on a malformed body", async () => {
    stubResponse(
      new Response(JSON.stringify({ ...profile, entries: null }), {
        status: 200,
        headers: { etag: '"x"' },
      }),
    );
    await expect(fetchOwnProfile(CRED)).rejects.toThrow(ProfileParseError);
  });
});
