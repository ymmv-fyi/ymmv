import { describe, expect, it, vi } from "vitest";
import { causeText, safeFetch } from "../src/http.js";

describe("safeFetch", () => {
  it("wraps undici's TypeError into can't-reach, surfacing the nested cause", async () => {
    const netErr = new TypeError("fetch failed");
    (netErr as Error & { cause: Error }).cause = new Error("getaddrinfo ENOTFOUND ymmv.fyi");
    const fetchFn = vi.fn().mockRejectedValue(netErr);
    await expect(
      safeFetch("https://ymmv.fyi/api", undefined, "https://ymmv.fyi", fetchFn),
    ).rejects.toThrow(
      /can't reach https:\/\/ymmv\.fyi — check your connection \(getaddrinfo ENOTFOUND ymmv\.fyi\)/,
    );
  });

  it("wraps NON-TypeError throws too (TLS/proxy/bad-URL class), keeping the cause chain", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("self-signed certificate"));
    const p = safeFetch("https://x", undefined, "https://x", fetchFn);
    await expect(p).rejects.toThrow(/can't reach https:\/\/x .*self-signed certificate/);
    await p.catch((e: Error) => {
      expect((e.cause as Error).message).toBe("self-signed certificate");
    });
  });

  it("passes HTTP responses through untouched — any status, no throw", async () => {
    const res = new Response("err", { status: 500 });
    const fetchFn = vi.fn().mockResolvedValue(res);
    await expect(safeFetch("https://x", undefined, "https://x", fetchFn)).resolves.toBe(res);
  });
});

describe("causeText", () => {
  it("prefers the nested cause message, falls back to the error's own, then String()", () => {
    const nested = new TypeError("fetch failed");
    (nested as Error & { cause: Error }).cause = new Error("ECONNREFUSED");
    expect(causeText(nested)).toBe("ECONNREFUSED");
    expect(causeText(new Error("socket hang up"))).toBe("socket hang up");
    expect(causeText("boom")).toBe("boom");
  });
});
