import { ProfileParseError, SCHEMA_VERSION } from "@ymmv/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProfileJson } from "../src/api.js";

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

afterEach(() => vi.unstubAllGlobals());

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
});
