import { describe, expect, it, vi } from "vitest";
import {
  baseProblem,
  credentialEnvProblem,
  isCleartextBase,
  isSameServer,
  normalizeBase,
  serverOrigin,
} from "../src/config.js";

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
    expect(baseProblem("https://ymmv-staging.acct.workers.dev")).toBeNull();
  });

  it("accepts plain http on loopback only (localhost, 127.0.0.0/8, [::1])", () => {
    for (const raw of ["http://127.0.0.1:8788", "http://127.1.2.3:8788", "http://[::1]:8788"]) {
      expect(baseProblem(raw), raw).toBeNull();
    }
  });

  it("refuses plain http anywhere else: the token would cross a network in cleartext", () => {
    for (const raw of [
      "http://x.dev",
      "http://192.168.1.5:8788",
      "http://host.docker.internal:8788",
      "http://localhost.evil.com",
    ]) {
      const p = baseProblem(raw);
      expect(p, raw).toContain("plain http");
      expect(p, raw).toContain("Use https");
    }
  });

  it("a host that only starts like a loopback address is not loopback (DNS can send it anywhere)", () => {
    for (const raw of ["http://127.0.0.1.evil.com", "http://127.0.0.1.nip.io:8788"]) {
      expect(baseProblem(raw), raw).toContain("plain http");
    }
  });

  it("refuses every ymmv.fyi address but https://ymmv.fyi (the Worker redirects them)", () => {
    // The Worker never serves these: an https alias redirects (the CLI never follows a redirect
    // with a credential) and an http one refuses a credential with a 403, so login would fail
    // only after the whole device flow.
    for (const raw of [
      "http://ymmv.fyi",
      "https://www.ymmv.fyi",
      "http://www.ymmv.fyi",
      "https://ymmv.fyi.",
      "https://www.ymmv.fyi.",
      "https://ymmv.fyi:8443",
      "http://ymmv.fyi:8080",
    ]) {
      const p = baseProblem(raw);
      expect(p, raw).toContain("redirects to https://ymmv.fyi");
      expect(p, raw).toContain("Use https://ymmv.fyi, or unset YMMV_API.");
    }
    // Hosts that merely contain the name are someone else's, and judged like any other origin.
    expect(baseProblem("https://ymmv.fyi.evil.com")).toBeNull();
    expect(baseProblem("https://notymmv.fyi")).toBeNull();
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
    const bads = [
      "localhost:4321",
      "https://x.dev/api",
      " https://x.dev",
      "ftp://x.dev",
      "https://www.ymmv.fyi",
      "http://x.dev",
    ];
    for (const raw of bads) {
      const p = baseProblem(raw) as string;
      expect(p).toContain("YMMV_API");
      expect(p).not.toContain("—");
    }
  });
});

describe("isCleartextBase", () => {
  it("is true for plain http to a host off this machine, false for https and loopback", () => {
    for (const base of ["http://ymmv.fyi", "http://www.ymmv.fyi", "http://192.168.1.5:8788"]) {
      expect(isCleartextBase(base), base).toBe(true);
    }
    for (const base of [
      "https://ymmv.fyi",
      "https://www.ymmv.fyi",
      "http://localhost:8788",
      "http://127.0.0.1:8788",
      "http://[::1]:8788",
    ]) {
      expect(isCleartextBase(base), base).toBe(false);
    }
  });

  it("never throws on token.json content that is not a URL", () => {
    expect(isCleartextBase("B")).toBe(false);
    expect(isCleartextBase("")).toBe(false);
  });
});

// BASE is the default here (setup-env), so isSameServer compares against https://ymmv.fyi.
describe("serverOrigin / isSameServer", () => {
  it("maps every ymmv.fyi address to https://ymmv.fyi and leaves other bases alone", () => {
    for (const alias of ["http://ymmv.fyi", "https://www.ymmv.fyi", "https://ymmv.fyi."]) {
      expect(serverOrigin(alias), alias).toBe("https://ymmv.fyi");
    }
    expect(serverOrigin("https://ymmv.fyi")).toBe("https://ymmv.fyi");
    expect(serverOrigin("http://localhost:8788")).toBe("http://localhost:8788");
    expect(serverOrigin("https://ymmv.fyi.evil.com")).toBe("https://ymmv.fyi.evil.com");
  });

  it("never throws: an ungated logout BASE and every token.json base can be anything", () => {
    expect(serverOrigin("localhost:4321")).toBe("localhost:4321");
    expect(serverOrigin("not a url")).toBe("not a url");
  });

  it("a token stored under an alias belongs to the default server; other servers don't", () => {
    expect(isSameServer("https://ymmv.fyi")).toBe(true);
    expect(isSameServer("https://www.ymmv.fyi")).toBe(true);
    expect(isSameServer("http://ymmv.fyi")).toBe(true);
    expect(isSameServer("https://staging.example")).toBe(false);
    expect(isSameServer("B")).toBe(false);
  });

  /** config.ts re-imported with BASE baked from `base`: BASE is fixed at import. */
  async function configUnder(base: string): Promise<typeof import("../src/config.js")> {
    vi.resetModules();
    vi.stubEnv("YMMV_API", base);
    return import("../src/config.js");
  }

  it("under an alias BASE (logout skips the gate), a token stored under ymmv.fyi is the same server", async () => {
    // `YMMV_API=https://www.ymmv.fyi ymmv logout` over a login minted at https://ymmv.fyi: the
    // revoke goes to https://ymmv.fyi either way, so that token must count as retirable here.
    try {
      const fresh = await configUnder("https://www.ymmv.fyi");
      expect(fresh.BASE).toBe("https://www.ymmv.fyi");
      expect(fresh.serverOrigin()).toBe("https://ymmv.fyi");
      expect(fresh.isSameServer("https://ymmv.fyi")).toBe(true);
      expect(fresh.isSameServer("http://ymmv.fyi")).toBe(true);
      expect(fresh.isSameServer("https://staging.example")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("under any other BASE, only that exact base is the same server (a ymmv.fyi token is not)", async () => {
    try {
      const fresh = await configUnder("https://staging.example");
      expect(fresh.serverOrigin()).toBe("https://staging.example");
      expect(fresh.isSameServer("https://staging.example")).toBe(true);
      expect(fresh.isSameServer("https://ymmv.fyi")).toBe(false);
      expect(fresh.isSameServer("https://www.ymmv.fyi")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
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
