import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/token-store.js");
vi.mock("../src/auth-http.js");
vi.mock("../src/device-flow.js");

import { type Profile, SCHEMA_VERSION } from "@ymmv/shared";
import { deleteProfile, PublishRefusal, publishProfile } from "../src/api.js";
import { revokeYmmvToken } from "../src/auth-http.js";
import { login } from "../src/device-flow.js";
import { NetworkError } from "../src/http.js";
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

let logs: string[];
let errs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.join(" "));
  });
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
    // Class-truthful mock: the real revokeYmmvToken surfaces connectivity failures as safeFetch's
    // typed NetworkError — logout branches on that type, never on message text.
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.mocked(revokeYmmvToken).mockRejectedValue(new NetworkError("Can't reach B (offline)"));
    await main(["logout"]);
    expect(deleteToken).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("KEEPS the local token when the revoke times out (hung connection, not just refused)", async () => {
    // A BODY-read timeout escapes safeFetch's wrapper as the bare TimeoutError DOMException —
    // connectivity-shaped, so it must land in the couldn't-reach branch via isTimeoutError.
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.mocked(revokeYmmvToken).mockRejectedValue(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );
    await main(["logout"]);
    expect(deleteToken).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/Couldn't reach the server to revoke/);
  });

  it("tells the truth when the server was REACHED but refused the revoke (no connectivity blame)", async () => {
    // revokeYmmvToken's own throws — `logout failed: 500` (D1 hiccup) and `logout failed:
    // unexpected response` (middlebox 200) — mean the server answered. "Check your connection"
    // would misdiagnose and point at the wrong fix; the token is still kept either way.
    for (const failure of ["logout failed: 500", "logout failed: unexpected response"]) {
      vi.clearAllMocks();
      errs.length = 0;
      vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
      vi.mocked(revokeYmmvToken).mockRejectedValue(new Error(failure));
      await main(["logout"]);
      expect(deleteToken).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errs).toContain(
        "\n  The server didn't confirm the revoke. Your token is still active. " +
          "Run `ymmv logout` again shortly.",
      );
      expect(errs.join("\n")).not.toMatch(/Couldn't reach/);
      process.exitCode = undefined;
    }
  });

  it("says 'not logged in' and touches nothing when there's no token", async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    vi.mocked(peekBase).mockResolvedValue(null);
    await main(["logout"]);
    expect(revokeYmmvToken).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
    expect(logs).toContain("\n  Not logged in.");
  });

  it("names the other base when the stored token is scoped elsewhere", async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    vi.mocked(peekBase).mockResolvedValue("https://staging.example");
    await main(["logout"]);
    expect(logs).toContain(
      "\n  Not logged in to https://ymmv.fyi (a token for https://staging.example exists; " +
        "set YMMV_API to that to log out of it).",
    );
    expect(deleteToken).not.toHaveBeenCalled();
  });

  it("notes when the server had no active session for the revoked token", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.mocked(revokeYmmvToken).mockResolvedValue(false);
    await main(["logout"]);
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(logs).toContain("\n  Logged out (no active session on this server).");
  });

  it("prints the revoke-unreachable warning as an indented unit on stderr", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.mocked(revokeYmmvToken).mockRejectedValue(new NetworkError("Can't reach B (offline)"));
    await main(["logout"]);
    expect(errs).toContain(
      "\n  Couldn't reach the server to revoke. Your token is still active. " +
        "Run `ymmv logout` again when connected.",
    );
  });
});

describe("arg errors through main()", () => {
  it("prints an unknown option as an indented unit on stderr with exit 1", async () => {
    await main(["--bogus"]);
    expect(errs).toContain('\n  Unknown option "--bogus". Run `ymmv help`.');
    expect(process.exitCode).toBe(1);
  });
});

