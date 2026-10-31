import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  causeText,
  displayError,
  NetworkError,
  REQUEST_TIMEOUT_MS,
  RedirectError,
  redirectError,
  safeFetch,
  serverMessage,
  WAIT_LINE_MS,
  wireBody,
  wireErrorBody,
  wireText,
  withRetryHint,
} from "../src/http.js";

afterEach(() => vi.restoreAllMocks());

const timeoutErr = () =>
  new DOMException("The operation was aborted due to timeout", "TimeoutError");

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

  it("injects the default 30s timeout signal when the caller passes no init at all", async () => {
    // The DURATION is the feature: a typo'd constant (3s breaks slow links, 300s defeats the fix)
    // must fail here, not in production — so pin AbortSignal.timeout(30_000) itself, never wait.
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok"));
    await safeFetch("https://x", undefined, "https://x", fetchFn);
    expect(spy).toHaveBeenCalledExactlyOnceWith(30_000);
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(spy.mock.results[0]?.value);
  });

  it("injects the default signal when init exists but carries none (headers-only callers)", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok"));
    await safeFetch("https://x", { method: "POST", redirect: "manual" }, "https://x", fetchFn);
    expect(spy).toHaveBeenCalledExactlyOnceWith(30_000);
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe("POST"); // the rest of the init survives the spread
    expect(init.redirect).toBe("manual");
  });

  it("never clobbers an explicit caller signal — forwarded as the same object", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const controller = new AbortController();
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok"));
    await safeFetch("https://x", { signal: controller.signal }, "https://x", fetchFn);
    expect(spy).not.toHaveBeenCalled();
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it("a TimeoutError rejection reads as can't-reach with 'request timed out'", async () => {
    // fetch rejects with the signal's reason (a TimeoutError DOMException) — never simulate this
    // with fake timers against a real AbortSignal.timeout; reject with the DOMException directly.
    const fetchFn = vi.fn().mockRejectedValue(timeoutErr());
    await expect(
      safeFetch("https://ymmv.fyi", undefined, "https://ymmv.fyi", fetchFn),
    ).rejects.toThrow(
      /Can't reach https:\/\/ymmv\.fyi\. Check your connection \(request timed out\)/,
    );
  });

  it("rejects with a typed NetworkError — the class, not message text, is the discriminator", async () => {
    // logout's connectivity-vs-server-failure branch depends on the type; the message must still
    // be the exact "Can't reach" line so every string match above keeps holding.
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const p = safeFetch("https://x", undefined, "https://x", fetchFn);
    await expect(p).rejects.toBeInstanceOf(NetworkError);
    await expect(safeFetch("https://x", undefined, "https://x", fetchFn)).rejects.toThrow(
      /Can't reach https:\/\/x\./,
    );
  });
});

