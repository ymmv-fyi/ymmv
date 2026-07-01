import { afterEach, describe, expect, it, vi } from "vitest";
import { githubClientSecret, verifyGithubToken } from "../src/lib/github.ts";

// Pure unit tests for the introspection helper — no D1, no handler. verifyGithubToken takes explicit
// clientId/clientSecret, so we drive every GitHub status through a global fetch stub.
const CLIENT_ID = "test-id";
const CLIENT_SECRET = "test-secret";

function stubFetch(make: () => Response | Promise<Response> | never): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => make());
  vi.stubGlobal("fetch", fn);
  return fn;
}

const introspect = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

describe("verifyGithubToken — GitHub token introspection (audience binding)", () => {
  it("200 → ok {id,login}; POSTs to /applications/{id}/token with Basic auth + version headers + body", async () => {
    const fetchFn = stubFetch(() => introspect({ user: { id: 77, login: "grace" } }));
    const r = await verifyGithubToken("gho_x", CLIENT_ID, CLIENT_SECRET);
    expect(r).toEqual({ kind: "ok", id: 77, login: "grace" });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/applications/${CLIENT_ID}/token`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    // Audience proof travels as HTTP Basic clientId:clientSecret — encoded from the args, not hardcoded.
    expect(headers.authorization).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
    expect(headers.accept).toBe("application/vnd.github+json");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    expect(JSON.parse(init.body as string)).toEqual({ access_token: "gho_x" });
  });

  it("404 (invalid / revoked / FOREIGN-audience token) → auth_failed", async () => {
    stubFetch(() => introspect("", 404));
    expect(await verifyGithubToken("gho_foreign", CLIENT_ID, CLIENT_SECRET)).toEqual({
      kind: "auth_failed",
    });
  });

  it("422 (validation / endpoint spammed) → transient, NOT auth_failed", async () => {
    stubFetch(() => introspect({ message: "spammed" }, 422));
    expect(await verifyGithubToken("x", CLIENT_ID, CLIENT_SECRET)).toEqual({ kind: "transient" });
  });

  it("401/403 (bad app credentials) → transient (operator misconfig, not the user's token)", async () => {
    stubFetch(() => introspect("", 401));
    expect(await verifyGithubToken("x", CLIENT_ID, CLIENT_SECRET)).toEqual({ kind: "transient" });
    stubFetch(() => introspect("", 403));
    expect(await verifyGithubToken("x", CLIENT_ID, CLIENT_SECRET)).toEqual({ kind: "transient" });
  });

  it("5xx and network errors → transient (a GitHub incident isn't a bad token)", async () => {
    stubFetch(() => introspect("", 503));
    expect(await verifyGithubToken("x", CLIENT_ID, CLIENT_SECRET)).toEqual({ kind: "transient" });
    stubFetch(() => {
      throw new Error("network down");
    });
    expect(await verifyGithubToken("x", CLIENT_ID, CLIENT_SECRET)).toEqual({ kind: "transient" });
  });

  it("200 with a malformed body (no user / non-number id) → transient (parser trust boundary)", async () => {
    stubFetch(() => introspect({}));
    expect(await verifyGithubToken("x", CLIENT_ID, CLIENT_SECRET)).toEqual({ kind: "transient" });
    stubFetch(() => introspect({ user: { login: "no-id" } }));
    expect(await verifyGithubToken("x", CLIENT_ID, CLIENT_SECRET)).toEqual({ kind: "transient" });
  });

  it("never logs the access token or the client secret on the error path", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => introspect("", 401));
    await verifyGithubToken("gho_supersecret", CLIENT_ID, "shhh-app-secret");
    const logged = errSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("gho_supersecret");
    expect(logged).not.toContain("shhh-app-secret");
    errSpy.mockRestore();
  });
});

describe("githubClientSecret — fail-closed guard", () => {
  it("returns the secret when present", () => {
    expect(githubClientSecret({ GITHUB_CLIENT_SECRET: "s" })).toBe("s");
  });

  it("returns null when unset, blank, or non-string (→ handler 500, never a /user fallback)", () => {
    expect(githubClientSecret({})).toBeNull();
    expect(githubClientSecret({ GITHUB_CLIENT_SECRET: "" })).toBeNull();
    expect(githubClientSecret({ GITHUB_CLIENT_SECRET: "   " })).toBeNull();
    expect(githubClientSecret({ GITHUB_CLIENT_SECRET: 123 })).toBeNull();
  });
});
