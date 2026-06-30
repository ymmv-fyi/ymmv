import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { deleteToken, loadToken, peekBase, saveToken, tokenFilePath } from "../src/token-store.js";

const PATH = tokenFilePath();
const DIR = dirname(PATH);

beforeEach(() => vi.clearAllMocks());

describe("saveToken", () => {
  it("mkdirs, writes a unique 0600 temp file scoped to the base, chmods it, then atomically renames", async () => {
    await saveToken({ token: "ymmv_x", handle: "carol" });
    expect(mkdir).toHaveBeenCalledWith(DIR, { recursive: true });
    // unique temp name (not a fixed .tmp), written with mode 0600
    const tmp = vi.mocked(writeFile).mock.calls[0]?.[0] as string;
    expect(tmp).toMatch(/token\.json\..+\.tmp$/);
    expect(writeFile).toHaveBeenCalledWith(tmp, expect.any(String), { mode: 0o600 });
    const written = JSON.parse(vi.mocked(writeFile).mock.calls[0]?.[1] as string);
    expect(written).toEqual({ base: BASE, token: "ymmv_x", handle: "carol" });
    if (process.platform !== "win32") expect(chmod).toHaveBeenCalledWith(tmp, 0o600);
    expect(rename).toHaveBeenCalledWith(tmp, PATH);
  });
});

describe("loadToken", () => {
  it("returns the stored token when the base matches", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: BASE, token: "ymmv_x", handle: "carol" }),
    );
    expect(await loadToken()).toEqual({ base: BASE, token: "ymmv_x", handle: "carol" });
  });

  it("returns null when the stored base differs (base-scoping)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ base: `${BASE}-other`, token: "ymmv_x", handle: "c" }),
    );
    expect(await loadToken()).toBeNull();
  });

  it("returns null on a missing file", async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));
    expect(await loadToken()).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    vi.mocked(readFile).mockResolvedValue("{not json");
    expect(await loadToken()).toBeNull();
  });
});

describe("deleteToken / peekBase", () => {
  it("force-removes the token file", async () => {
    await deleteToken();
    expect(rm).toHaveBeenCalledWith(PATH, { force: true });
  });

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
