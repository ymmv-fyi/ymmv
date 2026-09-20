import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/token-store.js");
// Partial: the transport fns are mocked, but MintRejected stays real — api.ts must recognise the
// class a real mint throws, and an automocked constructor would produce message-less instances.
vi.mock("../src/auth-http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth-http.js")>()),
  mintYmmvToken: vi.fn(),
  revokeYmmvToken: vi.fn(),
}));
// Partial: login is mocked, but `retirable` (the same-base/non-blank predicate logout shares with
// login) stays real so logout's corrupt-file fallback is exercised against the actual rule.
vi.mock("../src/device-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/device-flow.js")>()),
  login: vi.fn(),
}));
// Partial: only publish is mocked, so the dispatch's io can be inspected without a run that would
// touch the REAL dismissals file in the user's config dir. Every other command stays real.
vi.mock("../src/commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands.js")>()),
  publish: vi.fn(),
}));

import { type Profile, SCHEMA_VERSION } from "@ymmv/shared";
import { deleteProfile, ProfileChanged, PublishRefusal, publishProfile } from "../src/api.js";
import { MintRejected, revokeYmmvToken } from "../src/auth-http.js";
import { publish } from "../src/commands.js";
import { BASE } from "../src/config.js";
import { login } from "../src/device-flow.js";
import { dismissalsPath } from "../src/dismissals.js";
import { NetworkError } from "../src/http.js";
import { main } from "../src/index.js";
import {
  type Credential,
  deleteToken,
  loadCredential,
  loadToken,
  peekBase,
  peekCredential,
  type StoredToken,
} from "../src/token-store.js";

const PROFILE: Profile = {
  schema_version: SCHEMA_VERSION,
  handle: "carol",
  entries: [],
  extras: [],
  updated_at: "x",
};

/** A file credential as loadToken returns it. Ids: 1001 is the account this run logged in as,
 *  2002 a stranger; no user-facing message may ever contain either. */
const stored = (o: Partial<StoredToken> = {}): StoredToken => ({
  base: "B",
  token: "t",
  handle: "carol",
  github_id: 1001,
  ...o,
});

/** The credential a command merged its profile under, as passed to publishProfile. MINE is the
 *  normal case; LEGACY is a pre-#57 token.json (no id) at command start. */
const asMine = (c: StoredToken): Credential => ({ ...c, source: "file" });
const MINE = asMine(stored());
const MINE_OLD = asMine(stored({ handle: "old" }));
const LEGACY = asMine(stored({ github_id: null }));
const LEGACY_OLD = asMine(stored({ handle: "old", github_id: null }));

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status: code });

let logs: string[];
let errs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  // Default credential source mirrors the real file path: whatever loadToken is stubbed to return,
  // tagged source "file". Env-credential tests override loadCredential directly.
  vi.mocked(loadCredential).mockImplementation(async () => {
    const stored = await loadToken();
    return stored ? { ...stored, source: "file" } : null;
  });
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