describe("safeFetch waiting line", () => {
  const ESC = String.fromCharCode(27);
  const LINE = "  reaching ymmv.fyi… (Ctrl+C to cancel)";
  // The stream's own descriptors, put back after each case: vitest's worker stderr is no TTY, and
  // a leaked flag would print the line into every later suite's output.
  const saved = (["isTTY", "columns"] as const).map(
    (k) => [k, Object.getOwnPropertyDescriptor(process.stderr, k)] as const,
  );
  let written: string[] = [];
  let stdoutWrites: ReturnType<typeof vi.spyOn>;

  const terminal = (isTTY: boolean, columns = 80) => {
    Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });
    Object.defineProperty(process.stderr, "columns", { value: columns, configurable: true });
  };
  /** A fetch that settles only when the test says so: `res()` answers, `fail()` rejects. */
  const held = () => {
    let res!: () => void;
    let fail!: (e: unknown) => void;
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((ok, no) => {
          res = () => ok(new Response("ok"));
          fail = no;
        }),
    );
    return { fetchFn, res: () => res(), fail: (e: unknown) => fail(e) };
  };
  const call = (fetchFn: typeof globalThis.fetch, reach = "https://ymmv.fyi") =>
    safeFetch(`${reach}/api/v1/u/x`, undefined, reach, fetchFn);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.stubEnv("TERM", "xterm-256color");
    written = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    stdoutWrites = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    terminal(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(process.stderr, k, desc);
      else Reflect.deleteProperty(process.stderr, k);
    }
  });

  it("shows one faint line on a terminal stderr after the threshold, and takes it back", async () => {
    expect(WAIT_LINE_MS).toBe(1_000);
    const f = held();
    const p = call(f.fetchFn);
    await vi.advanceTimersByTimeAsync(WAIT_LINE_MS - 1);
    expect(written).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(written).toEqual([`\r${ESC}[90m${LINE}${ESC}[0m`]);
    f.res();
    await expect(p).resolves.toBeInstanceOf(Response);
    expect(written).toEqual([`\r${ESC}[90m${LINE}${ESC}[0m`, `\r${ESC}[K`]);
    expect(stdoutWrites).not.toHaveBeenCalled();
  });

  it("prints nothing for a request that settles under the threshold", async () => {
    const f = held();
    const p = call(f.fetchFn);
    await vi.advanceTimersByTimeAsync(WAIT_LINE_MS - 1);
    f.res();
    await p;
    await vi.advanceTimersByTimeAsync(WAIT_LINE_MS * 5);
    expect(written).toEqual([]);
  });

  it("never prints when stderr is not a terminal (a pipe, CI, 2>file)", async () => {
    terminal(false);
    const f = held();
    const p = call(f.fetchFn);
    await vi.advanceTimersByTimeAsync(WAIT_LINE_MS * 5);
    f.res();
    await p;
    expect(written).toEqual([]);
  });

  it("two requests in flight share one line, taken back when the last settles", async () => {
    const a = held();
    const b = held();
    const pa = call(a.fetchFn);
    const pb = call(b.fetchFn);
    await vi.advanceTimersByTimeAsync(WAIT_LINE_MS * 2);
    expect(written).toHaveLength(1);
    a.res();
    await pa;
    expect(written).toHaveLength(1); // b is still pending: the line stays
    b.res();
    await pb;
    expect(written).toEqual([`\r${ESC}[90m${LINE}${ESC}[0m`, `\r${ESC}[K`]);
  });

  it("a failure takes the line back at once, though the other request is still pending", async () => {
    // compare()'s Promise.all prints the first rejection while the other request is in flight:
    // the line must not stay above that error, nor appear under it later.
    const a = held();
    const b = held();
    const pa = call(a.fetchFn).catch(() => "failed");
    const pb = call(b.fetchFn);
    await vi.advanceTimersByTimeAsync(WAIT_LINE_MS);
    a.fail(timeoutErr());
    expect(await pa).toBe("failed");
    expect(written).toEqual([`\r${ESC}[90m${LINE}${ESC}[0m`, `\r${ESC}[K`]);
    b.res();
    await pb;
    expect(written).toHaveLength(2);
  });

  it("a failure before the threshold cancels the line for the request still pending", async () => {
    const a = held();
    const b = held();
    const pa = call(a.fetchFn).catch(() => "failed");
    const pb = call(b.fetchFn);
    a.fail(new TypeError("fetch failed"));
    await pa;
    await vi.advanceTimersByTimeAsync(WAIT_LINE_MS * 5);
    b.res();
    await pb;
    expect(written).toEqual([]);
  });

  it("takes the line back before a timeout's can't-reach error surfaces, message unchanged", async () => {
    const f = held();
    const p = call(f.fetchFn);
    const settled = p.catch((e: Error) => [e.message, written.length] as const);
    await vi.advanceTimersByTimeAsync(WAIT_LINE_MS);
    f.fail(timeoutErr());
    const [msg, writesAtThrow] = await settled;
    expect(msg).toBe("Can't reach https://ymmv.fyi. Check your connection (request timed out)");
    expect(writesAtThrow).toBe(2);
    expect(written[1]).toBe(`\r${ESC}[K`);
  });

  it("arms an unref'd timer, so a pending line never holds the process open", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const f = held();
    const p = call(f.fetchFn);
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    f.res();
    await p;
  });

  it("is plain under NO_COLOR, and a dumb terminal is erased with spaces", async () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("TERM", "dumb");
    const f = held();
    const p = call(f.fetchFn);
    await vi.advanceTimersByTimeAsync(WAIT_LINE_MS);
    f.res();
    await p;
    expect(written).toEqual([`\r${LINE}`, `\r${" ".repeat([...LINE].length)}\r`]);
  });

  it("names the reach the way the readout shows a site, cut to the terminal's width", async () => {
    terminal(true, 24);
    vi.stubEnv("NO_COLOR", "1");
    const f = held();
    const p = call(f.fetchFn, "http://localhost:8794");
    await vi.advanceTimersByTimeAsync(WAIT_LINE_MS);
    f.res();
    await p;
    // 23 columns: one short of the width, so the line never wraps past the row the erase clears.
    expect(written[0]).toBe("\r  reaching http://local");
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

  it("maps a TimeoutError to 'request timed out' — bare or nested under a wrapper's cause", () => {
    expect(causeText(timeoutErr())).toBe("request timed out");
    const outer = new TypeError("fetch failed");
    (outer as Error & { cause: Error }).cause = timeoutErr();
    expect(causeText(outer)).toBe("request timed out");
  });
});

