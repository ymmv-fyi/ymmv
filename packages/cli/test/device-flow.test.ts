import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

vi.mock("../src/auth-http.js");
vi.mock("../src/token-store.js");

import { mintYmmvToken, revokeYmmvToken } from "../src/auth-http.js";
import { BASE } from "../src/config.js";
import { type DeviceCode, login, pollForToken, requestDeviceCode } from "../src/device-flow.js";
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
    vi.mocked(mintYmmvToken).mockResolvedValue({ token: "ymmv_abc", handle: "carol" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await withTTY(true, async () => {
      await login({ fetch: fetchSeq(DC, { access_token: "gho_x" }), sleep: noSleep, now: at0 });
    });
    expect(mintYmmvToken).toHaveBeenCalledWith("gho_x");
    expect(saveToken).toHaveBeenCalledWith({ token: "ymmv_abc", handle: "carol" });
    logSpy.mockRestore();
  });

  it("warns on stderr when YMMV_TOKEN is set — BEFORE the device flow starts (Ctrl+C window)", async () => {
    // The saved login would be shadowed: loadCredential prefers the env token on every read.
    vi.stubEnv("YMMV_TOKEN", "ymmv_env");
    vi.mocked(mintYmmvToken).mockResolvedValue({ token: "ymmv_abc", handle: "carol" });
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
      expect(saveToken).toHaveBeenCalledWith({ token: "ymmv_abc", handle: "carol" });
      expect(logs.join("\n")).toContain("Logged in as carol.");
    } finally {
      vi.unstubAllEnvs();
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("prints a SANITIZED user code and the waiting line (both come off the wire)", async () => {
    vi.mocked(mintYmmvToken).mockResolvedValue({ token: "ymmv_abc", handle: "carol" });
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
    vi.mocked(mintYmmvToken).mockResolvedValue({ token: "ymmv_abc", handle: null });
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
    vi.mocked(mintYmmvToken).mockResolvedValue({ token: "ymmv_abc", handle: "carol" });
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
  // contract (which token, in what order, blocking what) against the mocked revokeYmmvToken —
  // the transport (POST /auth/logout + bearer) is pinned in auth-http.test.ts. The lenient
  // peekCredential read (corrupt handle still revocable) is pinned in token-store.test.ts.
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
      vi.mocked(mintYmmvToken).mockResolvedValue({ token: "ymmv_new", handle: "carol" });
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

    it("same-base: revokes the replaced token AFTER the save, silently on success", async () => {
      vi.mocked(peekCredential).mockResolvedValue({ base: BASE, token: "ymmv_old" });
      vi.mocked(revokeYmmvToken).mockResolvedValue(true);
      await run();
      expect(revokeYmmvToken).toHaveBeenCalledTimes(1);
      expect(revokeYmmvToken).toHaveBeenCalledWith("ymmv_old");
      const saved = vi.mocked(saveToken).mock.invocationCallOrder[0] as number;
      const revoked = vi.mocked(revokeYmmvToken).mock.invocationCallOrder[0] as number;
      expect(revoked).toBeGreaterThan(saved); // a failed save must keep the OLD login working
      expect(logs.at(-1)).toBe("\n  Logged in as carol.");
      expect(errs).toEqual([]); // success is silent: no warn, no note
    });

    it("a failed revoke never blocks the login: token saved, faint note, no throw", async () => {
      vi.mocked(peekCredential).mockResolvedValue({ base: BASE, token: "ymmv_old" });
      vi.mocked(revokeYmmvToken).mockRejectedValue(new Error("logout failed: 503"));
      await run();
      expect(saveToken).toHaveBeenCalledWith({ token: "ymmv_new", handle: "carol" });
      expect(logs.at(-1)).toBe("\n  Logged in as carol.");
      expect(errs.join("\n")).toContain("(couldn't revoke the previous session's token)");
    });

    it("cross-base: warns (sanitized, prose recovery, no runnable command) and does NOT revoke", async () => {
      const esc = String.fromCharCode(0x1b);
      vi.mocked(peekCredential).mockResolvedValue({
        base: `https://other.example${esc}[31m`,
        token: "ymmv_other",
      });
      await run();
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

    it("revokes what the file holds at SAVE time, not the pre-flow snapshot (racing logins)", async () => {
      // The device flow takes minutes; a concurrent login may have replaced the stored token
      // mid-poll. Revoking the stale pre-flow token would permanently orphan the fresh one.
      vi.mocked(peekCredential)
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_preflow" })
        .mockResolvedValueOnce({ base: BASE, token: "ymmv_written_mid_poll" });
      vi.mocked(revokeYmmvToken).mockResolvedValue(true);
      await run();
      expect(revokeYmmvToken).toHaveBeenCalledTimes(1);
      expect(revokeYmmvToken).toHaveBeenCalledWith("ymmv_written_mid_poll");
    });

    it("no stored token: exactly one mint, zero revoke calls", async () => {
      vi.mocked(peekCredential).mockResolvedValue(null);
      await run();
      expect(mintYmmvToken).toHaveBeenCalledTimes(1);
      expect(revokeYmmvToken).not.toHaveBeenCalled();
    });

    it("same-base with an identical echoed token: no revoke (would kill the fresh login)", async () => {
      // Defensive guard pin: if a server ever echoed the stored token back, revoking "the old
      // one" would revoke the login just saved.
      vi.mocked(peekCredential).mockResolvedValue({ base: BASE, token: "ymmv_new" });
      await run();
      expect(revokeYmmvToken).not.toHaveBeenCalled();
      expect(logs.at(-1)).toBe("\n  Logged in as carol.");
    });

    it("a failed save revokes the NEW token, not the old one (old file survives)", async () => {
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
    });
  });
});