describe("ymmv login", () => {
  it("prints the next-step hint after a STANDALONE login only", async () => {
    vi.mocked(login).mockResolvedValue(undefined);
    await main(["login"]);
    expect(login).toHaveBeenCalledTimes(1);
    expect(logs).toContain("\n  next: run ymmv to publish your stack");
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
  it("on 401: explains the re-login, deletes the token, re-logs-in, retries once", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    // The context line must land BEFORE login()'s device prompt — an unexplained GitHub auth
    // challenge mid-publish reads as phishing. login is mocked to drop a marker so order is real.
    vi.mocked(login).mockImplementation(async () => {
      logs.push("<device-flow-prompt>");
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(status(401))
      .mockResolvedValueOnce(ok({ handle: "carol" }));
    vi.stubGlobal("fetch", fetchFn);
    await publishProfile(PROFILE);
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const context = logs.indexOf("\n  Session expired. Logging in again to retry the publish.");
    expect(context).toBeGreaterThanOrEqual(0);
    expect(context).toBeLessThan(logs.indexOf("<device-flow-prompt>"));
  });

  it("on 409 (stale handle): explains, re-logs-in WITHOUT deleting, then REFUSES the rebound retry", async () => {
    vi.mocked(loadToken)
      .mockResolvedValueOnce({ base: "B", token: "t", handle: "old" })
      .mockResolvedValue({ base: "B", token: "t2", handle: "new" });
    // handle_not_bound is what the server's bound-handle guard sends for a stale handle; the CLI
    // branches on the 409 status alone, never the error code.
    const fetchFn = vi.fn().mockResolvedValueOnce(status(409, { error: "handle_not_bound" }));
    vi.stubGlobal("fetch", fetchFn);
    // The caller merged this profile from a read of "old" — which after a rename may be a
    // squatter's profile. Publishing that pre-reauth merge under the newly bound "new" would be
    // a silent cross-identity write; a fresh run re-reads under "new" and merges correctly.
    await expect(publishProfile({ ...PROFILE, handle: "old" })).rejects.toThrow(
      /now binds "new".*Re-run the command/,
    );
    expect(deleteToken).not.toHaveBeenCalled();
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1); // the stale-merge retry POST never went out
    expect(logs).toContain(
      "\n  The server no longer recognizes your handle. Logging in again to retry the publish.",
    );
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

  it("a 200 with an unreadable body still reports SUCCESS (the commit already happened)", async () => {
    // A truncated/malformed success body must never resurface as a failed publish — the
    // interactive loop would falsely print "Nothing was published" for a live profile.
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    const res = await publishProfile(PROFILE);
    expect(res.handle).toBe("carol"); // login-bound fallback echo
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

  it("second 409 handle_not_bound gets HONEST post-heal copy, never the server's 'run login and retry'", async () => {
    // Same handle re-minted → the rebind guard passes → retry → 409 again → final verdict. The
    // server's handle_not_bound message says "Run `ymmv login` and retry" — but the CLI has
    // ALREADY done exactly that; parroting it would send the user in a loop. Branch on the slug
    // and tell the truth instead.
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        status(409, {
          error: "handle_not_bound",
          message: "Publish uses the handle bound at login. Run `ymmv login` and retry.",
        }),
      ),
    );
    const err = await publishProfile(PROFILE).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/still refuses this handle after a fresh login/);
    expect((err as Error).message).not.toMatch(/Run `ymmv login`/);
    // PublishRefusal is the interactive loop's discriminator: as a plain Error, a repeated `y`
    // would replay the whole heal (device flow + POST) against a deterministic 409.
    expect(err).toBeInstanceOf(PublishRefusal);
    expect(login).toHaveBeenCalledTimes(1); // exactly one heal attempt
  });

  it("the deep refusal sites throw PublishRefusal, not plain Error (the loop's exit contract)", async () => {
    // Message-text pins alone would keep passing if a site regressed to `throw new Error` — and
    // the interactive loop would then politely re-offer a retry that can never succeed.
    // Rebound-after-401 site:
    vi.mocked(loadToken)
      .mockResolvedValueOnce({ base: "B", token: "t", handle: "carol" })
      .mockResolvedValue({ base: "B", token: "t2", handle: "mallory" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(401)));
    await expect(publishProfile(PROFILE)).rejects.toBeInstanceOf(PublishRefusal);
    // Post-retry second-401 site:
    vi.clearAllMocks();
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(401)));
    await expect(publishProfile(PROFILE)).rejects.toBeInstanceOf(PublishRefusal);
  });

  it("second 409 with a message-less handle_not_bound body gets the same honest copy", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(409, { error: "handle_not_bound" })));
    await expect(publishProfile(PROFILE)).rejects.toThrow(
      /still refuses this handle after a fresh login/,
    );
  });

  it("second 409 with a DIFFERENT slug keeps that server message (only handle_not_bound is stale advice)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          status(409, { error: "handle_reused", message: "That handle moved to a new account." }),
        ),
    );
    await expect(publishProfile(PROFILE)).rejects.toThrow(/That handle moved to a new account/);
  });

  it("second 409 with a non-JSON or non-string-message body falls back too", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>proxy</html>", { status: 409 })),
    );
    await expect(publishProfile(PROFILE)).rejects.toThrow(/handle is taken by another account/);
    vi.mocked(login).mockClear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(409, { message: 123 })));
    await expect(publishProfile(PROFILE)).rejects.toThrow(/handle is taken by another account/);
  });

  it("sanitizes and caps a hostile second-409 message before it reaches the terminal", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    const esc = String.fromCharCode(0x1b);
    const hostile = `bad ${esc}[2Jcopy ${"x".repeat(500)}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(409, { message: hostile })));
    const err = await publishProfile(PROFILE).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(esc);
    expect((err as Error).message.length).toBeLessThanOrEqual(201); // wireText cap + ellipsis
    expect((err as Error).message).toMatch(/^bad copy/);
  });

  it("a generic POST failure surfaces as publish failed with status and capped body", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    await expect(publishProfile(PROFILE)).rejects.toThrow(/publish failed: 500 boom/);
  });

  it("a generic POST failure with a {message} body surfaces the server's copy, not the dump", async () => {
    // The server's 4xx bodies carry curated human copy (422 caps, 400 schema upgrade); wrapping
    // it in `publish failed: 422 {...}` JSON noise defeats the point of writing it.
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          status(422, { error: "value_too_long", message: "Values are capped at 256 characters." }),
        ),
    );
    const err = await publishProfile(PROFILE).catch((e: Error) => e);
    expect((err as Error).message).toBe("Values are capped at 256 characters.");
    expect((err as Error).message).not.toMatch(/publish failed/);
  });

  it("a schema-rejection 400 surfaces the upgrade instruction AS a refusal (no retry loop)", async () => {
    // First-publish path: the read 404s (no profile), so the stale CLI reaches the POST and gets
    // the 400. No edit can change the compiled SCHEMA_VERSION — the interactive loop must exit.
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        status(400, {
          error: "unsupported_schema_version",
          expected: 2,
          got: 1,
          message: "Upgrade the ymmv CLI (npm i -g ymmv-cli).",
        }),
      ),
    );
    const err = await publishProfile(PROFILE).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^Upgrade the ymmv CLI \(npm i -g ymmv-cli\)\.$/);
    expect(err).toBeInstanceOf(PublishRefusal);
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

  it("surfaces a {message} body instead of the raw dump (same rule as publish)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(status(422, { error: "nope", message: "The server said why." })),
    );
    const err = await deleteProfile().catch((e: Error) => e);
    expect((err as Error).message).toBe("The server said why.");
    expect((err as Error).message).not.toMatch(/delete failed/);
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

  it("drops the retry hint when retry-after is not the seconds form (HTTP-date)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "carol" });
    const dated = new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "retry-after": "Thu, 03 Jul 2026 04:00:00 GMT" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(dated));
    const err = await publishProfile(PROFILE).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/rate limited/i);
    expect((err as Error).message).not.toContain("retry in");
  });
});