describe("serverMessage", () => {
  const res = (body: BodyInit, status = 429) => new Response(body, { status });

  it("returns the wire message, sanitized and capped like every other error surface", async () => {
    const esc = String.fromCharCode(0x1b);
    expect(await serverMessage(res(JSON.stringify({ message: `slow ${esc}[31mdown` })))).toBe(
      "slow down",
    );
    const long = await serverMessage(res(JSON.stringify({ message: "x".repeat(500) })));
    expect(long).toHaveLength(201); // 200 + ellipsis
  });

  it("cuts the cap between code points, never inside a surrogate pair", async () => {
    // Code point 200 is astral: a UTF-16 cut would keep its high surrogate alone, printing a
    // replacement glyph and reading as "visible" to the guard.
    const smile = String.fromCodePoint(0x1f600);
    const msg = `${"x".repeat(199)}${smile}tail`;
    expect(await serverMessage(res(JSON.stringify({ message: msg })))).toBe(
      `${"x".repeat(199)}${smile}…`,
    );
    // The cap counts code points: 150 astral chars are 300 UTF-16 units and must not be cut.
    const astral = `${smile.repeat(150)}x`;
    expect(await serverMessage(res(JSON.stringify({ message: astral })))).toBe(astral);
  });

  it("returns undefined for a non-JSON body (edge WAF block page) — caller's fallback stands", async () => {
    expect(await serverMessage(res("<html>blocked</html>"))).toBeUndefined();
  });

  it("returns undefined when message is absent, empty, or not a string", async () => {
    expect(await serverMessage(res(JSON.stringify({ error: "rate_limited" })))).toBeUndefined();
    expect(await serverMessage(res(JSON.stringify({ message: "" })))).toBeUndefined();
    expect(await serverMessage(res(JSON.stringify({ message: 123 })))).toBeUndefined();
  });

  it('judges visibility on what will print, minus the cap\'s ellipsis — never blanks plus "…"', async () => {
    // wireText appends a visible "…" past 200 chars. Testing the capped form would let 201
    // zero-width spaces through on the ellipsis alone; testing the whole body would let visible
    // text that only starts past the cap through, printing 200 invisibles and "…".
    const zwsp = String.fromCodePoint(0x200b);
    expect(await serverMessage(res(JSON.stringify({ message: zwsp.repeat(201) })))).toBeUndefined();
    expect(
      await serverMessage(res(JSON.stringify({ message: `${zwsp.repeat(200)}boom` }))),
    ).toBeUndefined();
    // Visible text inside the cap still prints, capped.
    const kept = await serverMessage(res(JSON.stringify({ message: `boom${zwsp.repeat(300)}` })));
    expect(kept?.startsWith("boom")).toBe(true);
    expect(kept).toHaveLength(201);
  });

  it("returns undefined when the message sanitizes to nothing visible — never a blank error line", async () => {
    // A message of pure ANSI, whitespace, or zero-width chars would survive a truthiness check
    // and defeat every caller's `?? fallback`, throwing an empty Error.
    const esc = String.fromCharCode(0x1b);
    expect(
      await serverMessage(res(JSON.stringify({ message: `${esc}[31m${esc}[2J` }))),
    ).toBeUndefined();
    expect(await serverMessage(res(JSON.stringify({ message: "   " })))).toBeUndefined();
    expect(await serverMessage(res(JSON.stringify({ message: "\u200B\u2060" })))).toBeUndefined();
    // Beyond the classic zero-width set: any Default_Ignorable code point (U+061C ALM, variation
    // selectors) must not count as a message either \u2014 hand-rolled lists miss these.
    expect(await serverMessage(res(JSON.stringify({ message: "\u061C\uFE0F" })))).toBeUndefined();
  });

  it("rethrows a body-read TIMEOUT instead of returning undefined — a stalled body is not a malformed message", async () => {
    // Headers can arrive within the budget while the body stalls past it; res.json() then rejects
    // with the signal's TimeoutError. Mislabeling that as "no message" would print the caller's
    // fallback copy (e.g. handle-taken) for what is actually a network timeout.
    const stalled = { text: () => Promise.reject(timeoutErr()) } as unknown as Response;
    await expect(serverMessage(stalled)).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && e.name === "TimeoutError",
    );
  });
});

