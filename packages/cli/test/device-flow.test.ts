import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// Partial: transport fns mocked, MintRejected real, so the propagation api.ts branches on is pinned.
vi.mock("../src/auth-http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth-http.js")>()),
  mintYmmvToken: vi.fn(),
  revokeYmmvToken: vi.fn(),
}));
vi.mock("../src/token-store.js");
// Which programs exist is browser.test.ts's business: here the launcher is "one, or none".
vi.mock("../src/browser.js", () => ({ findLauncher: vi.fn() }));

import { MintRejected, mintYmmvToken, revokeYmmvToken } from "../src/auth-http.js";
import { findLauncher, type Launcher } from "../src/browser.js";
import { BASE } from "../src/config.js";
import { type DeviceCode, login, pollForToken, requestDeviceCode } from "../src/device-flow.js";
import { type Prompter, PrompterMisuse } from "../src/prompt.js";
import { peekCredential, saveToken } from "../src/token-store.js";

const DC: DeviceCode = {
  device_code: "dc",
  user_code: "WXYZ-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function fetchSeq(...bodies: unknown[]): typeof fetch {
  const fn = vi.fn();
  for (const b of bodies) fn.mockResolvedValueOnce(json(b));
  return fn as unknown as typeof fetch;
}

// For transient-blip tests: drive raw Response objects (non-ok status / non-JSON body) directly.
function fetchResponses(...responses: Response[]): typeof fetch {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return fn as unknown as typeof fetch;
}

const noSleep = vi.fn().mockResolvedValue(undefined);
const at0 = () => 0;

