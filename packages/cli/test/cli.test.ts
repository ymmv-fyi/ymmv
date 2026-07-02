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

describe("ymmv login", () => {
  it("prints the next-step hint after a STANDALONE login only", async () => {
    vi.mocked(login).mockResolvedValue(undefined);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    await main(["login"]);
    expect(login).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toMatch(/next: run ymmv to publish your stack/);
  });
});

describe("ymmv unset dispatch", () => {
  it("main(['unset','shell']) routes to the unset flow (GET then POST without the key)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(ok({ ...PROFILE, entries: [{ key: "shell", value: "zsh" }] })) // GET
      .mockResolvedValueOnce(ok({ handle: "carol" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await main(["unset", "shell"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const postInit = fetchFn.mock.calls[1]?.[1] as RequestInit;
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(postInit.body as string).entries).toEqual([]);
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
    // the caller merged this profile while bound to "old" — the 409 heals it via re-login
    await publishProfile({ ...PROFILE, handle: "old" });
    expect(deleteToken).not.toHaveBeenCalled();
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // the retry must use the post-login credential, not the stale one
    const retryInit = fetchFn.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(retryInit.body as string).handle).toBe("new");
    expect(retryInit.headers).toMatchObject({ authorization: "Bearer t2" });
  });

  it("refuses the FIRST send when the stored login no longer matches the merged profile", async () => {
    // a concurrent `ymmv login` swapped accounts between the caller's read and this write
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t2", handle: "mallory" });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await expect(publishProfile(PROFILE)).rejects.toThrow(/login changed/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("sanitizes the server-echoed handle in the publish result (callers print it verbatim)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    const esc = String.fromCharCode(0x1b); // explicit code point, never a raw literal
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ handle: `car${esc}[31mol` })));
    const res = await publishProfile(PROFILE);
    expect(res.handle).toBe("carol");
    expect(res.url).toMatch(/\/carol$/);
    expect(res.handle).not.toContain(esc);
  });

  it("REFUSES the 401 retry when re-login binds a DIFFERENT account (no cross-account clobber)", async () => {
    vi.mocked(loadToken)
      .mockResolvedValueOnce({ base: "B", token: "t", handle: "carol" }) // pre-send login
      .mockResolvedValue({ base: "B", token: "t2", handle: "mallory" }); // after the 401 re-login
    const fetchFn = vi.fn().mockResolvedValueOnce(status(401));
    vi.stubGlobal("fetch", fetchFn);
    await expect(publishProfile(PROFILE)).rejects.toThrow(/different account.*mallory/i);
    expect(fetchFn).toHaveBeenCalledTimes(1); // the retry POST never went out
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
