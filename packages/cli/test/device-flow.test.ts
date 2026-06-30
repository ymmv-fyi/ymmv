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