describe("pollForToken state machine", () => {
  it("resolves the access token on success", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const token = await pollForToken(DC, {
      fetch: fetchSeq({ access_token: "gho_x" }),
      sleep,
      now: at0,
    });
    expect(token).toBe("gho_x");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("keeps polling on authorization_pending", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const token = await pollForToken(DC, {
      fetch: fetchSeq({ error: "authorization_pending" }, { access_token: "gho_x" }),
      sleep,
      now: at0,
    });
    expect(token).toBe("gho_x");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("honors slow_down backoff (+5s)", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await pollForToken(DC, {
      fetch: fetchSeq({ error: "slow_down" }, { access_token: "gho_x" }),
      sleep,
      now: at0,
    });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 10000]);
  });

  it("honors a larger server-sent interval on slow_down", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await pollForToken(DC, {
      fetch: fetchSeq({ error: "slow_down", interval: 30 }, { access_token: "gho_x" }),
      sleep,
      now: at0,
    });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 30000]);
  });

  it("keeps polling through a transient 5xx (non-JSON) blip instead of aborting login", async () => {
    // The Trigger: GitHub returns one 502 mid-poll. Old code called res.json() on the non-JSON body
    // and threw, killing the whole login; now it's treated like authorization_pending.
    const sleep = vi.fn().mockResolvedValue(undefined);
    const token = await pollForToken(DC, {
      fetch: fetchResponses(
        new Response("Bad Gateway", { status: 502 }),
        json({ access_token: "gho_x" }),
      ),
      sleep,
      now: at0,
    });
    expect(token).toBe("gho_x");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("keeps polling through a non-JSON 200 body (transient) instead of throwing", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const token = await pollForToken(DC, {
      fetch: fetchResponses(
        new Response("<html>proxy error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
        json({ access_token: "gho_x" }),
      ),
      sleep,
      now: at0,
    });
    expect(token).toBe("gho_x");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up with a clear error after a run of transient failures (no silent ~15-min hang)", async () => {
    // A PERSISTENT non-200 (proxy 403/407, GitHub outage) must fail fast, not poll to the deadline
    // and then misreport "expired". Five consecutive 502s trip the cap.
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      pollForToken(DC, {
        fetch: fetchResponses(
          new Response("Bad Gateway", { status: 502 }),
          new Response("Bad Gateway", { status: 502 }),
          new Response("Bad Gateway", { status: 502 }),
          new Response("Bad Gateway", { status: 502 }),
          new Response("Bad Gateway", { status: 502 }),
        ),
        sleep,
        now: at0,
      }),
    ).rejects.toThrow(/isn't responding/i);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("keeps polling through a THROWN fetch (wifi blip) instead of crashing the login", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json({ access_token: "gho_x" }));
    const token = await pollForToken(DC, {
      fetch: fn as unknown as typeof fetch,
      sleep,
      now: at0,
    });
    expect(token).toBe("gho_x");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("every poll request carries the 30s timeout signal (a hung poll must not stall the login)", async () => {
    // The deadline is only checked between iterations, so pre-signal a hung poll fetch stalled the
    // whole login forever. Pin the duration via the spy — never wait real time in tests.
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fn = vi.fn().mockResolvedValueOnce(json({ access_token: "gho_x" }));
    await pollForToken(DC, { fetch: fn as unknown as typeof fetch, sleep: noSleep, now: at0 });
    expect(spy).toHaveBeenCalledExactlyOnceWith(30_000);
    const init = fn.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(spy.mock.results[0]?.value);
    spy.mockRestore();
  });

  it("a hung poll (TimeoutError) counts as transient — the login survives one and completes", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      )
      .mockResolvedValueOnce(json({ access_token: "gho_x" }));
    const token = await pollForToken(DC, {
      fetch: fn as unknown as typeof fetch,
      sleep,
      now: at0,
    });
    expect(token).toBe("gho_x");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("persistent hung polls trip the cap with 'request timed out' as the last cause", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValue(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      );
    await expect(
      pollForToken(DC, { fetch: fn as unknown as typeof fetch, sleep, now: at0 }),
    ).rejects.toThrow(/isn't responding.*last error: request timed out/is);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("persistent thrown failures trip the cap WITH the last cause in the message", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const netErr = new TypeError("fetch failed");
    (netErr as Error & { cause: Error }).cause = new Error("getaddrinfo ENOTFOUND github.com");
    const fn = vi.fn().mockRejectedValue(netErr);
    await expect(
      pollForToken(DC, { fetch: fn as unknown as typeof fetch, sleep, now: at0 }),
    ).rejects.toThrow(/isn't responding.*last error: getaddrinfo ENOTFOUND github\.com/is);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("requestDeviceCode: a network failure reads as can't-reach github.com", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { requestDeviceCode } = await import("../src/device-flow.js");
    await expect(requestDeviceCode({ fetch: fn as unknown as typeof fetch })).rejects.toThrow(
      /Can't reach github\.com\. Check your connection/,
    );
  });

  it("requestDeviceCode: a non-ok status reads as a device-code-request failure", async () => {
    const { requestDeviceCode } = await import("../src/device-flow.js");
    await expect(
      requestDeviceCode({ fetch: fetchResponses(new Response("nope", { status: 503 })) }),
    ).rejects.toThrow(/device code request failed: 503 nope/);
  });

  it("requestDeviceCode: a body-read TIMEOUT propagates as a timeout, not 'unexpected response'", async () => {
    const { requestDeviceCode } = await import("../src/device-flow.js");
    const stalled = {
      ok: true,
      json: () =>
        Promise.reject(
          new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        ),
    };
    await expect(
      requestDeviceCode({ fetch: vi.fn().mockResolvedValue(stalled) as unknown as typeof fetch }),
    ).rejects.toSatisfy((e: unknown) => e instanceof Error && e.name === "TimeoutError");
  });

  it("requestDeviceCode: a 200 with the wrong shape throws a clear error, never crashes later", async () => {
    // Captive portal / proxy minting a 200: the old bare cast let undefined reach link() (crash)
    // and a missing expires_in become a NaN deadline (instant misleading "expired").
    const { requestDeviceCode } = await import("../src/device-flow.js");
    await expect(requestDeviceCode({ fetch: fetchSeq({ hello: "world" }) })).rejects.toThrow(
      /unexpected device-code response/i,
    );
    await expect(
      requestDeviceCode({ fetch: fetchSeq({ ...DC, expires_in: undefined }) }),
    ).rejects.toThrow(/unexpected device-code response/i);
  });

  it("requestDeviceCode: an out-of-band interval is rejected (every hot-poll shape)", async () => {
    // A truthy non-number survives `|| 5`-style fallbacks and turns sleep(interval*1000) into
    // sleep(NaN) = 0ms; zero/negative reach setTimeout as immediate timers; sub-second fractions
    // poll near-continuously; huge values overflow Node's 2^31-1 ms timer ceiling, which CLAMPS
    // to 1ms. All the same mangled-middlebox class the surrounding shape check exists for.
    const bad = ["abc", 0, -5, 0.001, Number.NaN, Number.POSITIVE_INFINITY, 1e10] as unknown[];
    for (const interval of bad) {
      await expect(requestDeviceCode({ fetch: fetchSeq({ ...DC, interval }) })).rejects.toThrow(
        /unexpected device-code response/i,
      );
    }
  });

  it("requestDeviceCode: a non-finite or absurd expires_in is rejected (same rigor as interval)", async () => {
    // NaN makes the deadline NaN (instant false "expired"); Infinity/1e300 make it unreachable,
    // so a middlebox feeding parseable authorization_pending bodies would hold the login FOREVER
    // (the deadline is the poll loop's only exit for well-formed bodies).
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, 1e300, 0, -900] as unknown[];
    for (const expires_in of bad) {
      await expect(requestDeviceCode({ fetch: fetchSeq({ ...DC, expires_in }) })).rejects.toThrow(
        /unexpected device-code response/i,
      );
    }
  });

  it("pollForToken is self-defending: a foreign caller's zero interval polls at the 5s default", async () => {
    // requestDeviceCode rejects 0, but pollForToken is exported — its safety must not depend on
    // who constructed the DeviceCode.
    const sleep = vi.fn().mockResolvedValue(undefined);
    await pollForToken(
      { ...DC, interval: 0 },
      { fetch: fetchSeq({ access_token: "gho_x" }), sleep, now: at0 },
    );
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("requestDeviceCode: an ABSENT interval is accepted and the poll defaults to 5s", async () => {
    const { interval: _drop, ...noInterval } = DC;
    const dc = await requestDeviceCode({ fetch: fetchSeq(noInterval) });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await pollForToken(dc, { fetch: fetchSeq({ access_token: "gho_x" }), sleep, now: at0 });
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("slow_down with a mangled non-numeric interval still backs off +5s (never sleep(NaN))", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await pollForToken(DC, {
      fetch: fetchSeq({ error: "slow_down", interval: "abc" }, { access_token: "gho_x" }),
      sleep,
      now: at0,
    });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 10000]);
  });

  it("throws a friendly error on access_denied", async () => {
    await expect(
      pollForToken(DC, { fetch: fetchSeq({ error: "access_denied" }), sleep: noSleep, now: at0 }),
    ).rejects.toThrow(/denied/i);
  });

  it("throws on expired_token", async () => {
    await expect(
      pollForToken(DC, { fetch: fetchSeq({ error: "expired_token" }), sleep: noSleep, now: at0 }),
    ).rejects.toThrow(/expired/i);
  });

  it("throws expired when the deadline passes, without polling", async () => {
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(10_000_000); // compute deadline=1000, then jump past it
    const fetchFn = vi.fn();
    await expect(
      pollForToken(
        { ...DC, expires_in: 1 },
        { fetch: fetchFn as unknown as typeof fetch, sleep: noSleep, now },
      ),
    ).rejects.toThrow(/expired/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("re-checks the deadline AFTER the sleep — never polls (and holds a request) past expiry", async () => {
    // With moments left, sleeping a full slow_down-grown interval and then holding a request up
    // to the 30s budget would overrun the deadline by half a minute before reporting expired.
    const now = vi
      .fn()
      .mockReturnValueOnce(0) // deadline computed
      .mockReturnValueOnce(0) // loop condition passes
      .mockReturnValue(10_000_000); // post-sleep check: expired
    const fetchFn = vi.fn();
    await expect(
      pollForToken(
        { ...DC, expires_in: 1 },
        { fetch: fetchFn as unknown as typeof fetch, sleep: noSleep, now },
      ),
    ).rejects.toThrow(/expired/i);
    expect(fetchFn).not.toHaveBeenCalled(); // the dead-code poll never went out
  });

  it("labels a NON-timeout malformed body as 'unexpected response body' (the ternary's other side)", async () => {
    // ok headers, non-JSON body: res.json() rejects with a SyntaxError, not the signal's
    // TimeoutError — the give-up copy must keep the malformed-body label, never claim a timeout.
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response("<html>proxy error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    await expect(
      pollForToken(DC, { fetch: fn as unknown as typeof fetch, sleep, now: at0 }),
    ).rejects.toThrow(/isn't responding.*last error: unexpected response body/is);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("labels a body-read timeout truthfully in the give-up message (not 'unexpected response body')", async () => {
    // ok headers, stalled body: res.json() rejects with the signal's TimeoutError. Still
    // transient (the counter owns give-up), but the last-cause copy must say what happened.
    const sleep = vi.fn().mockResolvedValue(undefined);
    const stalled = {
      ok: true,
      json: () =>
        Promise.reject(
          new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        ),
    };
    const fn = vi.fn().mockResolvedValue(stalled);
    await expect(
      pollForToken(DC, { fetch: fn as unknown as typeof fetch, sleep, now: at0 }),
    ).rejects.toThrow(/isn't responding.*last error: request timed out/is);
    expect(sleep).toHaveBeenCalledTimes(5);
  });
});

describe("login() orchestration", () => {
  // login() is a TTY-only op; simulate an interactive stdin for the happy path, restore after.
  function withTTY(value: boolean | undefined, run: () => Promise<void>): Promise<void> {
    const orig = process.stdin.isTTY;
    process.stdin.isTTY = value as true;
    return run().finally(() => {
      process.stdin.isTTY = orig as true;
    });
  }

  it("runs the device flow, mints, and stores the token", async () => {
    vi.mocked(mintYmmvToken).mockResolvedValue({
      token: "ymmv_abc",
      handle: "carol",
      github_id: 4242,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await withTTY(true, async () => {
      await login({ fetch: fetchSeq(DC, { access_token: "gho_x" }), sleep: noSleep, now: at0 });
    });
    expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", undefined); // nothing stored to retire
    expect(saveToken).toHaveBeenCalledWith({ token: "ymmv_abc", handle: "carol", github_id: 4242 });
    logSpy.mockRestore();
  });

  it("warns on stderr when YMMV_TOKEN is set — BEFORE the device flow starts (Ctrl+C window)", async () => {
    // The saved login would be shadowed: loadCredential prefers the env token on every read.
    vi.stubEnv("YMMV_TOKEN", "ymmv_env");
    vi.mocked(mintYmmvToken).mockResolvedValue({
      token: "ymmv_abc",
      handle: "carol",
      github_id: 4242,
    });
    const errs: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.join(" "));
    });
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    const fetchFn = fetchSeq(DC, { access_token: "gho_x" }) as ReturnType<typeof vi.fn>;
    try {
      await withTTY(true, async () => {
        await login({ fetch: fetchFn as unknown as typeof fetch, sleep: noSleep, now: at0 });
      });
      expect(errs.join("\n")).toContain("YMMV_TOKEN is set and takes precedence");
      // BEFORE the flow, not merely somewhere: the warn's whole point is the Ctrl+C window
      // ahead of the device-code request. Call order pins it.
      const warnOrder = (errSpy as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const firstFetchOrder = fetchFn.mock.invocationCallOrder[0];
      expect(warnOrder).toBeDefined();
      expect(warnOrder as number).toBeLessThan(firstFetchOrder as number);
      // Still completes and saves: the login is legitimate, just shadowed until the env is unset.
      expect(saveToken).toHaveBeenCalledWith({
        token: "ymmv_abc",
        handle: "carol",
        github_id: 4242,
      });
      expect(logs.join("\n")).toContain("Logged in as carol.");
    } finally {
      vi.unstubAllEnvs();
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("prints a SANITIZED user code and the waiting line (both come off the wire)", async () => {
    vi.mocked(mintYmmvToken).mockResolvedValue({
      token: "ymmv_abc",
      handle: "carol",
      github_id: 4242,
    });
    const esc = String.fromCharCode(0x1b);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    const dirty = { ...DC, user_code: `WXYZ${esc}[31m-1234` };
    await withTTY(true, async () => {
      await login({ fetch: fetchSeq(dirty, { access_token: "gho_x" }), sleep: noSleep, now: at0 });
    });
    const out = logs.join("\n");
    expect(out).toContain("WXYZ-1234");
    expect(out).not.toContain(esc); // tests run piped → color off → zero ANSI, injected or ours
    expect(out).toMatch(/waiting for GitHub approval… \(Ctrl\+C to cancel\)/);
    // Spacing convention: Open + waiting are ONE unit (tight interior); success is its own unit.
    expect(logs[0]).toMatch(/^\n {2}Open /);
    expect(logs[0]).toMatch(/\n {2}waiting for GitHub approval/);
    expect(logs.at(-1)).toBe("\n  Logged in as carol.");
    logSpy.mockRestore();
  });

  it("prints the no-handle success line as an indented unit (reserved GitHub username)", async () => {
    vi.mocked(mintYmmvToken).mockResolvedValue({
      token: "ymmv_abc",
      handle: null,
      github_id: 4242,
    });
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    await withTTY(true, async () => {
      await login({ fetch: fetchSeq(DC, { access_token: "gho_x" }), sleep: noSleep, now: at0 });
    });
    expect(logs.at(-1)).toBe(
      "\n  Logged in. No handle bound (your GitHub username is a reserved word).",
    );
    logSpy.mockRestore();
  });

  it("linkifies ONLY a github.com https verification_uri — anything else prints inert", async () => {
    vi.mocked(mintYmmvToken).mockResolvedValue({
      token: "ymmv_abc",
      handle: "carol",
      github_id: 4242,
    });
    vi.stubEnv("FORCE_COLOR", "1"); // force the linkify path despite piped test stdout
    const esc = String.fromCharCode(0x1b);
    const osc8 = `${esc}]8;;`;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    // Hostile: a middlebox-minted 200 pointing somewhere else must not become clickable.
    const evil = { ...DC, verification_uri: "https://github-com.evil.example/login" };
    await withTTY(true, async () => {
      await login({ fetch: fetchSeq(evil, { access_token: "gho_x" }), sleep: noSleep, now: at0 });
    });
    expect(logs.join("\n")).toContain("github-com.evil.example"); // shown, so the user can judge
    expect(logs.join("\n")).not.toContain(osc8); // but never clickable
    logs.length = 0;
    // Legit github.com URI: linkified.
    await withTTY(true, async () => {
      await login({ fetch: fetchSeq(DC, { access_token: "gho_x" }), sleep: noSleep, now: at0 });
    });
    expect(logs.join("\n")).toContain(osc8);
    vi.unstubAllEnvs();
    logSpy.mockRestore();
  });

  it("refuses (no network) in a non-TTY context — the device flow can't complete there", async () => {
    const fetchFn = vi.fn();
    await withTTY(undefined, async () => {
      await expect(login({ fetch: fetchFn as unknown as typeof fetch })).rejects.toThrow(
        /interactive terminal/i,
      );
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // Re-login and the token it replaces. auth-http is mocked, so these assert the ORCHESTRATION
  // contract (which token goes to the server as `revoke`, what the client-side leftover revoke
  // targets, in what order, blocking what) against the mocked mint/revoke — the transport (the
  // `revoke` body field, the older-Worker refusal, POST /auth/logout + bearer) is pinned in
  // auth-http.test.ts. The lenient peekCredential read (corrupt handle still revocable) is pinned
  // in token-store.test.ts.
  describe("previous-token handling", () => {
    let logs: string[];
    let errs: string[];
    let logSpy: MockInstance;
    let errSpy: MockInstance;
    beforeEach(() => {
      vi.mocked(peekCredential).mockReset();
      vi.mocked(revokeYmmvToken).mockReset();
      vi.mocked(saveToken).mockReset();
      vi.mocked(mintYmmvToken).mockReset();
      vi.mocked(mintYmmvToken).mockResolvedValue({
        token: "ymmv_new",
        handle: "carol",
        github_id: 4242,
      });
      logs = [];
      errs = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        logs.push(a.join(" "));
      });
      errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        errs.push(a.join(" "));
      });
    });
    afterEach(() => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    });

    const run = () =>
      withTTY(true, async () => {
        await login({ fetch: fetchSeq(DC, { access_token: "gho_x" }), sleep: noSleep, now: at0 });
      });

    it("same-base: the stored token goes to the server as `revoke`; no client-side revoke, silent success", async () => {
      // Whether the server found that token live or already dead is its business (the wire flag
      // never reaches login()): either way the retire is done and nothing is left to revoke here.
      vi.mocked(peekCredential).mockResolvedValue({ base: BASE, token: "ymmv_old" });
      await run();
      expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", "ymmv_old");
      expect(revokeYmmvToken).not.toHaveBeenCalled(); // retired in the mint batch, nothing left
      expect(saveToken).toHaveBeenCalledWith({
        token: "ymmv_new",
        handle: "carol",
        github_id: 4242,
      });
      expect(logs.at(-1)).toBe("\n  Logged in as carol.");
      expect(errs).toEqual([]); // success is silent: no warn, no note
    });

    it("sends what the file holds right BEFORE the mint, not the pre-flow snapshot (racing logins)", async () => {
      // The device flow takes minutes; a concurrent login may have replaced the stored token
      // mid-poll. Retiring the stale pre-flow token would permanently orphan the fresh one.
      vi.mocked(peekCredential)
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_preflow" })
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_written_mid_poll" })
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_written_mid_poll" });
      await run();
      expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", "ymmv_written_mid_poll");
      expect(revokeYmmvToken).not.toHaveBeenCalled();
    });

    it("a token written between the pre-mint peek and the save is revoked client-side, AFTER the save", async () => {
      // The server only retired what it was told about. Whatever a racing login wrote in the
      // meantime is this process's leftover: it would otherwise be overwritten while still live.
      vi.mocked(peekCredential)
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_old" })
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_old" })
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_raced" });
      vi.mocked(revokeYmmvToken).mockResolvedValue(true);
      await run();
      expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", "ymmv_old");
      expect(revokeYmmvToken).toHaveBeenCalledTimes(1);
      expect(revokeYmmvToken).toHaveBeenCalledWith("ymmv_raced");
      const saved = vi.mocked(saveToken).mock.invocationCallOrder[0] as number;
      const revoked = vi.mocked(revokeYmmvToken).mock.invocationCallOrder[0] as number;
      expect(revoked).toBeGreaterThan(saved); // a failed save must not add a second orphan
      expect(errs).toEqual([]);
    });

    it("a failed leftover revoke never blocks the login: token saved, faint note, no throw", async () => {
      vi.mocked(peekCredential)
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_old" })
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_old" })
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_raced" });
      vi.mocked(revokeYmmvToken).mockRejectedValue(new Error("logout failed: 503"));
      await run();
      expect(saveToken).toHaveBeenCalledWith({
        token: "ymmv_new",
        handle: "carol",
        github_id: 4242,
      });
      expect(logs.at(-1)).toBe("\n  Logged in as carol.");
      expect(errs.join("\n")).toContain("(couldn't revoke the previous session's token)");
    });

    it("the post-mint peek showing the token just minted, or the one already sent, is not a leftover", async () => {
      // Defensive guard pin: if a server ever echoed the stored token back, revoking it would
      // revoke the login just saved; and the token the server already retired needs no second call.
      vi.mocked(peekCredential)
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_old" })
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_old" })
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_new" });
      await run();
      expect(revokeYmmvToken).not.toHaveBeenCalled();
      expect(logs.at(-1)).toBe("\n  Logged in as carol.");
    });

    it("a mint the CLI refuses (older Worker) leaves the stored login untouched", async () => {
      // The refusal copy promises "Nothing was saved"; only statement order in login() backs it.
      // Pin it: no save, no client-side revoke — the working login survives on disk (an older
      // Worker ignored `revoke`, so that token is still live).
      vi.mocked(peekCredential).mockResolvedValue({ base: BASE, token: "ymmv_old" });
      vi.mocked(mintYmmvToken).mockRejectedValue(
        new MintRejected(
          "https://x.test did not retire the previous login. The server is behind this CLI release; try again later. Nothing was saved; to log in anyway, run `ymmv logout` first.",
        ),
      );
      const err = await run().catch((e: Error) => e);
      expect(err).toBeInstanceOf(MintRejected); // propagates AS the class api.ts branches on
      expect((err as Error).message).toMatch(/did not retire the previous login/);
      expect(saveToken).not.toHaveBeenCalled();
      expect(revokeYmmvToken).not.toHaveBeenCalled();
    });

    it("cross-base: warns (sanitized, prose recovery, no runnable command) and retires nothing", async () => {
      const esc = String.fromCharCode(0x1b);
      vi.mocked(peekCredential).mockResolvedValue({
        base: `https://other.example${esc}[31m`,
        token: "ymmv_other",
      });
      await run();
      expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", undefined); // wrong server to retire it on
      expect(revokeYmmvToken).not.toHaveBeenCalled();
      const err = errs.join("\n");
      expect(err).toContain("You're logged in to https://other.example");
      expect(err).toContain("set YMMV_API to that server");
      expect(err).toContain("ymmv logout");
      // Never an inline runnable `YMMV_API=<value> ...` command: POSIX-only syntax, and it would
      // paste untrusted file content into the user's shell.
      expect(err).not.toContain("YMMV_API=");
      expect(err).not.toContain(esc); // untrusted file content is sanitized before echo
      expect(logs.at(-1)).toBe("\n  Logged in as carol."); // warn-only: the flow proceeds
    });

    it("a foreign-base or blank token in the post-mint peek is not a leftover: no revoke, save proceeds", async () => {
      // A login to another Worker, or a hand edit, between the two peeks: wrong server (or no
      // bearer at all) to revoke against, and only the pre-flow peek owns the cross-base warn.
      for (const after of [
        { base: "https://other.example", token: "ymmv_other" },
        { base: BASE, token: "   " },
      ]) {
        vi.mocked(peekCredential).mockReset();
        vi.mocked(peekCredential)
          .mockResolvedValueOnce({ base: BASE, token: "ymmv_old" })
          .mockResolvedValueOnce({ base: BASE, token: "ymmv_old" })
          .mockResolvedValueOnce(after);
        vi.mocked(mintYmmvToken).mockClear();
        vi.mocked(saveToken).mockClear();
        await run();
        expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", "ymmv_old");
        expect(revokeYmmvToken).not.toHaveBeenCalled();
        expect(saveToken).toHaveBeenCalledTimes(1);
        expect(errs).toEqual([]);
        expect(logs.at(-1)).toBe("\n  Logged in as carol.");
      }
    });

    it("a whitespace-only stored token is nothing to retire: mint without `revoke`, login succeeds", async () => {
      // peekCredential only rejects the empty string; sent as `revoke`, "   " would draw a 400
      // from the Worker and wedge every login until token.json is deleted by hand.
      vi.mocked(peekCredential).mockResolvedValue({ base: BASE, token: "   " });
      await run();
      expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", undefined);
      expect(revokeYmmvToken).not.toHaveBeenCalled();
      expect(logs.at(-1)).toBe("\n  Logged in as carol.");
    });

    it("no stored token: exactly one mint with nothing to retire, zero revoke calls", async () => {
      vi.mocked(peekCredential).mockResolvedValue(null);
      await run();
      expect(mintYmmvToken).toHaveBeenCalledTimes(1);
      expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", undefined);
      expect(revokeYmmvToken).not.toHaveBeenCalled();
    });

    it("a concurrent logout that empties the file BEFORE the mint: nothing to retire, no warn", async () => {
      // The pre-flow peek saw a token; by the time the user approves it is gone (`ymmv logout` in
      // another terminal). The file holds nothing to replace, so the mint asks for nothing.
      vi.mocked(peekCredential)
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_old" })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      await run();
      expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", undefined);
      expect(revokeYmmvToken).not.toHaveBeenCalled();
      expect(saveToken).toHaveBeenCalledTimes(1);
      expect(errs).toEqual([]);
    });

    it("a concurrent logout that empties the file AFTER the mint: no client-side revoke, the save proceeds", async () => {
      // The server already retired the token the file held; the null post-mint peek is not a
      // leftover, and the new login still lands on disk.
      vi.mocked(peekCredential)
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_old" })
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_old" })
        .mockResolvedValueOnce(null);
      await run();
      expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", "ymmv_old");
      expect(revokeYmmvToken).not.toHaveBeenCalled();
      expect(saveToken).toHaveBeenCalledTimes(1);
      expect(logs.at(-1)).toBe("\n  Logged in as carol.");
    });

    it("a mint that fails on the wire (429, GitHub refused) leaves the stored login untouched: plain Error, no save, no revoke", async () => {
      // The Worker refuses before its token batch, so the stored token is still live and the file
      // still holds it. Nothing to undo client-side; the error is transient (not MintRejected).
      vi.mocked(peekCredential).mockResolvedValue({ base: BASE, token: "ymmv_old" });
      vi.mocked(mintYmmvToken).mockRejectedValue(
        new Error("Too many login attempts. Slow down and try again shortly (retry in 60s)."),
      );
      const err = await run().catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(MintRejected);
      expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", "ymmv_old");
      expect(saveToken).not.toHaveBeenCalled();
      expect(revokeYmmvToken).not.toHaveBeenCalled();
    });

    it("nothing stored before the mint, but a racing login wrote a same-base token before the save: revoked client-side", async () => {
      // `after.token !== revoke` is vacuously true with no `revoke`; the leftover path must not be
      // gated on having sent one, or that racing token is overwritten live.
      vi.mocked(peekCredential)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_raced" });
      vi.mocked(revokeYmmvToken).mockResolvedValue(true);
      await run();
      expect(mintYmmvToken).toHaveBeenCalledWith("gho_x", undefined);
      expect(revokeYmmvToken).toHaveBeenCalledTimes(1);
      expect(revokeYmmvToken).toHaveBeenCalledWith("ymmv_raced");
      const saved = vi.mocked(saveToken).mock.invocationCallOrder[0] as number;
      const revoked = vi.mocked(revokeYmmvToken).mock.invocationCallOrder[0] as number;
      expect(revoked).toBeGreaterThan(saved);
    });

    it("a failed save revokes the NEW token only (the old one was retired in the mint batch)", async () => {
      // The file keeps the just-retired token; the next command's 401 clears it and re-logins.
      vi.mocked(peekCredential).mockResolvedValue({ base: BASE, token: "ymmv_old" });
      vi.mocked(saveToken).mockRejectedValue(new Error("EDQUOT"));
      vi.mocked(revokeYmmvToken).mockResolvedValue(true);
      await withTTY(true, async () => {
        await expect(
          login({ fetch: fetchSeq(DC, { access_token: "gho_x" }), sleep: noSleep, now: at0 }),
        ).rejects.toThrow("EDQUOT");
      });
      expect(revokeYmmvToken).toHaveBeenCalledTimes(1);
      expect(revokeYmmvToken).toHaveBeenCalledWith("ymmv_new");
      expect(errs).toEqual([]); // the revoke succeeded: only the fs error reaches the user
    });

    it("a failed save whose revoke of the NEW token also fails says so on stderr", async () => {
      // The previous login is already retired server-side and the minted one is now live with no
      // holder; the fs error alone would claim a clean slate the server doesn't have.
      vi.mocked(peekCredential).mockResolvedValue({ base: BASE, token: "ymmv_old" });
      vi.mocked(saveToken).mockRejectedValue(new Error("EDQUOT"));
      vi.mocked(revokeYmmvToken).mockRejectedValue(new Error("logout failed: 503"));
      await withTTY(true, async () => {
        await expect(
          login({ fetch: fetchSeq(DC, { access_token: "gho_x" }), sleep: noSleep, now: at0 }),
        ).rejects.toThrow("EDQUOT");
      });
      expect(errs.join("\n")).toContain("(the login the server minted could not be revoked)");
    });
  });

  // The browser offer (#78): "Press Enter to copy the code and open github.com in your browser."
  // under the waiting line, with the poll running behind it from the start.
  describe("browser offer", () => {
    const TODAY =
      "\n  Open https://github.com/login/device and enter code: WXYZ-1234\n" +
      "  waiting for GitHub approval… (Ctrl+C to cancel)";
    const WITH_COPY = "Press Enter to copy the code and open github.com in your browser.";
    const NO_COPY = "Press Enter to open github.com in your browser.";
    const LOGGED_IN = "\n  Logged in as carol.";
    let logs: string[];
    let logSpy: MockInstance;
    beforeEach(() => {
      vi.mocked(peekCredential).mockReset();
      vi.mocked(saveToken).mockReset();
      vi.mocked(revokeYmmvToken).mockReset();
      vi.mocked(mintYmmvToken).mockReset();
      vi.mocked(mintYmmvToken).mockResolvedValue({
        token: "ymmv_abc",
        handle: "carol",
        github_id: 4242,
      });
      vi.mocked(findLauncher).mockReset();
      logs = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        logs.push(a.join(" "));
      });
    });
    afterEach(() => {
      logSpy.mockRestore();
    });

    /** A prompter that models readline's line: `typed` is what sits unfinished in it,
     *  discardTypeahead clears it, and a confirm is pre-filled by whatever is left there. */
    function scripted() {
      const state: { typed: string; signal?: AbortSignal } = { typed: "" };
      let enter: (() => void) | undefined;
      const prompter = {
        ask: vi.fn(),
        choice: vi.fn(),
        close: vi.fn(),
        confirm: vi.fn(async (_q: string, defYes: boolean) =>
          state.typed === "" ? defYes : state.typed.startsWith("y"),
        ),
        open: vi.fn(),
        discardTypeahead: vi.fn(() => {
          state.typed = "";
        }),
        offer: vi.fn(
          (_text: string, signal: AbortSignal) =>
            new Promise<boolean>((resolve) => {
              state.signal = signal;
              enter = () => resolve(true);
              signal.addEventListener("abort", () => resolve(false), { once: true });
            }),
        ),
      } satisfies Prompter;
      return { prompter, state, pressEnter: () => enter?.() };
    }

    function launcherOf(over: Partial<Launcher> = {}) {
      const launcher = {
        open: vi.fn(async (_url: string) => true),
        copy: vi.fn(async (_text: string) => true) as Launcher["copy"],
        ...over,
      };
      vi.mocked(findLauncher).mockResolvedValue(launcher);
      return launcher;
    }

    /** A copy that stays pending until the test settles it. */
    function deferredCopy() {
      let settle!: (ok: boolean) => void;
      const copy = vi.fn(
        () =>
          new Promise<boolean>((r) => {
            settle = r;
          }),
      );
      return { copy, finish: (ok: boolean) => settle(ok) };
    }

    const turns = async (until: () => boolean = () => false) => {
      for (let i = 0; i < 50 && !until(); i++) await new Promise((r) => setImmediate(r));
    };

    /** A login whose poll is held at its first sleep until `poll.release()`, returned once the
     *  offer is up. `done` settles with the login. */
    async function startOffer(dc: DeviceCode = DC, s = scripted()) {
      const { prompter, state, pressEnter } = s;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const fetchFn = fetchSeq(dc, { access_token: "gho_x" }) as ReturnType<typeof vi.fn>;
      const done = withTTY(true, () =>
        login({ fetch: fetchFn as unknown as typeof fetch, sleep: () => gate, now: at0, prompter }),
      );
      await turns(() => prompter.offer.mock.calls.length > 0);
      return { prompter, state, pressEnter, poll: { fetchFn, release }, done };
    }

    /** A whole login whose poll gets `answer` at once. */
    const loginAnswered = (
      prompter: Prompter,
      dc: DeviceCode = DC,
      answer: unknown = { access_token: "gho_x" },
    ) =>
      withTTY(true, () =>
        login({ fetch: fetchSeq(dc, answer), sleep: noSleep, now: at0, prompter }),
      );

    it("no prompter: no launcher is looked for, and the lines are today's", async () => {
      await withTTY(true, async () => {
        await login({ fetch: fetchSeq(DC, { access_token: "gho_x" }), sleep: noSleep, now: at0 });
      });
      expect(findLauncher).not.toHaveBeenCalled();
      expect(logs[0]).toBe(TODAY);
    });

    it("a prompter but no launcher (SSH, no display, no opener): today's bytes and no offer, with the input still opened and cleared", async () => {
      // Open before the wait, cleared after it: a `y` typed during a sign-in over SSH must not
      // answer `ymmv delete`'s default-No confirm either.
      vi.mocked(findLauncher).mockResolvedValue(null);
      const { prompter } = scripted();
      const fetchFn = fetchSeq(DC, { access_token: "gho_x" }) as ReturnType<typeof vi.fn>;
      await withTTY(true, () =>
        login({ fetch: fetchFn as unknown as typeof fetch, sleep: noSleep, now: at0, prompter }),
      );
      expect(findLauncher).toHaveBeenCalledTimes(1);
      expect(prompter.offer).not.toHaveBeenCalled();
      expect(logs).toEqual([TODAY, LOGGED_IN]);
      const [openAt] = prompter.open.mock.invocationCallOrder;
      const [requestAt] = fetchFn.mock.invocationCallOrder;
      expect(openAt).toBeLessThan(requestAt as number);
      const lastDiscard = prompter.discardTypeahead.mock.invocationCallOrder.at(-1) as number;
      const [savedAt] = vi.mocked(saveToken).mock.invocationCallOrder;
      expect(lastDiscard).toBeGreaterThan(savedAt as number);
    });

    it("the code is asked for and shown while the launcher lookup still runs (a slow PATH on WSL)", async () => {
      const launcher = launcherOf();
      let found!: (l: Launcher) => void;
      vi.mocked(findLauncher).mockReturnValue(
        new Promise((r) => {
          found = r;
        }),
      );
      const { prompter } = scripted();
      const done = loginAnswered(prompter);
      await turns(() => logs.length > 0);
      expect(logs).toEqual([TODAY]);
      expect(prompter.offer).not.toHaveBeenCalled(); // the offer waits for the lookup
      found(launcher);
      await done;
      expect(prompter.offer).toHaveBeenCalledTimes(1);
    });

    it("input opens before the code request; the offer follows the waiting line; Enter copies the code, then opens the page", async () => {
      const launcher = launcherOf();
      const { prompter, pressEnter, poll, done } = await startOffer();
      const [openAt] = prompter.open.mock.invocationCallOrder;
      const [requestAt] = poll.fetchFn.mock.invocationCallOrder;
      expect(openAt).toBeLessThan(requestAt as number); // an Enter during the request is dropped
      expect(logs).toEqual([TODAY]);
      expect(prompter.offer.mock.calls[0]?.[0]).toBe(WITH_COPY);
      // The code request was a wait: what was typed during it cannot answer the offer.
      const [discardAt] = prompter.discardTypeahead.mock.invocationCallOrder;
      const [offerAt] = prompter.offer.mock.invocationCallOrder;
      expect(discardAt).toBeLessThan(offerAt as number);
      pressEnter();
      await turns(() => launcher.open.mock.calls.length > 0);
      expect(launcher.copy).toHaveBeenCalledWith("WXYZ-1234");
      expect(launcher.open).toHaveBeenCalledWith("https://github.com/login/device");
      poll.release();
      await done;
      expect(logs).toEqual([TODAY, LOGGED_IN]); // both worked: no note
    });

    it("the page opens only once the copy has settled, so the code is there to paste", async () => {
      const { copy, finish } = deferredCopy();
      const launcher = launcherOf({ copy });
      const { pressEnter, poll, done } = await startOffer();
      pressEnter();
      await turns(() => copy.mock.calls.length > 0);
      await turns();
      expect(launcher.open).not.toHaveBeenCalled();
      finish(true);
      await turns(() => launcher.open.mock.calls.length > 0);
      expect(launcher.open).toHaveBeenCalledTimes(1);
      poll.release();
      await done;
    });

    it("an Enter that lands as GitHub answers (the offer says true after its withdrawal) launches nothing", async () => {
      const launcher = launcherOf();
      const s = scripted();
      s.prompter.offer.mockImplementation(
        (_t: string, signal: AbortSignal) =>
          new Promise<boolean>((r) => {
            signal.addEventListener("abort", () => r(true), { once: true });
          }),
      );
      await loginAnswered(s.prompter);
      await turns();
      expect(launcher.copy).not.toHaveBeenCalled();
      expect(launcher.open).not.toHaveBeenCalled();
      expect(logs).toEqual([TODAY, LOGGED_IN]);
    });

    it.each([
      ["ABCD", true],
      ["ABC", false],
      ["ABCD-EFGH-1234-5", true],
      ["ABCD-EFGH-1234-56", false],
      ["WXYZ_1234", false],
      ["ÄXYZ-1234", false],
    ])("user_code %j: copyable %s", async (user_code, copyable) => {
      const launcher = launcherOf();
      const { prompter, pressEnter, poll, done } = await startOffer({ ...DC, user_code });
      expect(prompter.offer.mock.calls[0]?.[0]).toBe(copyable ? WITH_COPY : NO_COPY);
      pressEnter();
      await turns(() => launcher.open.mock.calls.length > 0);
      if (copyable) expect(launcher.copy).toHaveBeenCalledWith(user_code);
      else expect(launcher.copy).not.toHaveBeenCalled();
      poll.release();
      await done;
    });

    it("approved through the clicked link with no Enter: the offer is withdrawn and nothing launches", async () => {
      const launcher = launcherOf();
      const { prompter, state } = scripted();
      await loginAnswered(prompter);
      expect(state.signal?.aborted).toBe(true);
      expect(launcher.copy).not.toHaveBeenCalled();
      expect(launcher.open).not.toHaveBeenCalled();
      expect(logs).toEqual([TODAY, LOGGED_IN]);
    });

    it("GitHub answers while the copy still runs: login does not wait for it, and nothing (tab, note) follows Logged in", async () => {
      const { copy, finish } = deferredCopy();
      const launcher = launcherOf({ copy });
      const { pressEnter, poll, done } = await startOffer();
      pressEnter();
      await turns(() => copy.mock.calls.length > 0);
      poll.release();
      await done; // would hang here if login awaited the helper
      finish(false); // the helper fails after the fact
      await turns();
      expect(logs).toEqual([TODAY, LOGGED_IN]);
      // No stale github.com tab after "Logged in": the open step saw the offer withdrawn.
      expect(launcher.open).not.toHaveBeenCalled();
    });

    it("a denied code ends the login at once, withdrawing the offer", async () => {
      launcherOf();
      const { prompter, state } = scripted();
      await expect(loginAnswered(prompter, DC, { error: "access_denied" })).rejects.toThrow(
        /Authorization denied/,
      );
      expect(state.signal?.aborted).toBe(true);
    });

    it("no clipboard program: the offer promises no copy, and Enter only opens", async () => {
      const launcher = launcherOf({ copy: null });
      const { prompter, pressEnter, poll, done } = await startOffer();
      expect(prompter.offer.mock.calls[0]?.[0]).toBe(NO_COPY);
      pressEnter();
      await turns(() => launcher.open.mock.calls.length > 0);
      expect(launcher.open).toHaveBeenCalledTimes(1);
      poll.release();
      await done;
    });

    it("a code that doesn't look like GitHub's is never copied, and the offer does not promise it", async () => {
      const launcher = launcherOf();
      const { prompter, pressEnter, poll, done } = await startOffer({
        ...DC,
        user_code: "not a code",
      });
      expect(prompter.offer.mock.calls[0]?.[0]).toBe(NO_COPY);
      pressEnter();
      await turns(() => launcher.open.mock.calls.length > 0);
      expect(launcher.copy).not.toHaveBeenCalled();
      poll.release();
      await done;
    });

    it.each([
      [false, true, "couldn't copy the code; type it in"],
      [true, false, "couldn't open a browser; use the link above"],
      [false, false, "couldn't copy the code or open a browser; use the link above"],
    ])(
      "copied %s, opened %s: one faint line under the offer, before Logged in",
      async (copied, opened, note) => {
        const launcher = launcherOf({
          copy: vi.fn(async () => copied),
          open: vi.fn(async () => opened),
        });
        const { pressEnter, poll, done } = await startOffer();
        pressEnter();
        await turns(() => logs.length > 1);
        expect(launcher.open).toHaveBeenCalledTimes(1);
        poll.release();
        await done;
        expect(logs).toEqual([TODAY, `  ${note}`, LOGGED_IN]); // tight: no message() unit
      },
    );

    it("a launcher that throws after Enter never crashes the login (vitest fails on an unhandled rejection)", async () => {
      launcherOf({
        copy: vi.fn(async () => {
          throw new TypeError("Cannot read properties of null (reading 'on')");
        }),
      });
      const { pressEnter, poll, done } = await startOffer();
      pressEnter();
      await turns();
      poll.release();
      await done;
      expect(logs).toEqual([TODAY, LOGGED_IN]);
    });

    it("an offer that fails outright (a stdin error) never fails the login", async () => {
      const launcher = launcherOf();
      const { prompter } = scripted();
      prompter.offer.mockImplementation(async () => {
        throw Object.assign(new Error("read EIO"), { code: "EIO" });
      });
      await loginAnswered(prompter);
      expect(logs).toEqual([TODAY, LOGGED_IN]);
      expect(launcher.copy).not.toHaveBeenCalled(); // no Enter, no launch
      expect(launcher.open).not.toHaveBeenCalled();
    });

    it("an offer that ends without Enter while GitHub is still pending (^D) launches nothing", async () => {
      const launcher = launcherOf();
      const s = scripted();
      s.prompter.offer.mockResolvedValue(false); // ^D rejects the question: false
      const { poll, done } = await startOffer(DC, s);
      await turns();
      expect(launcher.copy).not.toHaveBeenCalled();
      expect(launcher.open).not.toHaveBeenCalled();
      poll.release();
      await done;
      expect(logs).toEqual([TODAY, LOGGED_IN]);
    });

    it("an open that fails after GitHub answered prints no note after Logged in", async () => {
      let finishOpen!: (ok: boolean) => void;
      const open = vi.fn(
        () =>
          new Promise<boolean>((r) => {
            finishOpen = r;
          }),
      );
      launcherOf({ open });
      const { pressEnter, poll, done } = await startOffer();
      pressEnter();
      await turns(() => open.mock.calls.length > 0);
      poll.release();
      await done;
      finishOpen(false); // xdg-open gives up inside its 500ms, after the login
      await turns();
      expect(logs).toEqual([TODAY, LOGGED_IN]);
    });

    it("an offer misused (another question pending) fails the login loudly, before the poll starts", async () => {
      launcherOf();
      const { prompter } = scripted();
      prompter.offer.mockImplementation(() => {
        throw new PrompterMisuse("an offer was made while another question was pending");
      });
      const fetchFn = fetchSeq(DC, { access_token: "gho_x" }) as ReturnType<typeof vi.fn>;
      await expect(
        withTTY(true, () =>
          login({ fetch: fetchFn as unknown as typeof fetch, sleep: noSleep, now: at0, prompter }),
        ),
      ).rejects.toBeInstanceOf(PrompterMisuse);
      expect(fetchFn).toHaveBeenCalledTimes(1); // the code request only: no poll ran
    });

    it("only GitHub's exact device page gets the offer; anything else a reply names prints the link as before", async () => {
      // Openers may re-parse their argument (wslview runs it through PowerShell), and a forged
      // reply must not aim Enter at another github.com page.
      for (const verification_uri of [
        "https://github-com.evil.example/login",
        "https://github.com/login/device$(Get-Date)",
        "https://github.com/login/oauth/authorize?client_id=someone",
        "https://github.com/login/device/",
        "https://github.com/login/device?x=1",
        "https://github.com/login/device#x",
        "http://github.com/login/device",
      ]) {
        const launcher = launcherOf();
        const { prompter } = scripted();
        await loginAnswered(prompter, { ...DC, verification_uri });
        expect(prompter.offer).not.toHaveBeenCalled();
        expect(launcher.open).not.toHaveBeenCalled();
        expect(logs.at(-1)).toBe(LOGGED_IN);
      }
    });

    it("login ends by clearing what was typed during the wait: a stray y cannot answer the next default-No confirm", async () => {
      launcherOf();
      const { prompter, state, pressEnter, poll, done } = await startOffer();
      pressEnter();
      state.typed = "y"; // typed while waiting for GitHub, no Enter
      poll.release();
      await done;
      expect(state.typed).toBe("");
      const lastDiscard = prompter.discardTypeahead.mock.invocationCallOrder.at(-1) as number;
      const [savedAt] = vi.mocked(saveToken).mock.invocationCallOrder;
      expect(lastDiscard).toBeGreaterThan(savedAt as number);
      // What `ymmv delete` asks next on this same prompter: Enter now cancels.
      expect(await prompter.confirm("Delete ymmv.fyi/carol? This is permanent", false)).toBe(false);
    });
  });
});