// The config gate runs before ANY dispatch. baseProblem() reads the env at CALL time (BASE itself
// bakes at import, which setup-env pins to the default), so stubbing here exercises the gate;
// the validator's shape rules live in config.test.ts as pure-function cases.
describe("YMMV_API startup validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a scheme-less YMMV_API fails fast naming the variable, not the network", async () => {
    // Previously this surfaced as fetch throwing inside safeFetch: "Can't reach localhost:4321.
    // Check your connection" — a config mistake dressed as a connectivity failure.
    vi.stubEnv("YMMV_API", "localhost:4321");
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await main(["someuser"]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("YMMV_API");
    expect(errs.join("\n")).toMatch(/http/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(loadToken).not.toHaveBeenCalled();
  });

  it("gates every verb, help included (config errors never lie dormant)", async () => {
    vi.stubEnv("YMMV_API", "https://x.dev/api");
    await main(["help"]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("YMMV_API");
    expect(logs.join("\n")).not.toContain("Usage:");
  });

  it("a valid override (trailing slash included) dispatches normally", async () => {
    vi.stubEnv("YMMV_API", "https://x.dev/");
    await main(["help"]);
    expect(process.exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("Usage:");
  });

  it("logout is EXEMPT from the gate (a token under a legacy base must stay revocable)", async () => {
    // Older CLIs accepted bases the gate now rejects; gating logout would permanently strand
    // those tokens (hand-deleting token.json orphans them server-side).
    vi.stubEnv("YMMV_API", "localhost:4321");
    vi.mocked(loadToken).mockResolvedValue(null);
    vi.mocked(peekBase).mockResolvedValue(null);
    await main(["logout"]);
    expect(process.exitCode).toBeUndefined();
    expect(errs.join("\n")).not.toContain("YMMV_API");
    expect(logs.join("\n")).toContain("Not logged in");
  });
});

describe("ymmv logout", () => {
  it("revokes server-side, then deletes the local file", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.mocked(revokeYmmvToken).mockResolvedValue(true);
    await main(["logout"]);
    expect(revokeYmmvToken).toHaveBeenCalledWith("t");
    expect(deleteToken).toHaveBeenCalledTimes(1);
  });

  it("clears a token file loadToken refuses (corrupt handle): revokes the live token inside, deletes the file", async () => {
    // login() reads the file leniently and sends that token as `revoke`; against a Worker that
    // predates the field it refuses with "run `ymmv logout` first". Logout must read the same
    // way, or that advice loops on "Not logged in" with the token still live.
    vi.mocked(loadToken).mockResolvedValue(null);
    vi.mocked(peekCredential).mockResolvedValue({ base: BASE, token: "t-corrupt" });
    vi.mocked(revokeYmmvToken).mockResolvedValue(true);
    await main(["logout"]);
    expect(revokeYmmvToken).toHaveBeenCalledWith("t-corrupt");
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("Logged out.");
  });

  it("a blank or other-base token in a refused file is still 'Not logged in' (nothing to revoke)", async () => {
    for (const cred of [
      { base: BASE, token: "   " },
      { base: "https://other.example", token: "t-other" },
    ]) {
      vi.clearAllMocks();
      logs.length = 0;
      vi.mocked(loadToken).mockResolvedValue(null);
      vi.mocked(peekCredential).mockResolvedValue(cred);
      vi.mocked(peekBase).mockResolvedValue(cred.base);
      await main(["logout"]);
      expect(revokeYmmvToken).not.toHaveBeenCalled();
      expect(deleteToken).not.toHaveBeenCalled();
      expect(logs.join("\n")).toMatch(/Not logged in/);
    }
  });

  it("KEEPS the local token when the revoke can't reach the server", async () => {
    // Class-truthful mock: the real revokeYmmvToken surfaces connectivity failures as safeFetch's
    // typed NetworkError — logout branches on that type, never on message text.
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.mocked(revokeYmmvToken).mockRejectedValue(new NetworkError("Can't reach B (offline)"));
    await main(["logout"]);
    expect(deleteToken).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("KEEPS the local token when the revoke times out (hung connection, not just refused)", async () => {
    // A BODY-read timeout escapes safeFetch's wrapper as the bare TimeoutError DOMException —
    // connectivity-shaped, so it must land in the couldn't-reach branch via isTimeoutError.
    vi.mocked(loadToken).mockResolvedValue(stored());
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
      vi.mocked(loadToken).mockResolvedValue(stored());
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

  it("sanitizes the other base before echoing it (token.json is untrusted print input)", async () => {
    const esc = String.fromCharCode(0x1b);
    vi.mocked(loadToken).mockResolvedValue(null);
    vi.mocked(peekBase).mockResolvedValue(`https://evil.example${esc}[31m`);
    await main(["logout"]);
    const out = logs.join("\n");
    expect(out).toContain("https://evil.example");
    expect(out).not.toContain(esc);
  });

  it("notes when the server had no active session for the revoked token", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.mocked(revokeYmmvToken).mockResolvedValue(false);
    await main(["logout"]);
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(logs).toContain("\n  Logged out (no active session on this server).");
  });

  it("prints the revoke-unreachable warning as an indented unit on stderr", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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

describe("ymmv publish dispatch", () => {
  // resolve.test proves the flag parses, commands.test proves publish honors it: this is the seam
  // between them. publish only ever learns where the dismissals live, and whether to empty them,
  // from what main hands it — wire either one wrong and --reset-marks silently does nothing.
  it("hands publish the dismissals file, and --reset-marks as the flag that empties it", async () => {
    await main([]);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ dismissalsPath: dismissalsPath(), resetMarks: false, yes: false }),
    );
    vi.mocked(publish).mockClear();
    await main(["--reset-marks"]);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ dismissalsPath: dismissalsPath(), resetMarks: true, yes: false }),
    );
  });
});

describe("If-Match precondition (publish)", () => {
  const headersOf = (fetchFn: { mock: { calls: unknown[][] } }, call: number) =>
    (fetchFn.mock.calls[call][1] as RequestInit).headers as Record<string, string>;

  it("sends the caller's tag verbatim as If-Match, and no header without one", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi.fn().mockResolvedValue(ok({ handle: "carol" }));
    vi.stubGlobal("fetch", fetchFn);
    await publishProfile(PROFILE, MINE, { ifMatch: '"2026-06-30T00:00:00.000Z"' });
    expect(headersOf(fetchFn, 0)["if-match"]).toBe('"2026-06-30T00:00:00.000Z"');
    await publishProfile(PROFILE, MINE);
    expect(headersOf(fetchFn, 1)["if-match"]).toBeUndefined();
  });

  it("412 → ProfileChanged with the re-run copy, one POST, no login", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValue(status(412, { error: "precondition_failed", message: "server copy" }));
    vi.stubGlobal("fetch", fetchFn);
    await expect(publishProfile(PROFILE, MINE, { ifMatch: '"x"' })).rejects.toThrow(
      "Your profile changed since this command read it. Re-run the command.",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
  });

  it("401 then 412 on the healed retry → ProfileChanged, and the retry re-sent the tag", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(status(401))
      .mockResolvedValueOnce(status(412, { error: "precondition_failed" }));
    vi.stubGlobal("fetch", fetchFn);
    await expect(publishProfile(PROFILE, MINE, { ifMatch: '"x"' })).rejects.toBeInstanceOf(
      ProfileChanged,
    );
    expect(login).toHaveBeenCalledTimes(1);
    expect(headersOf(fetchFn, 1)["if-match"]).toBe('"x"');
  });
});

