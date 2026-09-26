import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("env-paths", () => ({ default: vi.fn(() => ({ config: "/fake/cfg" })) }));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
}));

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BASE } from "../src/config.js";
import {
  deleteTokenIf,
  loadCredential,
  loadToken,
  peekBase,
  peekCredential,
  saveToken,
  tokenFilePath,
} from "../src/token-store.js";

const PATH = tokenFilePath();
const DIR = dirname(PATH);

beforeEach(() => vi.clearAllMocks());

describe("saveToken", () => {
  it("mkdirs a 0700 dir, writes a unique 0600 temp file scoped to the base, chmods it, then atomically renames", async () => {
    await saveToken({ token: "ymmv_x", handle: "carol", github_id: 4242 });
    expect(mkdir).toHaveBeenCalledWith(DIR, { recursive: true, mode: 0o700 });
    // POSIX also chmods the dir 0o700 to tighten a pre-existing world-traversable dir.
    if (process.platform !== "win32") expect(chmod).toHaveBeenCalledWith(DIR, 0o700);
    // unique temp name (not a fixed .tmp), written with mode 0600
    const tmp = vi.mocked(writeFile).mock.calls[0]?.[0] as string;
    expect(tmp).toMatch(/token\.json\..+\.tmp$/);
    expect(writeFile).toHaveBeenCalledWith(tmp, expect.any(String), { mode: 0o600 });
    const written = JSON.parse(vi.mocked(writeFile).mock.calls[0]?.[1] as string);
    expect(written).toEqual({ base: BASE, token: "ymmv_x", handle: "carol", github_id: 4242 });
    if (process.platform !== "win32") expect(chmod).toHaveBeenCalledWith(tmp, 0o600);
    expect(rename).toHaveBeenCalledWith(tmp, PATH);
  });
});

