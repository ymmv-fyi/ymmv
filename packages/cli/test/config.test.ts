import { describe, expect, it } from "vitest";
import { baseProblem, credentialEnvProblem, normalizeBase } from "../src/config.js";

// baseProblem is deliberately a pure function over the raw env value (BASE itself bakes at module
// load, so env-stubbing after import can't exercise it) — and it validates the NORMALIZED value,
// through the same normalizeBase the BASE constant uses, so the validator can never bless a value
// the request path mishandles.
describe("normalizeBase", () => {
  it("strips trailing slashes only", () => {
    expect(normalizeBase("https://x.dev///")).toBe("https://x.dev");
    expect(normalizeBase("https://x.dev")).toBe("https://x.dev");
  });
});

describe("baseProblem", () => {
  it("unset YMMV_API is fine (the default base)", () => {
    expect(baseProblem(undefined)).toBeNull();
  });

  it("empty YMMV_API means unset, never an error (`YMMV_API= ymmv` is the shell way of clearing)", () => {
    expect(baseProblem("")).toBeNull();
  });

  it("accepts a bare origin, with or without a trailing slash", () => {
    expect(baseProblem("https://ymmv.fyi")).toBeNull();
    expect(baseProblem("https://x.dev/")).toBeNull();
    expect(baseProblem("http://localhost:4321")).toBeNull();
  });

  it("a scheme-less value names YMMV_API and the missing scheme, not the network", () => {
    // The natural first attempt for "point YMMV_API at a local Worker" — previously surfaced as
    // "Can't reach localhost:4321. Check your connection", a config mistake in network clothing.
    const p = baseProblem("localhost:4321");
    expect(p).toContain("YMMV_API");
    expect(p).toMatch(/http/);
    expect(baseProblem("192.168.1.5:8080")).toContain("YMMV_API");
  });

  it("rejects a path-mounted base (root-absolute redirects would drop the prefix)", () => {
    expect(baseProblem("https://x.dev/api")).toContain("bare origin");
    expect(baseProblem("https://x.dev/?q=1")).toContain("bare origin");
  });

  it("rejects whitespace new URL() would silently trim but BASE would keep", () => {
    expect(baseProblem(" https://x.dev")).toContain("whitespace");
    expect(baseProblem("https://x.dev ")).toContain("whitespace");
  });

  it("rejects non-http(s) schemes and embedded credentials", () => {
    expect(baseProblem("ftp://x.dev")).toContain("http");
    // Password-less userinfo on purpose: url.username alone hits the credentials branch, and a
    // user:password fixture would trip the credential scanner in the pre-push guard.
    expect(baseProblem("https://user@x.dev")).toContain("credentials");
  });

  it("rejects values the URL parser normalizes but BASE would keep raw (gate-bypass corpus)", () => {
    // Each of these parses to a clean URL (pathname "/", empty search/hash) while the raw string
    // differs — previously they passed the gate and then every request went somewhere else, the
    // token got scoped under a junk base, and metacharacters leaked into recovery copy.
    const bypasses = [
      "https://ymmv.fyi?",
      "https://ymmv.fyi/?",
      "https://ymmv.fyi#",
      "https://ymmv.fyi/#",
      "https://x.dev/$(id)/../..",
      "https:ymmv.fyi",
      "https:/ymmv.fyi",
      "https://ymmv.fyi\\",
      "https://ymmv.fyi:443",
      "HTTPS://YMMV.FYI",
    ];
    for (const raw of bypasses) {
      expect(baseProblem(raw), raw).toContain("YMMV_API");
    }
  });

  it("sanitizes the echoed value (env vars are still untrusted print input)", () => {
    const esc = String.fromCharCode(0x1b);
    const p = baseProblem(`bogus${esc}[31mvalue`);
    expect(p).toContain("bogusvalue");
    expect(p).not.toContain(esc);
  });

  it("every message is copy-rule clean: names YMMV_API, no em dashes", () => {
    const bads = ["localhost:4321", "https://x.dev/api", " https://x.dev", "ftp://x.dev"];
    for (const raw of bads) {
      const p = baseProblem(raw) as string;
      expect(p).toContain("YMMV_API");
      expect(p).not.toContain("—");
    }
  });
});

// Pure like baseProblem, same rationale. The one asymmetry: YMMV_API echoes its value in every
// message, YMMV_TOKEN must never — the token is a secret.
describe("credentialEnvProblem", () => {
  it("unset and empty YMMV_TOKEN are fine (empty is the shell way of clearing)", () => {
    expect(credentialEnvProblem(undefined, undefined)).toBeNull();
    expect(credentialEnvProblem("", "anything")).toBeNull();
  });

  it("a well-shaped token, with or without a handle, passes", () => {
    expect(credentialEnvProblem("ymmv_abc123", undefined)).toBeNull();
    expect(credentialEnvProblem("ymmv_abc123", "")).toBeNull();
    expect(credentialEnvProblem("ymmv_abc123", "carol")).toBeNull();
  });

  it("rejects whitespace/control/non-ASCII tokens naming the variable, WITHOUT echoing the value", () => {
    // Any of these would corrupt the `Bearer` header into an opaque undici TypeError.
    for (const tok of ["bad token", "tok\nen", "tok\ten", "tok\ren", "töken"]) {
      const p = credentialEnvProblem(tok, undefined) as string;
      expect(p, tok).toContain("YMMV_TOKEN");
      expect(p, tok).not.toContain(tok); // secret: never echoed, even malformed
    }
  });

  it("rejects an invalid-shape YMMV_HANDLE naming the variable", () => {
    for (const h of ["-lead", "trail-", "double--hyphen", "sp ace", "x".repeat(40)]) {
      expect(credentialEnvProblem("ymmv_abc", h), h).toContain("YMMV_HANDLE");
    }
  });

  it("rejects a reserved YMMV_HANDLE (nothing can ever bind to it)", () => {
    const p = credentialEnvProblem("ymmv_abc", "login") as string;
    expect(p).toContain("YMMV_HANDLE");
    expect(p).toContain("reserved");
  });

  it("YMMV_HANDLE alone is inert (a stray export must never block file-token use)", () => {
    expect(credentialEnvProblem(undefined, "-not-even-valid-")).toBeNull();
  });

  it("sanitizes the echoed HANDLE (env vars are untrusted print input) and stays copy-rule clean", () => {
    const esc = String.fromCharCode(0x1b);
    const p = credentialEnvProblem("ymmv_abc", `bad${esc}[31m--handle`) as string;
    expect(p).not.toContain(esc);
    for (const bad of ["bad token", undefined] as const) {
      const msg = credentialEnvProblem(bad ?? "ymmv_abc", bad ? undefined : "-x-");
      expect(msg).not.toBeNull(); // a null here would silently skip the copy-rule check
      expect(msg).not.toContain("—");
    }
  });
});
