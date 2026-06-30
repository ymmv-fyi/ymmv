import { type Profile, SCHEMA_VERSION } from "@ymmv/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ensureLogin/publishProfile resolve identity through the token store; mock it so no real login or
// disk IO happens, and stub global fetch per branch. device-flow is mocked as insurance against an
// accidental login() (it should never be reached when loadToken returns a credential).
vi.mock("../src/token-store.js");
vi.mock("../src/device-flow.js");

import { publish, runDelete, runSet, view } from "../src/commands.js";
import type { Prompter } from "../src/prompt.js";
import { deleteToken, loadToken } from "../src/token-store.js";

function prof(
  handle: string,
  entries: Profile["entries"] = [],
  extras: Profile["extras"] = [],
): Profile {
  return { schema_version: SCHEMA_VERSION, handle, entries, extras, updated_at: "2026-01-01" };
}
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const missing = () => new Response("not found", { status: 404 });
const fail = (status: number) => new Response("err", { status }); // a real error, NOT a 404

let logs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe("view — the 3 branches", () => {
  it("unknown handle → friendly not-found (no diff)", async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(missing()));
    await view("ghost");
    expect(logs.join("\n")).toMatch(/no ymmv profile for "ghost"/);
  });

  it("logged in WITH a profile → renders the diff", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonRes(prof("antfu", [{ key: "shell", value: "fish" }]))) // theirs
        .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "shell", value: "zsh" }]))), // mine
    );
    await view("antfu");
    expect(logs.join("\n")).toMatch(/your mileage may vary/);
  });

  it("logged in WITHOUT a profile → plain view + amber nudge", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonRes(prof("antfu", [{ key: "shell", value: "fish" }]))) // theirs
        .mockResolvedValueOnce(missing()), // mine: none yet
    );
    await view("antfu");
    expect(logs.join("\n")).toMatch(/publish yours to diff/);
  });

  it("logged out → plain view, no nudge/diff", async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(jsonRes(prof("antfu", [{ key: "shell", value: "fish" }]))),
    );
    await view("antfu");
    const out = logs.join("\n");
    expect(out).toMatch(/antfu/);
    expect(out).not.toMatch(/publish yours to diff/);
    expect(out).not.toMatch(/your mileage may vary/);
  });
});

describe("publish", () => {
  it("refuses to publish when the bound handle is null (reserved GitHub username)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: null });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: false });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("interactive: the edited values are what get published", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing()) // GET existing → none
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    const prompter: Prompter = {
      // accept the Editor value, skip every other curated key
      ask: vi.fn(async (label: string) => (label === "Editor" ? "Neovim" : "")),
      confirm: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
    };
    await publish({ interactive: true, yes: false, prompter });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toEqual([{ key: "editor", value: "Neovim" }]);
    expect(body.handle).toBe("me");
  });

  it("interactive: declining the confirm publishes nothing", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn().mockResolvedValueOnce(missing()); // only the GET existing
    vi.stubGlobal("fetch", fetchFn);
    const prompter: Prompter = {
      ask: vi.fn(async () => ""),
      confirm: vi.fn().mockResolvedValue(false),
      close: vi.fn(),
    };
    await publish({ interactive: true, yes: false, prompter });
    // GET happened, but no POST
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
    expect(logs.join("\n")).toMatch(/Aborted/);
  });

  it("aborts (no POST) when loading the existing profile transiently fails", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn().mockResolvedValue(fail(500)); // GET existing → 5xx, not a 404
    vi.stubGlobal("fetch", fetchFn);
    await expect(publish({ interactive: false, yes: true })).rejects.toThrow(/fetch failed/);
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });
});

describe("set", () => {
  it("curated: merges into the existing profile and republishes the union", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }]))) // GET existing
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "curated", key: "shell", value: "zsh" });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toEqual(
      expect.arrayContaining([
        { key: "editor", value: "Vim" },
        { key: "shell", value: "zsh" },
      ]),
    );
    expect(logs.join("\n")).toMatch(/Set Shell = zsh/);
  });

  it("extra: adds a free-form extra even with no existing profile", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing()) // no existing profile
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "extra", label: "Launcher", value: "Raycast" });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.extras).toEqual([{ label: "Launcher", value: "Raycast" }]);
  });

  it("refuses when the bound handle is null (reserved username)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: null });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "curated", key: "shell", value: "zsh" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("aborts (no republish) when loading the existing profile transiently fails", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(500)));
    await expect(runSet({ kind: "curated", key: "shell", value: "zsh" })).rejects.toThrow(
      /fetch failed/,
    );
  });
});

describe("delete", () => {
  it("non-interactive WITHOUT -y: refuses (no network, no token drop, exit 1)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await runDelete({ interactive: false, yes: false });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("non-interactive WITH -y: deletes server-side, then drops the now-dead local token", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes({ ok: true })));
    await runDelete({ interactive: false, yes: true });
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toMatch(/Deleted ymmv\.fyi\/me/);
  });

  it("interactive: a 'no' at the confirm cancels without touching anything", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const prompter: Prompter = {
      ask: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
      close: vi.fn(),
    };
    await runDelete({ interactive: true, yes: false, prompter });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/Cancelled/);
  });
});
