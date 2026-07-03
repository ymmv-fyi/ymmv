import { describe, expect, it, vi } from "vitest";

vi.mock("../src/auth-http.js");
vi.mock("../src/token-store.js");

import { mintYmmvToken } from "../src/auth-http.js";
import { type DeviceCode, login, pollForToken } from "../src/device-flow.js";
import { saveToken } from "../src/token-store.js";

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
});
