import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real fs (NOT mocked) against a throwaway temp dir, to prove the on-disk 0600 mode rather than just
// the writeFile argument. POSIX-only: chmod is a no-op on Windows (we rely on the %APPDATA% ACL
// there), and CI runners are linux. The factory references only the `process` global so it survives
// vi.mock hoisting.
vi.mock("env-paths", () => ({
  default: () => ({
    config: `${process.env.TMPDIR || process.env.TEMP || "/tmp"}/ymmv-perms-${process.pid}`,
  }),
}));

import { saveToken, tokenFilePath } from "../src/token-store.js";

afterAll(async () => {
  await rm(dirname(tokenFilePath()), { recursive: true, force: true }).catch(() => {});
});

describe("token file permissions (real fs)", () => {
  it.skipIf(process.platform === "win32")("writes token.json with mode 0600 on POSIX", async () => {
    await saveToken({ token: "ymmv_real", handle: "carol" });
    expect((await stat(tokenFilePath())).mode & 0o777).toBe(0o600);
  });
});