describe("wireBody", () => {
  it("returns the body text once, and rethrows only a body-read timeout", async () => {
    expect(await wireBody(new Response("raw text"))).toBe("raw text");
    const stalled = { text: () => Promise.reject(timeoutErr()) } as unknown as Response;
    await expect(wireBody(stalled)).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && e.name === "TimeoutError",
    );
  });

  it("degrades any non-timeout read failure to an empty string — the error path never throws", async () => {
    const broken = { text: () => Promise.reject(new Error("aborted")) } as unknown as Response;
    expect(await wireBody(broken)).toBe("");
  });
});

describe("wireErrorBody", () => {
  it("extracts the slug and the sanitized, capped message", () => {
    const esc = String.fromCharCode(0x1b);
    const raw = JSON.stringify({ error: "value_too_long", message: `too ${esc}[31mlong` });
    expect(wireErrorBody(raw)).toEqual({ slug: "value_too_long", message: "too long" });
    const long = wireErrorBody(JSON.stringify({ message: "x".repeat(500) }));
    expect(long.message).toHaveLength(201); // 200 + ellipsis
  });

  it("returns {} for a non-JSON body and drops non-string fields", () => {
    expect(wireErrorBody("<html>blocked</html>")).toEqual({});
    expect(wireErrorBody("")).toEqual({});
    expect(wireErrorBody(JSON.stringify({ error: 42, message: 123 }))).toEqual({});
  });

  it("drops a message that sanitizes to nothing visible, keeping the slug", () => {
    const raw = JSON.stringify({ error: "rate_limited", message: "​⁠" });
    expect(wireErrorBody(raw)).toEqual({ slug: "rate_limited" });
  });
});

describe("withRetryHint", () => {
  const res = (retryAfter?: string) =>
    new Response("{}", { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} });

  it("appends the hint for the delta-seconds form only", () => {
    expect(withRetryHint("slow down", res("60"))).toBe("slow down (retry in 60s)");
  });

  it("drops the hint for an HTTP-date retry-after (would garble) and for a missing header", () => {
    expect(withRetryHint("slow down", res("Thu, 03 Jul 2026 04:00:00 GMT"))).toBe("slow down");
    expect(withRetryHint("slow down", res())).toBe("slow down");
  });
});