describe("loadToken", () => {
  it("returns the stored token when the base matches", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_x", handle: "carol", github_id: 4242 }),
    );
    expect(await loadToken()).toEqual({
      base: BASE,
      token: "ymmv_x",
      handle: "carol",
      github_id: 4242,
    });
  });

  // github_id: ABSENT is the legacy pre-field file and must keep loading (as null, never as
  // undefined — the reauth guard's `!== null` test would read undefined as a known id and refuse
  // every legacy heal). PRESENT but invalid is corruption like any other field.
  it("a legacy file without github_id loads with github_id: null (NOT logged out)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_x", handle: "carol" }),
    );
    const loaded = await loadToken();
    expect(loaded).toEqual({ base: BASE, token: "ymmv_x", handle: "carol", github_id: null });
    expect(loaded && "github_id" in loaded).toBe(true); // present as null, not merely absent
  });

  it("an explicit github_id: null loads as null too", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_x", handle: "carol", github_id: null }),
    );
    expect((await loadToken())?.github_id).toBeNull();
  });

  it("returns null (logged out) when github_id is present but not a GitHub id (hand-edited file)", async () => {
    for (const bad of [0, -1, 1.5, "4242", 2 ** 53, true]) {
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({ base: BASE, token: "ymmv_x", handle: "carol", github_id: bad }),
      );
      expect(await loadToken()).toBeNull();
    }
  });

  it("reads a hand-edited empty-string handle as null (same normalization as the mint boundary)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_x", handle: "", github_id: 4242 }),
    );
    expect((await loadToken())?.handle).toBeNull();
  });

  it("drops stray keys from the file (explicit fields, not a cast)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_x", handle: "carol", github_id: 1, extra: "x" }),
    );
    expect(await loadToken()).toEqual({
      base: BASE,
      token: "ymmv_x",
      handle: "carol",
      github_id: 1,
    });
  });

  it("returns null when the stored base differs (base-scoping)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: `${BASE}-other`, token: "ymmv_x", handle: "c" }),
    );
    expect(await loadToken()).toBeNull();
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: 5, token: "ymmv_x", handle: "c" }),
    );
    expect(await loadToken()).toBeNull();
  });

  it("reads a login stored under a ymmv.fyi alias as ymmv.fyi's, the rule login retires by", async () => {
    // An older CLI stored these under www or http. Read any stricter than retirable(), the login
    // would read as logged out and the next sign-in would revoke it without `ymmv login`'s consent.
    expect(BASE).toBe("https://ymmv.fyi");
    for (const base of ["https://www.ymmv.fyi", "https://ymmv.fyi.", "https://www.ymmv.fyi:443"]) {
      const stored = { base, token: "ymmv_x", handle: "carol", github_id: 4242 };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(stored));
      expect(await loadToken(), base).toEqual(stored);
    }
  });

  it("reads a login stored through plain http to ymmv.fyi as logged out, so the next sign-in retires it", async () => {
    // That token crossed the network in cleartext and never expires. retirable() still accepts
    // it (device-flow and cli logout tests), so login's mint revokes it and logout still can.
    for (const base of ["http://ymmv.fyi", "http://www.ymmv.fyi", "http://ymmv.fyi:8080"]) {
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({ base, token: "ymmv_x", handle: "carol", github_id: 4242 }),
      );
      expect(await loadToken(), base).toBeNull();
    }
  });

  it("returns null on a missing file", async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));
    expect(await loadToken()).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    vi.mocked(readFile).mockResolvedValue("{not json");
    expect(await loadToken()).toBeNull();
  });

  // Corrupt-file shapes read as logged-out (clean re-login) instead of surfacing the misleading
  // "reserved word" copy (missing handle) or crashing later on .toLowerCase() (non-string handle).
  it("returns null (no throw) when the file holds literal JSON null", async () => {
    vi.mocked(readFile).mockResolvedValue("null");
    expect(await loadToken()).toBeNull();
  });

  it("returns null when handle is absent (truncated/foreign-schema file)", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ base: BASE, token: "ymmv_x" }));
    expect(await loadToken()).toBeNull();
  });

  it("returns null when handle is a non-string (hand-edited file)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_x", handle: 5 }),
    );
    expect(await loadToken()).toBeNull();
  });

  it("returns null on an empty-string token (a `Bearer ` request is corruption, not a login)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "", handle: "carol" }),
    );
    expect(await loadToken()).toBeNull();
  });

  it("still loads handle: null (the legit reserved-username state)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_x", handle: null, github_id: 4242 }),
    );
    expect(await loadToken()).toEqual({
      base: BASE,
      token: "ymmv_x",
      handle: null,
      github_id: 4242,
    });
  });
});

describe("peekCredential", () => {
  it("returns base + token from a corrupt-handle file loadToken rejects (revoke path)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_x", handle: 5 }),
    );
    expect(await loadToken()).toBeNull(); // strict reader: logged out
    expect(await peekCredential()).toEqual({ base: BASE, token: "ymmv_x" }); // lenient: revocable
  });

  it("returns base + token from a corrupt-github_id file too (a bad id must not strand a live token)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_x", handle: "carol", github_id: "nope" }),
    );
    expect(await loadToken()).toBeNull();
    expect(await peekCredential()).toEqual({ base: BASE, token: "ymmv_x" });
  });

  it("returns a foreign-base credential (login's cross-base warn needs it)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: "https://other.example", token: "ymmv_y", handle: "c" }),
    );
    expect(await peekCredential()).toEqual({ base: "https://other.example", token: "ymmv_y" });
  });

  it("returns null on a missing file, malformed JSON, a null root, or a token-less shape", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"));
    expect(await peekCredential()).toBeNull();
    vi.mocked(readFile).mockResolvedValueOnce("{not json");
    expect(await peekCredential()).toBeNull();
    vi.mocked(readFile).mockResolvedValueOnce("null");
    expect(await peekCredential()).toBeNull();
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ base: BASE }));
    expect(await peekCredential()).toBeNull();
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ base: BASE, token: "" }));
    expect(await peekCredential()).toBeNull(); // nothing to revoke behind `Bearer `
  });
});

