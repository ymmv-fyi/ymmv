import { describe, expect, it, vi } from "vitest";
import { causeText, safeFetch, wireText } from "../src/http.js";

describe("safeFetch", () => {
  it("wraps undici's TypeError into can't-reach, surfacing the nested cause", async () => {
    const netErr = new TypeError("fetch failed");
    (netErr as Error & { cause: Error }).cause = new Error("getaddrinfo ENOTFOUND ymmv.fyi");
    const fetchFn = vi.fn().mockRejectedValue(netErr);
    await expect(
      safeFetch("https://ymmv.fyi/api", undefined, "https://ymmv.fyi", fetchFn),
    ).rejects.toThrow(
      /Can't reach https:\/\/ymmv\.fyi\. Check your connection \(getaddrinfo ENOTFOUND ymmv\.fyi\)/,
    );
  });

  it("wraps NON-TypeError throws too (TLS/proxy/bad-URL class), keeping the cause chain", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("self-signed certificate"));
    const p = safeFetch("https://x", undefined, "https://x", fetchFn);
    await expect(p).rejects.toThrow(/Can't reach https:\/\/x\..*self-signed certificate/);
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

  it("digs into undici's empty-message AggregateError (the dead-localhost case)", () => {
    // `YMMV_API=http://localhost:4321` with nothing listening: cause is an AggregateError with
    // an empty message wrapping per-address ECONNREFUSED errors. The old fallback showed the
    // useless outer "fetch failed".
    const agg = new AggregateError(
      [
        new Error("connect ECONNREFUSED 127.0.0.1:4321"),
        new Error("connect ECONNREFUSED ::1:4321"),
      ],
      "",
    );
    const outer = new TypeError("fetch failed");
    (outer as Error & { cause: Error }).cause = agg;
    expect(causeText(outer)).toBe("connect ECONNREFUSED 127.0.0.1:4321");
  });

  it("falls back to the AggregateError code when its sub-errors carry no message", () => {
    const agg = new AggregateError([], "");
    (agg as AggregateError & { code: string }).code = "ECONNREFUSED";
    const outer = new TypeError("fetch failed");
    (outer as Error & { cause: Error }).cause = agg;
    expect(causeText(outer)).toBe("ECONNREFUSED");
  });

  it("sanitizes the cause — middlebox bytes can't smuggle escapes into the error line", () => {
    const esc = String.fromCharCode(0x1b);
    const outer = new TypeError("fetch failed");
    (outer as Error & { cause: Error }).cause = new Error(`bad ${esc}[2Jproxy`);
    expect(causeText(outer)).toBe("bad proxy"); // the whole CSI sequence is stripped
    expect(causeText(outer)).not.toContain(esc);
  });
});

describe("wireText", () => {
  it("sanitizes wire bytes and caps a block-page-sized body at 200 chars", () => {
    const esc = String.fromCharCode(0x1b);
    expect(wireText(`err${esc}[31mor`)).toBe("error");
    const page = "x".repeat(500);
    const out = wireText(page);
    expect(out).toHaveLength(201); // 200 + ellipsis
    expect(out.endsWith("…")).toBe(true);
    expect(wireText("short")).toBe("short");
  });
});