describe("publish auto-reauth", () => {
  it("on 401: explains the re-login, deletes the token, re-logs-in, retries once", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    await publishProfile(PROFILE, MINE);
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const context = logs.indexOf("\n  Session expired. Logging in again to retry the publish.");
    expect(context).toBeGreaterThanOrEqual(0);
    expect(context).toBeLessThan(logs.indexOf("<device-flow-prompt>"));
  });

  it("on 409 (stale handle): explains, re-logs-in WITHOUT deleting, then REFUSES the rebound retry", async () => {
    vi.mocked(loadToken)
      .mockResolvedValueOnce(stored({ handle: "old" }))
      .mockResolvedValue(stored({ token: "t2", handle: "new" }));
    // handle_not_bound is what the server's bound-handle guard sends for a stale handle; the CLI
    // branches on the 409 status alone, never the error code.
    const fetchFn = vi.fn().mockResolvedValueOnce(status(409, { error: "handle_not_bound" }));
    vi.stubGlobal("fetch", fetchFn);
    // The caller merged this profile from a read of "old" — which after a rename may be a
    // squatter's profile. Publishing that pre-reauth merge under the newly bound "new" would be
    // a silent cross-identity write; a fresh run re-reads under "new" and merges correctly.
    await expect(publishProfile({ ...PROFILE, handle: "old" }, MINE_OLD)).rejects.toThrow(
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
    vi.mocked(loadToken).mockResolvedValue(
      stored({ token: "t2", handle: "mallory", github_id: 2002 }),
    );
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(/login changed/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("refuses the FIRST send on a same-account RENAME too (the handle half of the guard)", async () => {
    // Same id, different handle: the merge was built for "carol", the store now says "caroline".
    // For an env credential this handle comparison is the entire guard.
    vi.mocked(loadToken).mockResolvedValue(stored({ token: "t2", handle: "caroline" }));
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(/login changed/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a LEGACY caller credential (no id) with a store still lacking one sends: the one handle-only allowance", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored({ github_id: null }));
    const fetchFn = vi.fn().mockResolvedValue(ok({ handle: "carol" }));
    vi.stubGlobal("fetch", fetchFn);
    expect((await publishProfile(PROFILE, LEGACY)).handle).toBe("carol");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
  });

  it("a LEGACY caller credential whose store now carries an id is refused: the file was rewritten unverified", async () => {
    // A same-handle account switch via a concurrent login (or a heal whose retry then failed) would
    // otherwise pass the handle-only check with no id to compare. Refuse; a fresh run re-reads.
    vi.mocked(loadToken).mockResolvedValue(stored({ token: "t2", github_id: 2002 }));
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await expect(publishProfile(PROFILE, LEGACY)).rejects.toThrow(/login changed/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("not logged in at the first send: a login as the SAME account sends after the context line", async () => {
    vi.mocked(loadToken)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(stored({ token: "t2" }));
    const fetchFn = vi.fn().mockResolvedValue(ok({ handle: "carol" }));
    vi.stubGlobal("fetch", fetchFn);
    expect((await publishProfile(PROFILE, MINE)).handle).toBe("carol");
    expect(logs).toContain("\n  Not logged in. Logging in to publish.");
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("not logged in at the first send: a device flow a STRANGER approved is refused before any POST", async () => {
    // Same handle string, different account: exactly the reclaim shape the id guard exists for,
    // now on a credential the device flow minted seconds ago.
    vi.mocked(loadToken)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(stored({ token: "t2", github_id: 2002 }));
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(/login changed/);
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("not logged in at the first send: a login that persisted nothing is a refusal, not a second device flow", async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(/did not persist a token/);
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("not logged in at the first send: prints ONE context line, logs in, and a refused mint exits the loop", async () => {
    // token.json vanished mid-command (concurrent logout, or a heal that deleted it and whose
    // retry failed transiently). The device flow must be introduced, and an older Worker's
    // refused mint must be a PublishRefusal here too, not only inside the heal.
    vi.mocked(loadToken).mockResolvedValue(null);
    vi.mocked(login).mockRejectedValueOnce(
      new MintRejected("Unexpected response from B. Nothing was saved; run `ymmv login` again."),
    );
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const err = await publishProfile(PROFILE, MINE).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PublishRefusal);
    expect((err as Error).message).toMatch(/Unexpected response from/);
    expect(logs).toContain("\n  Not logged in. Logging in to publish.");
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses the FIRST send when the store now holds the SAME handle under a DIFFERENT account", async () => {
    // token.json vanished (concurrent logout) and ensureLogin ran a device flow a stranger who now
    // owns "carol" approved, or a concurrent `ymmv login` swapped accounts: the handle string
    // matches, only the id tells. The caller passes the credential it merged under.
    const mine = { ...stored(), source: "file" as const };
    vi.mocked(loadToken).mockResolvedValue(stored({ token: "t2", github_id: 2002 }));
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const err = await publishProfile(PROFILE, mine).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PublishRefusal);
    expect((err as Error).message).toMatch(/login changed/);
    expect((err as Error).message).not.toMatch(/1001|2002/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a VERIFIED env credential passed as `expected` is sent as-is, never re-read from the store", async () => {
    // The store only ever returns the RAW env credential: YMMV_HANDLE (unset here, so null) and no
    // id. Re-reading it would trip the drift guard on every publish that leaves YMMV_HANDLE
    // unset. process.env cannot drift inside one process, so the verified `expected` is the truth.
    const verified = { ...stored({ token: "ymmv_env", github_id: 2002 }), source: "env" as const };
    vi.mocked(loadCredential).mockResolvedValue({ ...verified, handle: null, github_id: null });
    const fetchFn = vi.fn().mockResolvedValue(ok({ handle: "carol" }));
    vi.stubGlobal("fetch", fetchFn);
    expect((await publishProfile(PROFILE, verified)).handle).toBe("carol");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(loadCredential).not.toHaveBeenCalled();
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ymmv_env");
    expect(JSON.parse(init.body as string).handle).toBe("carol");
  });

  it("a 200 with an unreadable body still reports SUCCESS (the commit already happened)", async () => {
    // A truncated/malformed success body must never resurface as a failed publish — the
    // interactive loop would falsely print "Nothing was published" for a live profile.
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    const res = await publishProfile(PROFILE, MINE);
    expect(res.handle).toBe("carol"); // login-bound fallback echo
  });

  it("sanitizes the server-echoed handle in the publish result (callers print it verbatim)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const esc = String.fromCharCode(0x1b); // explicit code point, never a raw literal
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ handle: `car${esc}[31mol` })));
    const res = await publishProfile(PROFILE, MINE);
    expect(res.handle).toBe("carol");
    expect(res.url).toMatch(/\/carol$/);
    expect(res.handle).not.toContain(esc);
  });

  it("REFUSES the 401 retry when re-login binds a DIFFERENT account (no cross-account clobber)", async () => {
    vi.mocked(loadToken)
      .mockResolvedValueOnce(stored()) // pre-send login
      .mockResolvedValue(stored({ token: "t2", handle: "mallory", github_id: 2002 })); // after the 401 re-login
    const fetchFn = vi.fn().mockResolvedValueOnce(status(401));
    vi.stubGlobal("fetch", fetchFn);
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(/different account.*mallory/i);
    expect(fetchFn).toHaveBeenCalledTimes(1); // the retry POST never went out
  });

  it("throws after a second auth failure (no infinite loop)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(401)));
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(/authentication failed/i);
  });

  it("second 409 handle_not_bound gets HONEST post-heal copy, never the server's 'run login and retry'", async () => {
    // Same handle re-minted → the rebind guard passes → retry → 409 again → final verdict. The
    // server's handle_not_bound message says "Run `ymmv login` and retry" — but the CLI has
    // ALREADY done exactly that; parroting it would send the user in a loop. Branch on the slug
    // and tell the truth instead.
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        status(409, {
          error: "handle_not_bound",
          message: "Publish uses the handle bound at login. Run `ymmv login` and retry.",
        }),
      ),
    );
    const err = await publishProfile(PROFILE, MINE).catch((e: Error) => e);
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
      .mockResolvedValueOnce(stored())
      .mockResolvedValue(stored({ token: "t2", handle: "mallory", github_id: 2002 }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(401)));
    await expect(publishProfile(PROFILE, MINE)).rejects.toBeInstanceOf(PublishRefusal);
    // Post-retry second-401 site:
    vi.clearAllMocks();
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(401)));
    await expect(publishProfile(PROFILE, MINE)).rejects.toBeInstanceOf(PublishRefusal);
  });

  it("the 412 site throws ProfileChanged, a PublishRefusal (the loop's exit contract)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(status(412, { error: "precondition_failed" })),
    );
    const err = await publishProfile(PROFILE, MINE, { ifMatch: '"x"' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProfileChanged);
    expect(err).toBeInstanceOf(PublishRefusal);
    expect(login).not.toHaveBeenCalled();
  });

  it("second 409 with a message-less handle_not_bound body gets the same honest copy", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(409, { error: "handle_not_bound" })));
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(
      /still refuses this handle after a fresh login/,
    );
  });

  it("second 409 with a DIFFERENT slug keeps that server message (only handle_not_bound is stale advice)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          status(409, { error: "handle_reused", message: "That handle moved to a new account." }),
        ),
    );
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(
      /That handle moved to a new account/,
    );
  });

  it("second 409 with a non-JSON or non-string-message body falls back too", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>proxy</html>", { status: 409 })),
    );
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(
      /handle is taken by another account/,
    );
    vi.mocked(login).mockClear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(409, { message: 123 })));
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(
      /handle is taken by another account/,
    );
  });

  it("sanitizes and caps a hostile second-409 message before it reaches the terminal", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const esc = String.fromCharCode(0x1b);
    const hostile = `bad ${esc}[2Jcopy ${"x".repeat(500)}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(409, { message: hostile })));
    const err = await publishProfile(PROFILE, MINE).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(esc);
    expect((err as Error).message.length).toBeLessThanOrEqual(201); // wireText cap + ellipsis
    expect((err as Error).message).toMatch(/^bad copy/);
  });

  it("a generic POST failure surfaces as publish failed with status and capped body", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(/publish failed: 500 boom/);
  });

  it("a generic POST failure with a {message} body surfaces the server's copy, not the dump", async () => {
    // The server's 4xx bodies carry curated human copy (422 caps, 400 schema upgrade); wrapping
    // it in `publish failed: 422 {...}` JSON noise defeats the point of writing it.
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          status(422, { error: "value_too_long", message: "Values are capped at 256 characters." }),
        ),
    );
    const err = await publishProfile(PROFILE, MINE).catch((e: Error) => e);
    expect((err as Error).message).toBe("Values are capped at 256 characters.");
    expect((err as Error).message).not.toMatch(/publish failed/);
  });

  it("a schema-rejection 400 surfaces the upgrade instruction AS a refusal (no retry loop)", async () => {
    // First-publish path: the read 404s (no profile), so the stale CLI reaches the POST and gets
    // the 400. No edit can change the compiled SCHEMA_VERSION — the interactive loop must exit.
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    const err = await publishProfile(PROFILE, MINE).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^Upgrade the ymmv CLI \(npm i -g ymmv-cli\)\.$/);
    expect(err).toBeInstanceOf(PublishRefusal);
  });

  // Identity rows the handle STRING can't see (issue #57): one test per row of the table in
  // api.ts, plus the fail-closed and refused-mint rows.
  describe("account-id rows", () => {
    const refusal = async (p: Profile = PROFILE, expected: Credential = MINE) => {
      const err = await publishProfile(p, expected).catch((e: Error) => e);
      expect(err).toBeInstanceOf(PublishRefusal);
      const msg = (err as Error).message;
      expect(msg).not.toMatch(/1001|2002/); // ids never print
      return msg;
    };

    it("401: SAME handle, DIFFERENT account (rename + squat) → refuses, retry never sent", async () => {
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored())
        .mockResolvedValue(stored({ token: "t2", github_id: 2002 }));
      const fetchFn = vi.fn().mockResolvedValueOnce(status(401));
      vi.stubGlobal("fetch", fetchFn);
      const msg = await refusal();
      expect(msg).toMatch(/"carol" now belongs to a different GitHub account/);
      expect(msg).toMatch(/Nothing was published/);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("409: SAME handle, DIFFERENT account → same squat refusal, never the 'publish under it' line", async () => {
      // The friendly rebound copy would walk the user's merge onto the stranger's profile.
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored())
        .mockResolvedValue(stored({ token: "t2", github_id: 2002 }));
      const fetchFn = vi.fn().mockResolvedValueOnce(status(409, { error: "handle_not_bound" }));
      vi.stubGlobal("fetch", fetchFn);
      const msg = await refusal();
      expect(msg).toMatch(/now belongs to a different GitHub account/);
      expect(msg).not.toMatch(/now binds/);
      expect(deleteToken).not.toHaveBeenCalled();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("401: SAME account, RENAMED handle → the rebound copy (the id proves it is not a different account)", async () => {
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored())
        .mockResolvedValue(stored({ token: "t2", handle: "caroline" }));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(status(401)));
      const msg = await refusal();
      expect(msg).toMatch(/now binds "caroline".*Re-run the command to publish under it/);
      expect(msg).not.toMatch(/different account/);
    });

    it("409: DIFFERENT handle AND DIFFERENT account → the two-handle copy, never 'now binds'", async () => {
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored({ handle: "old" }))
        .mockResolvedValue(stored({ token: "t2", handle: "new", github_id: 2002 }));
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(status(409, { error: "handle_not_bound" })),
      );
      const msg = await refusal({ ...PROFILE, handle: "old" }, MINE_OLD);
      expect(msg).toMatch(/different account \("new", not "old"\)/);
      expect(msg).not.toMatch(/now binds/);
    });

    it("LEGACY (pre-field token.json, no id): same handle after a 401 still retries (regression)", async () => {
      // The one deliberate handle-only heal: the file has no id to consult, and the re-login just
      // wrote one. A leaked `undefined` here (instead of null) would refuse every upgraded user.
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored({ github_id: null }))
        .mockResolvedValue(stored({ token: "t2" }));
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(status(401))
        .mockResolvedValueOnce(ok({ handle: "carol" }));
      vi.stubGlobal("fetch", fetchFn);
      const res = await publishProfile(PROFILE, LEGACY);
      expect(res.handle).toBe("carol");
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("LEGACY with a changed handle keeps today's status-based copy (401 different / 409 rebound)", async () => {
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored({ github_id: null }))
        .mockResolvedValue(stored({ token: "t2", handle: "mallory", github_id: 2002 }));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(status(401)));
      expect(await refusal(PROFILE, LEGACY)).toMatch(
        /different account \("mallory", not "carol"\)/,
      );
      vi.clearAllMocks();
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored({ handle: "old", github_id: null }))
        .mockResolvedValue(stored({ handle: "new" }));
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(status(409, { error: "handle_not_bound" })),
      );
      expect(await refusal({ ...PROFILE, handle: "old" }, LEGACY_OLD)).toMatch(/now binds "new"/);
    });

    it("LEGACY file whose re-login binds NO handle: the reserved-word line, no retry", async () => {
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored({ github_id: null }))
        .mockResolvedValue(stored({ token: "t2", handle: null }));
      const fetchFn = vi.fn().mockResolvedValueOnce(status(401));
      vi.stubGlobal("fetch", fetchFn);
      const msg = await refusal(PROFILE, LEGACY);
      expect(msg).toMatch(/no longer binds a handle/);
      expect(msg).not.toContain('""');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("a re-login that binds NO handle (reserved username) gets its own line, never an empty quoted handle", async () => {
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored())
        .mockResolvedValue(stored({ token: "t2", handle: null }));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(status(401)));
      const msg = await refusal();
      expect(msg).toMatch(/no longer binds a handle \(your GitHub username is a reserved word\)/);
      expect(msg).not.toContain('""');
    });

    it("same account, same handle: the retry goes out (the happy heal is unchanged)", async () => {
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored())
        .mockResolvedValue(stored({ token: "t2" }));
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(status(409, { error: "handle_not_bound" }))
        .mockResolvedValueOnce(ok({ handle: "carol" }));
      vi.stubGlobal("fetch", fetchFn);
      expect((await publishProfile(PROFILE, MINE)).handle).toBe("carol");
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("a DIFFERENT account with a reserved username: the different-account line wins, never 'your username'", async () => {
      // Precedence pin: a PROVEN account change is diagnosed before the null-handle line, so the
      // user is never told "your GitHub username is a reserved word" about a stranger's username.
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored())
        .mockResolvedValue(stored({ token: "t2", handle: null, github_id: 2002 }));
      const fetchFn = vi.fn().mockResolvedValueOnce(status(401));
      vi.stubGlobal("fetch", fetchFn);
      const msg = await refusal();
      expect(msg).toMatch(/bound a different GitHub account/);
      expect(msg).not.toMatch(/reserved word|now binds|""/);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("a mint the CLI refuses DURING the heal is a PublishRefusal: the loop exits, no second device flow", async () => {
      // A Worker one version behind rejects deterministically; as a plain Error the interactive
      // loop would re-offer `y`, run the device flow again, and orphan another minted token.
      vi.mocked(loadToken).mockResolvedValue(stored());
      vi.mocked(login).mockRejectedValueOnce(
        new MintRejected("Unexpected response from B. Nothing was saved; run `ymmv login` again."),
      );
      const fetchFn = vi.fn().mockResolvedValueOnce(status(401));
      vi.stubGlobal("fetch", fetchFn);
      const msg = await refusal();
      expect(msg).toMatch(/Unexpected response from/);
      expect(login).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("a re-login that persisted nothing is a refusal, not a SECOND unexplained device flow", async () => {
      vi.mocked(loadToken).mockResolvedValueOnce(stored()).mockResolvedValue(null); // token.json still absent after login()
      const fetchFn = vi.fn().mockResolvedValueOnce(status(401));
      vi.stubGlobal("fetch", fetchFn);
      const msg = await refusal();
      expect(msg).toMatch(/did not persist a token/);
      expect(login).toHaveBeenCalledTimes(1); // ensureLogin() would have run a second one
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("a post-reauth credential carrying NO id fails CLOSED: refuse, never retry the merge", async () => {
      // Defensive pin (an older CLI racing the file write is the only way here): idChanged is true
      // whenever the new credential can't prove its account. Assert the DIRECTION, not the copy —
      // an unproven identity must not receive the merge.
      vi.mocked(loadToken)
        .mockResolvedValueOnce(stored())
        .mockResolvedValue(stored({ token: "t2", github_id: null }));
      const fetchFn = vi.fn().mockResolvedValueOnce(status(401));
      vi.stubGlobal("fetch", fetchFn);
      await refusal();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });
});

describe("deleteProfile", () => {
  // The caller (runDelete) passes the credential it confirmed against — deleteProfile never
  // re-reads the store, so a concurrent login can't swap accounts between confirm and send.
  const FILE_CRED = {
    base: "B",
    token: "t",
    handle: "me",
    github_id: 1001,
    source: "file" as const,
  };

  it("sends a bearer DELETE with the PASSED credential and succeeds on 200", async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ ok: true }));
    vi.stubGlobal("fetch", fetchFn);
    await deleteProfile(FILE_CRED);
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({ authorization: "Bearer t" });
    // The store is never consulted: the confirmed credential is the one that deletes.
    expect(loadCredential).not.toHaveBeenCalled();
    expect(loadToken).not.toHaveBeenCalled();
  });

  it("does NOT auto-reauth on 401 — throws so the user re-confirms (never deletes a switched account)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(401)));
    await expect(deleteProfile(FILE_CRED)).rejects.toThrow(/session expired|ymmv login/i);
    expect(login).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
  });

  it("throws on a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(500)));
    await expect(deleteProfile(FILE_CRED)).rejects.toThrow(/delete failed/);
  });

  it("surfaces a {message} body instead of the raw dump (same rule as publish)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(status(422, { error: "nope", message: "The server said why." })),
    );
    const err = await deleteProfile(FILE_CRED).catch((e: Error) => e);
    expect((err as Error).message).toBe("The server said why.");
    expect((err as Error).message).not.toMatch(/delete failed/);
  });
});

describe("write rate limit (429)", () => {
  const limited = () =>
    new Response(
      JSON.stringify({
        error: "rate_limited",
        message: "Too many writes. Slow down and try again shortly.",
      }),
      { status: 429, headers: { "retry-after": "60" } },
    );

  it("publish surfaces the server message + retry-after (not a raw 'publish failed', no reauth loop)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(limited()));
    await expect(publishProfile(PROFILE, MINE)).rejects.toThrow(/slow down.*retry in 60s/i);
    expect(login).not.toHaveBeenCalled(); // 429 is not 401/409 — no reauth loop
  });

  it("delete surfaces the rate-limit message + retry-after", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(limited()));
    await expect(
      deleteProfile({ base: "B", token: "t", handle: "me", github_id: 1001, source: "file" }),
    ).rejects.toThrow(/retry in 60s/i);
  });

  it("drops the retry hint when retry-after is not the seconds form (HTTP-date)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const dated = new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "retry-after": "Thu, 03 Jul 2026 04:00:00 GMT" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(dated));
    const err = await publishProfile(PROFILE, MINE).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/rate limited/i);
    expect((err as Error).message).not.toContain("retry in");
  });
});

// An env credential is read-only config: it must never enter the file-token heal paths
// (deleteToken / device-flow re-login), and its error copy names the VARIABLE — never the value.
describe("env credential (YMMV_TOKEN) API paths", () => {
  // As verifyEnvCredential returns it: the handle and id came from whoami.
  const envCred = {
    base: "B",
    token: "ymmv_env",
    handle: "carol",
    github_id: 2002,
    source: "env" as const,
  };

  it("an UNVERIFIED env credential (no whoami id) is refused before any request, publish and delete", async () => {
    // The raw shape loadCredential() returns: YMMV_HANDLE's claim, no id. Only verifyEnvCredential
    // ever sets an env credential's github_id, so null here means a call site skipped ensureLogin
    // and would act on an unverified handle. Structural, not a comment: it must fail loudly.
    const raw = { ...envCred, github_id: null };
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const err: unknown = await publishProfile(PROFILE, raw).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishRefusal);
    expect(String(err)).toContain("was not verified");
    await expect(deleteProfile(raw)).rejects.toThrow("was not verified");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
  });

  it("a FILE `expected` whose store re-read comes back RAW env is refused before the POST", async () => {
    // The SECOND guard, not the one on `expected`: the caller merged under a file login, and the
    // re-read resolved to YMMV_TOKEN instead (set mid-command, or a call site that skipped
    // ensureLogin). That credential is unverified, so it must not go out under the file handle.
    vi.mocked(loadCredential).mockResolvedValue({ ...envCred, github_id: null });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const err: unknown = await publishProfile(PROFILE, MINE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishRefusal);
    expect(String(err)).toContain("was not verified");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("publish 401 refuses naming YMMV_TOKEN: one POST, file token kept, no re-login", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred);
    const fetchFn = vi.fn().mockResolvedValueOnce(status(401));
    vi.stubGlobal("fetch", fetchFn);
    const err: unknown = await publishProfile(PROFILE, envCred).catch((e: unknown) => e);
    // PublishRefusal, not Error: deterministic for this process (no edit changes the env), so the
    // interactive loop must exit instead of re-offering a retry that fails identically.
    expect(err).toBeInstanceOf(PublishRefusal);
    expect(String(err)).toContain("YMMV_TOKEN");
    expect(String(err)).not.toContain("ymmv_env"); // the secret never echoes
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(deleteToken).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("publish 409 refuses with re-run advice: the handle came from whoami, so the bind just changed", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred);
    const fetchFn = vi.fn().mockResolvedValueOnce(status(409, { error: "handle_not_bound" }));
    vi.stubGlobal("fetch", fetchFn);
    const err: unknown = await publishProfile(PROFILE, envCred).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishRefusal);
    expect(String(err)).toContain("YMMV_TOKEN");
    expect(String(err)).toContain("Re-run the command.");
    // YMMV_HANDLE is no longer an input here; blaming it would send the user to the wrong fix.
    expect(String(err)).not.toContain("YMMV_HANDLE");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(deleteToken).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("delete 401 names YMMV_TOKEN, not the `ymmv login` advice a file session gets", async () => {
    const fetchFn = vi.fn().mockResolvedValue(status(401));
    vi.stubGlobal("fetch", fetchFn);
    const err = await deleteProfile(envCred).catch((e: Error) => e);
    expect((err as Error).message).toContain("YMMV_TOKEN");
    expect((err as Error).message).not.toContain("ymmv login");
    // Same read-only contract as publish: one DELETE, no heal, file token untouched.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(deleteToken).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });
});

describe("YMMV_TOKEN startup validation + logout note", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("a malformed YMMV_TOKEN fails fast pre-dispatch, naming the variable, never echoing it", async () => {
    vi.stubEnv("YMMV_TOKEN", "bad token");
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await main(["someuser"]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("YMMV_TOKEN");
    expect(errs.join("\n")).not.toContain("bad token");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("an invalid YMMV_HANDLE fails fast the same way (only when a token is set)", async () => {
    vi.stubEnv("YMMV_TOKEN", "ymmv_env");
    vi.stubEnv("YMMV_HANDLE", "-bad-");
    await main(["help"]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("YMMV_HANDLE");
  });

  it("logout is EXEMPT from the env gate (a malformed env token must not strand the file logout)", async () => {
    vi.stubEnv("YMMV_TOKEN", "bad token");
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.mocked(revokeYmmvToken).mockResolvedValue(true);
    await main(["logout"]);
    expect(process.exitCode).toBeUndefined();
    expect(revokeYmmvToken).toHaveBeenCalledWith("t"); // the FILE token, never the env one
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("Logged out.");
  });

  it("logout with YMMV_TOKEN set keeps file semantics and notes the env token persists", async () => {
    vi.stubEnv("YMMV_TOKEN", "ymmv_env");
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.mocked(revokeYmmvToken).mockResolvedValue(true);
    await main(["logout"]);
    expect(revokeYmmvToken).toHaveBeenCalledWith("t");
    expect(deleteToken).toHaveBeenCalledTimes(1);
    // The note is diagnostic (stderr): "logged out" must not read as "unauthenticated".
    expect(errs.join("\n")).toContain("YMMV_TOKEN is set and still authenticates");
  });
});