describe("loadCredential", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers YMMV_TOKEN over the file token: source env, base BASE, handle from YMMV_HANDLE", async () => {
    vi.stubEnv("YMMV_TOKEN", "ymmv_env");
    vi.stubEnv("YMMV_HANDLE", "carol");
    // A DIFFERENT file token exists and must not win (nor even be read for the result).
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_file", handle: "someone-else" }),
    );
    expect(await loadCredential()).toEqual({
      base: BASE,
      token: "ymmv_env",
      handle: "carol",
      github_id: null, // no trusted identity behind an env token
      source: "env",
    });
    expect(readFile).not.toHaveBeenCalled(); // env wins WITHOUT touching the store
  });

  it("empty YMMV_TOKEN means unset: falls through to the file token with source file", async () => {
    vi.stubEnv("YMMV_TOKEN", "");
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_file", handle: "carol", github_id: 4242 }),
    );
    expect(await loadCredential()).toEqual({
      base: BASE,
      token: "ymmv_file",
      handle: "carol",
      github_id: 4242,
      source: "file",
    });
  });

  it("env token without YMMV_HANDLE (unset or empty) yields handle null", async () => {
    vi.stubEnv("YMMV_TOKEN", "ymmv_env");
    expect((await loadCredential())?.handle).toBeNull();
    vi.stubEnv("YMMV_HANDLE", "");
    expect((await loadCredential())?.handle).toBeNull();
  });

  it("returns null when neither an env token nor a stored file exists", async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));
    expect(await loadCredential()).toBeNull();
  });

  it("loadToken, peekCredential, and peekBase stay env-blind (revoke/logout must never see the env token)", async () => {
    vi.stubEnv("YMMV_TOKEN", "ymmv_env");
    vi.stubEnv("YMMV_HANDLE", "carol");
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));
    expect(await loadToken()).toBeNull();
    expect(await peekCredential()).toBeNull();
    expect(await peekBase()).toBeNull();
  });
});

describe("peekBase", () => {
  it("peekBase returns the stored base regardless of the current base", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: "https://other.example", token: "x", handle: null }),
    );
    expect(await peekBase()).toBe("https://other.example");
  });

  it("peekBase returns null when there's no file", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    expect(await peekBase()).toBeNull();
  });
});

describe("deleteTokenIf", () => {
  it("removes the file while it holds the refused token", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_dead", handle: "carol" }),
    );
    await deleteTokenIf("ymmv_dead");
    expect(rm).toHaveBeenCalledWith(PATH, { force: true });
  });

  it("removes a file loadToken refuses (corrupt handle, bad id): logout's leftover path relies on it", async () => {
    for (const bad of [{ handle: 42 }, { handle: "carol", github_id: "x" }]) {
      vi.mocked(rm).mockClear();
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({ base: BASE, token: "t-corrupt", ...bad }),
      );
      expect(await loadToken()).toBeNull();
      await deleteTokenIf("t-corrupt");
      expect(rm).toHaveBeenCalledWith(PATH, { force: true });
    }
  });

  it("rejects when the file can't be removed: callers print their note on that rejection", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_dead", handle: "carol" }),
    );
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error("EPERM"), { code: "EPERM" }));
    await expect(deleteTokenIf("ymmv_dead")).rejects.toMatchObject({ code: "EPERM" });
  });

  it("keeps a token a login wrote since (a different token), and a missing or corrupt file is a no-op", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({ base: BASE, token: "ymmv_fresh", handle: "carol" }),
    );
    await deleteTokenIf("ymmv_dead");
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"));
    await deleteTokenIf("ymmv_dead");
    vi.mocked(readFile).mockResolvedValueOnce("{not json");
    await deleteTokenIf("ymmv_dead");
    expect(rm).not.toHaveBeenCalled();
  });
});
