import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/token-store.js");
vi.mock("../src/auth-http.js");
vi.mock("../src/device-flow.js");

import { type Profile, SCHEMA_VERSION } from "@ymmv/shared";
import { deleteProfile, publishProfile } from "../src/api.js";
import { revokeYmmvToken } from "../src/auth-http.js";
import { login } from "../src/device-flow.js";
import { main } from "../src/index.js";
import { deleteToken, loadToken, peekBase } from "../src/token-store.js";

const PROFILE: Profile = {
  schema_version: SCHEMA_VERSION,
  handle: "carol",
  entries: [],
  extras: [],
  updated_at: "x",
};

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status: code });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe("ymmv logout", () => {
  it("revokes server-side, then deletes the local file", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.mocked(revokeYmmvToken).mockResolvedValue(true);
    await main(["logout"]);
    expect(revokeYmmvToken).toHaveBeenCalledWith("t");
    expect(deleteToken).toHaveBeenCalledTimes(1);
  });

  it("KEEPS the local token when the revoke can't reach the server", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.mocked(revokeYmmvToken).mockRejectedValue(new Error("offline"));
    await main(["logout"]);
    expect(deleteToken).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("says 'not logged in' and touches nothing when there's no token", async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    vi.mocked(peekBase).mockResolvedValue(null);
    await main(["logout"]);
    expect(revokeYmmvToken).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
  });
});

describe("publish auto-reauth", () => {
  it("on 401: deletes the token, re-logs-in, retries once", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(status(401))
      .mockResolvedValueOnce(ok({ handle: "carol" }));
    vi.stubGlobal("fetch", fetchFn);
    await publishProfile(PROFILE);
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("on 409 (stale handle): re-logs-in WITHOUT deleting, retries once with the REFRESHED handle+token", async () => {
    vi.mocked(loadToken)
      .mockResolvedValueOnce({ base: "B", token: "t", handle: "old" })
      .mockResolvedValue({ base: "B", token: "t2", handle: "new" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(status(409, { error: "handle_taken" }))
      .mockResolvedValueOnce(ok({ handle: "new" }));
    vi.stubGlobal("fetch", fetchFn);
    await publishProfile(PROFILE);
    expect(deleteToken).not.toHaveBeenCalled();
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // the retry must use the post-login credential, not the stale one
    const retryInit = fetchFn.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(retryInit.body as string).handle).toBe("new");
    expect(retryInit.headers).toMatchObject({ authorization: "Bearer t2" });
  });

  it("throws after a second auth failure (no infinite loop)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(401)));
    await expect(publishProfile(PROFILE)).rejects.toThrow(/authentication failed/i);
  });
});

describe("deleteProfile", () => {
  it("sends a bearer DELETE and succeeds on 200", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn().mockResolvedValue(ok({ ok: true }));
    vi.stubGlobal("fetch", fetchFn);
    await deleteProfile();
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({ authorization: "Bearer t" });
  });

  it("does NOT auto-reauth on 401 — throws so the user re-confirms (never deletes a switched account)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(401)));
    await expect(deleteProfile()).rejects.toThrow(/session expired|ymmv login/i);
    expect(login).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
  });

  it("throws on a non-ok status", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(500)));
    await expect(deleteProfile()).rejects.toThrow(/delete failed/);
  });
});

describe("write rate limit (429)", () => {
  const limited = () =>
    new Response(
      JSON.stringify({
        error: "rate_limited",
        message: "Too many writes — slow down and try again shortly.",
      }),
      { status: 429, headers: { "retry-after": "60" } },
    );

  it("publish surfaces the server message + retry-after (not a raw 'publish failed', no reauth loop)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(limited()));
    await expect(publishProfile(PROFILE)).rejects.toThrow(/slow down.*retry in 60s/i);
    expect(login).not.toHaveBeenCalled(); // 429 is not 401/409 — no reauth loop
  });

  it("delete surfaces the rate-limit message + retry-after", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(limited()));
    await expect(deleteProfile()).rejects.toThrow(/retry in 60s/i);
  });
});