describe("redirectError", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("catches every redirect status and nothing else (304 is not a redirect)", () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(
        redirectError(new Response(null, { status }), "https://x.dev"),
        String(status),
      ).toBeInstanceOf(RedirectError);
    }
    for (const status of [200, 304, 400, 404, 500]) {
      expect(
        redirectError(new Response(null, { status }), "https://x.dev"),
        String(status),
      ).toBeNull();
    }
  });

  it("reads the status only: a mock with no body methods is enough, and Location is never named", () => {
    const bare = { status: 308, headers: new Headers({ location: "https://evil.example/" }) };
    const err = redirectError(bare as unknown as Response, "https://x.dev");
    expect(err?.message).toBe(
      "https://x.dev answered with a redirect (308), which the CLI doesn't follow with your login.",
    );
    expect(err?.message).not.toContain("evil.example");
  });

  it("cancels the unread body, so a server holding it open can't keep the process alive", async () => {
    // The callers throw without reading a redirect's body; left open, it pins the socket until the
    // 30s request timeout after the error has already printed.
    let cancelled = false;
    const body = new ReadableStream({
      pull() {
        // never enqueues or closes: a body the server keeps open
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(body, { status: 302, headers: { location: "/" } });
    expect(redirectError(res, "https://x.dev")).toBeInstanceOf(RedirectError);
    await Promise.resolve(); // cancel() settles on a microtask
    expect(cancelled).toBe(true);
    // Not a redirect: the body is the caller's to read.
    const ok = new Response("{}", { status: 500 });
    expect(redirectError(ok, "https://x.dev")).toBeNull();
    expect(ok.bodyUsed).toBe(false);
    expect(await ok.text()).toBe("{}");
  });

  it("points at YMMV_API only when it is set (the default base is not the user's to fix)", () => {
    const res = new Response(null, { status: 301 });
    expect(redirectError(res, "https://x.dev")?.message).not.toContain("YMMV_API");
    vi.stubEnv("YMMV_API", "https://x.dev");
    expect(redirectError(res, "https://x.dev")?.message).toMatch(/ Check YMMV_API\.$/);
  });

  it("sanitizes the base (under logout it is the raw, ungated env value) and stays copy-rule clean", () => {
    const esc = String.fromCharCode(0x1b);
    const msg = redirectError(
      new Response(null, { status: 302 }),
      `https://x.dev${esc}[31m`,
    )?.message;
    expect(msg).toContain("https://x.dev");
    expect(msg).not.toContain(esc);
    expect(msg).not.toContain("—");
  });
});

describe("displayError", () => {
  it("maps a TimeoutError DOMException — a body-read (res.json) abort lands here, not in safeFetch", () => {
    expect(displayError(timeoutErr())).toBe("request timed out");
  });

  it("preserves safeFetch's composed can't-reach wrapper — never flattens the host context away", () => {
    // safeFetch deliberately nests the TimeoutError under `cause` of an Error whose message
    // already carries the host + "request timed out" (via causeText). Flattening that to the
    // bare line would hide WHICH host timed out (github.com vs ymmv.fyi matters mid-login).
    const wrapper = new Error(
      "Can't reach https://ymmv.fyi. Check your connection (request timed out)",
      {
        cause: timeoutErr(),
      },
    );
    expect(displayError(wrapper)).toBe(
      "Can't reach https://ymmv.fyi. Check your connection (request timed out)",
    );
  });

  it("sanitizes the message per line — a V8 JSON SyntaxError can embed raw wire bytes", () => {
    // A bare success-path res.json() on a middlebox 200 throws a SyntaxError whose message quotes
    // the body's first bytes; this is the one print path around every wireText surface.
    const esc = String.fromCharCode(0x1b);
    const err = new SyntaxError(`Unexpected token '${esc}', "${esc}[31mboom" is not valid JSON`);
    const out = displayError(err);
    expect(out).not.toContain(esc);
    expect(out).toContain("is not valid JSON");
  });

  it("passes ordinary errors and non-errors through unchanged (multi-line preserved)", () => {
    expect(displayError(new Error("publish failed: 500"))).toBe("publish failed: 500");
    expect(displayError(new Error("line one\nline two"))).toBe("line one\nline two");
    expect(displayError("boom")).toBe("boom");
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

  it("coerces non-string wire values — the error path must never itself throw", () => {
    // A malformed body like {"message": 123} reaches wireText through truthiness-only callers.
    expect(wireText(123)).toBe("123");
    expect(wireText(null)).toBe("null");
    expect(wireText({ nested: true })).toBe("[object Object]");
  });
});
