import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/token-store.js");
vi.mock("../src/update.js");
vi.mock("../src/update-check.js", { spy: true });

import { main } from "../src/index.js";
import { loadCredential, loadToken, peekBase } from "../src/token-store.js";
import { runUpdate } from "../src/update.js";
import { isNewer, ownVersion, readCachedLatest, startUpdateCheck } from "../src/update-check.js";

// main()'s update-check WIRING — which commands start a check, where the notice lands, and the
// gate/throw semantics. The check itself is unit-tested in update-check.test.ts; here
// startUpdateCheck is spied/stubbed so no gating (dev 0.0.0, non-TTY stderr, the suite kill
// switch) can hide the wiring under test.

let logs: string[];
let errs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadToken).mockResolvedValue(null);
  vi.mocked(peekBase).mockResolvedValue(null);
  vi.mocked(loadCredential).mockResolvedValue(null);
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function stubNotice(text: string | null): {
  finish: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
} {
  const finish = vi.fn(async () => text);
  const abort = vi.fn();
  vi.mocked(startUpdateCheck).mockReturnValue({ finish, abort });
  return { finish, abort };
}

/** Force process.stderr.isTTY for a test body (vitest pipes it, so it's normally falsy). */
async function withStderrTTY(fn: () => Promise<void>): Promise<void> {
  const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  try {
    await fn();
  } finally {
    if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    else Reflect.deleteProperty(process.stderr, "isTTY");
  }
}

describe("main() update-check wiring", () => {
  it("an eligible command starts the check and prints the notice on stderr after its output", async () => {
    stubNotice("UPDATE NOTICE");
    await main(["logout"]);
    expect(startUpdateCheck).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("Not logged in.");
    expect(errs.join("\n")).toContain("UPDATE NOTICE");
    expect(errs.join("\n")).toContain("\n  UPDATE NOTICE"); // message()-wrapped output unit
  });

  it.each([
    ["help"],
    ["version"],
    ["--version"],
  ])("`%s` never starts a check (reference surfaces stay exactly themselves)", async (arg) => {
    stubNotice("UPDATE NOTICE");
    await main([arg]);
    expect(startUpdateCheck).not.toHaveBeenCalled();
    expect(errs.join("\n")).not.toContain("UPDATE NOTICE");
  });

  it("an arg error never starts a check", async () => {
    stubNotice("UPDATE NOTICE");
    await main(["--bogus"]);
    expect(startUpdateCheck).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("`ymmv update` never starts a check (it IS the update action)", async () => {
    stubNotice("UPDATE NOTICE");
    await main(["update"]);
    expect(startUpdateCheck).not.toHaveBeenCalled();
    expect(runUpdate).toHaveBeenCalledTimes(1);
  });

  it("the notice still prints after an exitCode-style failure", async () => {
    // Non-TTY stdin (vitest) + no -y: publish refuses with exit 1 BEFORE any network/login.
    stubNotice("UPDATE NOTICE");
    await main(["publish"]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("UPDATE NOTICE");
  });

  it("a THROWN command skips the notice but ABORTS the in-flight check", async () => {
    // finish() is the only other abort site; without the catch-side abort a live registry
    // socket would hold the process open up to the 2s fetch cap AFTER the error printed.
    const { finish, abort } = stubNotice("UPDATE NOTICE");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(main(["view", "ghost"])).rejects.toThrow();
    expect(finish).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(errs.join("\n")).not.toContain("UPDATE NOTICE");
  });

  it("`ymmv update` bypasses the config gate like logout (it never touches the ymmv API)", async () => {
    vi.stubEnv("YMMV_API", "localhost:4321"); // fails the gate for every gated command
    await main(["update"]);
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
    expect(errs.join("\n")).not.toContain("YMMV_API");
  });
});

describe("`ymmv version` latest hint", () => {
  it("prints on TTY stderr from a fresh newer cache; stdout stays the bare version line", async () => {
    // setup-env's suite-wide kill switch must not suppress the hint here: empty string means
    // UNSET by the YMMV_* convention.
    vi.stubEnv("YMMV_NO_UPDATE_CHECK", "");
    vi.stubEnv("CI", ""); // GitHub Actions sets CI=true, which would legitimately suppress
    vi.mocked(ownVersion).mockReturnValue("0.8.0");
    vi.mocked(readCachedLatest).mockResolvedValue("0.9.0");
    await withStderrTTY(async () => {
      await main(["version"]);
    });
    expect(logs.join("\n")).toMatch(/^ymmv-cli /); // stdout: exactly the version surface
    expect(logs.join("\n")).not.toContain("latest:");
    expect(errs.join("\n")).toContain("latest: 0.9.0");
    expect(errs.join("\n")).toContain("ymmv update");
  });

  it("honors the opt-out env vars (no update surface anywhere when disabled)", async () => {
    // setup-env sets YMMV_NO_UPDATE_CHECK=1 for the whole suite — the hint must respect it.
    vi.mocked(ownVersion).mockReturnValue("0.8.0");
    vi.mocked(readCachedLatest).mockResolvedValue("0.9.0");
    await withStderrTTY(async () => {
      await main(["version"]);
    });
    expect(errs.join("\n")).not.toContain("latest:");
    expect(readCachedLatest).not.toHaveBeenCalled();
  });

  it("dev builds (0.0.0) never see a hint (any release would read as newer)", async () => {
    vi.stubEnv("YMMV_NO_UPDATE_CHECK", "");
    vi.stubEnv("CI", ""); // GitHub Actions sets CI=true, which would legitimately suppress
    vi.mocked(ownVersion).mockReturnValue("0.0.0");
    vi.mocked(readCachedLatest).mockResolvedValue("0.9.0");
    await withStderrTTY(async () => {
      await main(["version"]);
    });
    expect(errs.join("\n")).not.toContain("latest:");
  });

  it("equal or older cached latest prints nothing", async () => {
    vi.stubEnv("YMMV_NO_UPDATE_CHECK", "");
    vi.stubEnv("CI", ""); // GitHub Actions sets CI=true, which would legitimately suppress
    vi.mocked(ownVersion).mockReturnValue("0.9.0");
    vi.mocked(readCachedLatest).mockResolvedValue("0.9.0");
    vi.mocked(isNewer).mockReturnValue(false);
    await withStderrTTY(async () => {
      await main(["version"]);
    });
    expect(errs.join("\n")).not.toContain("latest:");
  });
});
