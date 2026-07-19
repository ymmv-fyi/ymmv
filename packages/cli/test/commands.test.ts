import { CURATED_KEYS, type Profile, SCHEMA_VERSION } from "@ymmv/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ensureLogin/publishProfile resolve identity through the token store; mock it so no real login or
// disk IO happens, and stub global fetch per branch. device-flow is mocked as insurance against an
// accidental login() (it should never be reached when loadToken returns a credential). detect is
// mocked so card-first publishes (which POST the merged defaults directly) never leak this
// machine's real environment into asserted request bodies.
vi.mock("../src/token-store.js");
vi.mock("../src/device-flow.js");
vi.mock("../src/detect.js");

import { publish, runDelete, runSet, runUnset, view } from "../src/commands.js";
import { detectStack } from "../src/detect.js";
import { login } from "../src/device-flow.js";
import { PromptAborted, type Prompter } from "../src/prompt.js";
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

/** Interface-complete scripted prompter — override only what a test drives. */
function stubPrompter(overrides: Partial<Prompter> = {}): Prompter {
  return { ask: vi.fn(), confirm: vi.fn(), choice: vi.fn(), close: vi.fn(), ...overrides };
}
/** The preview-card header line ("  ymmv.fyi/me\n") — distinct from the Published URL echo. */
const isCard = (l: string) => l.includes("  ymmv.fyi/me\n");

let logs: string[];
let errs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(detectStack).mockReturnValue(new Map());
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
    expect(logs.join("\n")).toMatch(/differs from/); // the diff title line
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
    // Junction pin: exactly ONE blank line between the card's updated line and the nudge.
    expect(logs.join("\n")).toMatch(/updated 2026-01-01\n\n {2}publish yours to diff/);
  });

  it("a transient failure on the OWN-profile fetch degrades honestly: card + stderr note, no nudge", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonRes(prof("antfu", [{ key: "shell", value: "fish" }]))) // theirs
        .mockResolvedValueOnce(fail(503)), // mine: a real error, NOT a 404
    );
    await view("antfu");
    const out = logs.join("\n");
    expect(out).toMatch(/antfu/); // the requested card still renders
    // The nudge would be wrong copy (this user may well have published) — the note replaces it,
    // on stderr so piped stdout stays deterministic. Exit stays 0: the view itself succeeded.
    expect(out).not.toMatch(/publish yours to diff/);
    expect(out).not.toMatch(/couldn't load your profile/);
    expect(errs.join("\n")).toContain("(couldn't load your profile to diff)");
    expect(process.exitCode).toBeUndefined();
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
    expect(out).not.toMatch(/differs from/); // no diff title on a plain view
  });
});

describe("publish", () => {
  it("refuses to publish when the bound handle is null (reserved GitHub username)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: null });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: true }); // -y so the non-TTY consent gate passes
    expect(fetchFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errs).toContain(
      "\n  Your GitHub username is a reserved word, so no handle is bound. " +
        "Rename on GitHub, then run `ymmv login` again.",
    );
  });

  it("non-interactive without -y: refuses before login (no device flow, no network, exit 1)", async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: false });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(loadToken).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errs).toContain(
      "\n  Non-interactive publish needs -y (nothing publishes unconfirmed): ymmv -y",
    );
  });

  it("hints when a legacy extra duplicates a curated field — recomputed per edit pass", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes(
          prof(
            "me",
            [],
            [
              { label: "Theme", value: "Nord" },
              { label: "Keyboard", value: "HHKB" },
            ],
          ),
        ),
      )
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({
      ask: vi.fn(async (label: string) => (label === "Theme" ? "Catppuccin" : "")),
      choice: vi.fn().mockResolvedValueOnce("e").mockResolvedValueOnce("y"),
    });
    await publish({ interactive: true, yes: false, prompter });
    const hint = /extra "Theme" duplicates a curated field; ymmv unset --extra "Theme"/;
    expect(logs.filter(isCard).length).toBe(2); // card before the edit pass, card after
    // No Theme value on the first card → no hint; the edit sets Theme → the SECOND card hints.
    const firstHint = logs.findIndex((l) => hint.test(l));
    const secondCard = logs.map(isCard).lastIndexOf(true);
    expect(firstHint).toBeGreaterThan(secondCard);
    expect(logs.filter((l) => hint.test(l)).length).toBe(1);
    expect(logs.join("\n")).not.toMatch(/extra "Keyboard" duplicates/);
  });

  it("interactive: the edited values are what get published", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing()) // GET existing → none
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({
      // accept the Editor value, skip every other curated key
      ask: vi.fn(async (label: string) => (label === "Editor" ? "Neovim" : "")),
      choice: vi.fn().mockResolvedValue("y"),
    });
    await publish({ interactive: true, yes: false, prompter });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toEqual([{ key: "editor", value: "Neovim" }]);
    expect(body.handle).toBe("me");
  });

  it("prints carried + dup-extra notes as ONE unit with 4-space carried rows", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const foreign = { key: "launcher", value: "Raycast" } as unknown as Profile["entries"][number];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes(
          prof("me", [foreign, { key: "editor", value: "Vim" }], [{ label: "Editor", value: "X" }]),
        ),
      )
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({ choice: vi.fn().mockResolvedValue("y") });
    await publish({ interactive: true, yes: false, prompter });
    // Both notes share one output unit; carried rows sit two spaces deeper than the note line.
    expect(logs).toContain(
      "\n  (+1 newer field kept as-is; upgrade ymmv-cli to edit them)" +
        "\n    launcher = Raycast" +
        '\n  (extra "Editor" duplicates a curated field; ymmv unset --extra "Editor")',
    );
  });

  // A newer taxonomy's keys (unknown to this build) must survive a bare publish — the upsert is a
  // full replace, so dropping them here would delete them server-side.
  it("republish: carries unknown keys through verbatim with zero prompts (card-first)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const foreign = { key: "launcher", value: "Raycast" } as unknown as Profile["entries"][number];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [foreign, { key: "editor", value: "Vim" }])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    const ask = vi.fn();
    const prompter = stubPrompter({ ask, choice: vi.fn().mockResolvedValue("y") });
    await publish({ interactive: true, yes: false, prompter });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toContainEqual(foreign);
    expect(body.entries).toContainEqual({ key: "editor", value: "Vim" });
    expect(ask).not.toHaveBeenCalled(); // card-first: Enter-to-publish, no field walk
    expect(logs.join("\n")).toMatch(/\+1 newer field kept as-is/);
    expect(logs.join("\n")).toMatch(/launcher = Raycast/); // carried rows are listed, not hidden
  });

  it("republish + e: the edit pass walks all curated keys, never the carried ones", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const foreign = { key: "launcher", value: "Raycast" } as unknown as Profile["entries"][number];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [foreign, { key: "editor", value: "Vim" }])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    const ask = vi.fn(async (_label: string, def?: string) => def ?? "");
    const prompter = stubPrompter({
      ask,
      choice: vi.fn().mockResolvedValueOnce("e").mockResolvedValueOnce("y"),
    });
    await publish({ interactive: true, yes: false, prompter });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toContainEqual(foreign);
    expect(body.entries).toContainEqual({ key: "editor", value: "Vim" });
    expect(ask).toHaveBeenCalledTimes(CURATED_KEYS.length); // one prompt per curated key, no more
    expect(ask.mock.calls.some((c) => /launcher/i.test(String(c[0])))).toBe(false);
  });

  it("prints the Published confirmation after y (the line has a positive pin, not just negatives)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }])))
        .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })),
    );
    const prompter = stubPrompter({ choice: vi.fn().mockResolvedValue("y") });
    await publish({ interactive: true, yes: false, prompter });
    // Exact pin: the confirmation is a standard output unit (leading blank + 2-space indent).
    expect(logs).toContain("\n  Published me → https://ymmv.fyi/me");
  });

  it("republish: card-first — existing values POST as-is on y, preview shows gap rows", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    const ask = vi.fn();
    const choice = vi.fn().mockResolvedValue("y");
    const prompter = stubPrompter({ ask, choice });
    await publish({ interactive: true, yes: false, prompter });
    expect(ask).not.toHaveBeenCalled();
    expect(choice).toHaveBeenCalledWith(
      "Publish to ymmv.fyi/me?",
      ["y", "n", "e"],
      "y",
      "Y/n/e=edit",
    );
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toEqual([{ key: "editor", value: "Vim" }]);
    const out = logs.join("\n");
    expect(out).toMatch(/ymmv\.fyi\/me/); // breadcrumb
    expect(out).toMatch(/Font\s+—/); // preview gap row for a never-set key
    expect(out).not.toMatch(/updated/); // preview never claims a timestamp
  });

  // REGRESSION (behavior fix): -y on a TTY used to walk all 13 prompts despite help's
  // "publish without prompts". It must now publish the merged defaults with zero interaction.
  it("-y interactive: no prompts, no confirm — preview card then POST", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    const ask = vi.fn();
    const choice = vi.fn();
    const prompter = stubPrompter({ ask, choice });
    await publish({ interactive: true, yes: true, prompter });
    expect(ask).not.toHaveBeenCalled();
    expect(choice).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.some((c) => (c[1] as RequestInit)?.method === "POST")).toBe(true);
    expect(logs.join("\n")).toMatch(/ymmv\.fyi\/me/); // the preview card still shows what shipped
    // Junction pin: exactly ONE blank line between the card's last row and the confirmation.
    expect(logs.join("\n")).toMatch(/AI Tool +—\n\n {2}Published me/);
  });

  it("e-loop: edits land in the POST body and a second card renders", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    const ask = vi.fn(async (label: string, def?: string) =>
      label === "Editor" ? "Zed" : (def ?? ""),
    );
    const prompter = stubPrompter({
      ask,
      choice: vi.fn().mockResolvedValueOnce("e").mockResolvedValueOnce("y"),
    });
    await publish({ interactive: true, yes: false, prompter });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toEqual([{ key: "editor", value: "Zed" }]);
    expect(logs.filter(isCard).length).toBe(2);
  });

  it('e-loop: clearing with "-" surfaces as a — gap row on the next card', async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }])));
    vi.stubGlobal("fetch", fetchFn);
    const ask = vi.fn(async (label: string, def?: string) =>
      label === "Editor" ? "-" : (def ?? ""),
    );
    const prompter = stubPrompter({
      ask,
      choice: vi.fn().mockResolvedValueOnce("e").mockResolvedValueOnce("n"),
    });
    await publish({ interactive: true, yes: false, prompter });
    const secondCard = logs.slice(logs.map(isCard).indexOf(true) + 1);
    expect(secondCard.join("\n")).toMatch(/Editor\s+—/); // cleared → explicit gap, not silence
    expect(secondCard.join("\n")).not.toContain("Vim");
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
    expect(logs.join("\n")).toMatch(/Aborted\. Nothing published\./);
  });

  it("Ctrl+C at a field prompt: Aborted line, exit 130, no POST", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn().mockResolvedValueOnce(missing()); // first publish → prompts run
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({ ask: vi.fn().mockRejectedValue(new PromptAborted()) });
    await publish({ interactive: true, yes: false, prompter });
    // ^C variant: a newline closes the interrupted prompt line, then the standard unit.
    expect(logs).toContain("\n\n  Aborted. Nothing published.");
    expect(process.exitCode).toBe(130);
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("Ctrl+C at the publish choice: same clean abort", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }])));
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({ choice: vi.fn().mockRejectedValue(new PromptAborted()) });
    await publish({ interactive: true, yes: false, prompter });
    expect(logs).toContain("\n\n  Aborted. Nothing published.");
    expect(process.exitCode).toBe(130);
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("non-interactive: carries unknown keys too, and stays silent when there are none", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const foreign = { key: "launcher", value: "Raycast" } as unknown as Profile["entries"][number];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [foreign])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })) // POST (carry run)
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST (clean run)
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: true });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toContainEqual(foreign);
    expect(logs.join("\n")).toMatch(/newer field/);

    logs.length = 0;
    await publish({ interactive: false, yes: true });
    expect(logs.join("\n")).not.toMatch(/newer field/);
  });

  it("interactive: declining the confirm publishes nothing", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn().mockResolvedValueOnce(missing()); // only the GET existing
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({
      ask: vi.fn(async () => ""),
      choice: vi.fn().mockResolvedValue("n"),
    });
    await publish({ interactive: true, yes: false, prompter });
    // GET happened, but no POST
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
    // Decline (typed "n"): the standard unit, no extra prompt-closing newline.
    expect(logs).toContain("\n  Aborted. Nothing published.");
  });

  it("aborts (no POST) when loading the existing profile transiently fails", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn().mockResolvedValue(fail(500)); // GET existing → 5xx, not a 404
    vi.stubGlobal("fetch", fetchFn);
    await expect(publish({ interactive: false, yes: true })).rejects.toThrow(/fetch failed/);
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("aborts when the pre-publish read resolves a different handle (rename guard) — no POST", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes(prof("me-renamed")));
    vi.stubGlobal("fetch", fetchFn);
    await expect(publish({ interactive: false, yes: true })).rejects.toThrow(/ymmv login/);
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("a failed publish keeps the prompt answers: card + choice re-run, second y succeeds", async () => {
    // The finding's trigger: 13 answers typed, confirm, POST fails → the whole session used to be
    // discarded (exit 1). Now the loop re-enters with the answers intact and no re-walk.
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing()) // GET existing → none (first publish, guided walk)
      .mockResolvedValueOnce(
        jsonRes({ error: "value_too_long", message: "Values are capped at 256 characters." }, 422),
      ) // first POST → server rejection
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // second POST → success
    vi.stubGlobal("fetch", fetchFn);
    const ask = vi.fn(async (label: string) => (label === "Editor" ? "Neovim" : ""));
    const choice = vi.fn().mockResolvedValue("y");
    const prompter = stubPrompter({ ask, choice });
    await publish({ interactive: true, yes: false, prompter });
    // Answers survived: both POSTs carry the typed value, and the 13-prompt walk ran ONCE.
    const post1 = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    const post2 = JSON.parse((fetchFn.mock.calls[2]?.[1] as RequestInit).body as string) as Profile;
    expect(post1.entries).toEqual([{ key: "editor", value: "Neovim" }]);
    expect(post2.entries).toEqual([{ key: "editor", value: "Neovim" }]);
    expect(ask).toHaveBeenCalledTimes(CURATED_KEYS.length);
    expect(choice).toHaveBeenCalledTimes(2); // the loop re-offered, not re-walked
    expect(logs.filter(isCard)).toHaveLength(2); // a fresh card before each confirm
    expect(errs).toContain(
      "\n  Values are capped at 256 characters.\n  Nothing was published. Your answers are kept.",
    );
    expect(logs.join("\n")).toMatch(/Published me/);
    expect(process.exitCode).toBeUndefined(); // the retry succeeded — a clean exit 0
  });

  it("n after a failed publish aborts cleanly (exit 0, no further POST)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing()) // GET
      .mockResolvedValueOnce(fail(500)); // POST → 5xx
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({
      ask: vi.fn(async () => ""),
      choice: vi.fn().mockResolvedValueOnce("y").mockResolvedValueOnce("n"),
    });
    await publish({ interactive: true, yes: false, prompter });
    expect(fetchFn).toHaveBeenCalledTimes(2); // GET + the one failed POST
    expect(logs).toContain("\n  Aborted. Nothing published.");
    expect(process.exitCode).toBeUndefined();
  });

  it("Ctrl+C after a failed publish still exits 130 through the outer handler", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing()) // GET
      .mockResolvedValueOnce(fail(500)); // POST → 5xx
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({
      ask: vi.fn(async () => ""),
      choice: vi.fn().mockResolvedValueOnce("y").mockRejectedValueOnce(new PromptAborted()),
    });
    await publish({ interactive: true, yes: false, prompter });
    expect(logs.join("\n")).toMatch(/Aborted\. Nothing published\./);
    expect(process.exitCode).toBe(130);
  });

  it("a PublishRefusal exits instead of re-offering a retry that can never succeed", async () => {
    // Identity drifted mid-command (a concurrent `ymmv login`): retrying the SAME merge would
    // fail identically, so the loop must rethrow to the top-level handler, not loop politely.
    vi.mocked(loadToken)
      .mockResolvedValueOnce({ base: "B", token: "t", handle: "me" }) // the command's own login
      .mockResolvedValue({ base: "B", token: "t2", handle: "mallory" }); // publishProfile's re-check
    const fetchFn = vi.fn().mockResolvedValueOnce(missing()); // GET existing only — no POST
    vi.stubGlobal("fetch", fetchFn);
    const choice = vi.fn().mockResolvedValue("y");
    const prompter = stubPrompter({ ask: vi.fn(async () => ""), choice });
    await expect(publish({ interactive: true, yes: false, prompter })).rejects.toThrow(
      /login changed/,
    );
    expect(choice).toHaveBeenCalledTimes(1); // no second offer
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("a lost response mid-loop prints the may-not-have-completed copy, never a false negative", async () => {
    // A NetworkError can arrive AFTER the server committed — "Nothing was published" would be a
    // lie the CLI can't back up. Server-answered failures keep the definite copy (tested above).
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing()) // GET existing
      .mockRejectedValueOnce(new TypeError("fetch failed")); // POST → safeFetch wraps: NetworkError
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({
      ask: vi.fn(async () => ""),
      choice: vi.fn().mockResolvedValueOnce("y").mockResolvedValueOnce("n"),
    });
    await publish({ interactive: true, yes: false, prompter });
    expect(errs.join("\n")).toMatch(/The publish may not have completed\. Your answers are kept\./);
    expect(errs.join("\n")).not.toMatch(/Nothing was published/);
  });

  it("^C during the mid-publish re-login device flow exits 130, not the retry loop", async () => {
    // The loop's PromptAborted rethrow must cover an abort ESCAPING publishProfile (the ^C lands
    // in login() during the 401 self-heal), not just one at the confirm choice.
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.mocked(login).mockRejectedValue(new PromptAborted());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing()) // GET existing
      .mockResolvedValueOnce(new Response("{}", { status: 401 })); // POST → self-heal → login ^C
    vi.stubGlobal("fetch", fetchFn);
    const choice = vi.fn().mockResolvedValue("y");
    const prompter = stubPrompter({ ask: vi.fn(async () => ""), choice });
    await publish({ interactive: true, yes: false, prompter });
    expect(process.exitCode).toBe(130);
    expect(logs.join("\n")).toMatch(/Aborted\. Nothing published\./);
    expect(choice).toHaveBeenCalledTimes(1); // no re-offer after the abort
  });

  it("an interactive answer exactly at the cap is accepted without a re-ask", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    const atCap = "x".repeat(256);
    const ask = vi.fn(async (label: string) => (label === "Editor" ? atCap : ""));
    const prompter = stubPrompter({ ask, choice: vi.fn().mockResolvedValue("y") });
    await publish({ interactive: true, yes: false, prompter });
    expect(ask).toHaveBeenCalledTimes(CURATED_KEYS.length); // no re-ask at the boundary
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toEqual([{ key: "editor", value: atCap }]);
  });

  it("an over-cap interactive answer re-prompts in place instead of failing after the walk", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing()) // GET existing → none
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    let editorAsks = 0;
    const ask = vi.fn(async (label: string) => {
      if (label !== "Editor") return "";
      editorAsks += 1;
      return editorAsks === 1 ? "x".repeat(300) : "Neovim";
    });
    const prompter = stubPrompter({ ask, choice: vi.fn().mockResolvedValue("y") });
    await publish({ interactive: true, yes: false, prompter });
    expect(logs.join("\n")).toMatch(/that value is 300 characters; the cap is 256/);
    expect(ask).toHaveBeenCalledTimes(CURATED_KEYS.length + 1); // one re-ask, no full re-walk
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toEqual([{ key: "editor", value: "Neovim" }]); // no 422 round-trip
    expect(fetchFn).toHaveBeenCalledTimes(2);
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
    // ONE line: the confirmation ends with a pointer at the live page — no separate Published echo.
    expect(logs).toContain("\n  Set Shell = zsh. → https://ymmv.fyi/me");
    expect(logs.join("\n")).not.toMatch(/Published/);
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

  it("refuses when the read resolves a different handle (server-side rename) — no POST", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes(prof("me-renamed")));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runSet({ kind: "curated", key: "shell", value: "zsh" })).rejects.toThrow(
      /ymmv login/,
    );
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("a genuine 33rd extra is refused locally with the cap named — no POST, exit 1", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const atCap = Array.from({ length: 32 }, (_, i) => ({ label: `L${i}`, value: "v" }));
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes(prof("me", [], atCap))); // GET only
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "extra", label: "New", value: "v" });
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(errs).toContain(
      "\n  Your profile already has 32 extras; that's the cap. " +
        'Remove one first: ymmv unset --extra "Label".',
    );
  });

  it("replacing an existing label AT the cap still publishes (an edit is not a 33rd extra)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const atCap = Array.from({ length: 32 }, (_, i) => ({ label: `L${i}`, value: "v" }));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], atCap))) // GET
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "extra", label: "L5", value: "updated" });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.extras).toHaveLength(32);
    expect(body.extras).toContainEqual({ label: "L5", value: "updated" });
    expect(process.exitCode).toBeUndefined();
  });

  it("-y refuses locally when a DETECTED value exceeds the cap (no doomed POST, no re-ask path)", async () => {
    // Detection is env-derived and skips both the argv and prompt pre-flights; the -y branch has
    // no edit loop to recover with, so an over-cap detected value must fail before the network.
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.mocked(detectStack).mockReturnValue(new Map([["terminal", "x".repeat(300)]]));
    const fetchFn = vi.fn().mockResolvedValueOnce(missing()); // GET existing only
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: true });
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(
      /The detected Terminal value is 300 characters; the cap is 256\. Set a shorter one: ymmv set terminal <value>\./,
    );
  });

  it("a curated set publishes even when extras sit at the cap (the guard is extras-only)", async () => {
    // A future widening of the guard (dropping the kind check) would block every set for
    // at-cap profiles — this pins the scope.
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const atCap = Array.from({ length: 32 }, (_, i) => ({ label: `L${i}`, value: "v" }));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], atCap))) // GET
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "curated", key: "editor", value: "vim" });
    expect(fetchFn).toHaveBeenCalledTimes(2); // the POST went out
    expect(process.exitCode).toBeUndefined();
  });
});

describe("unset", () => {
  const noPost = (fetchFn: ReturnType<typeof vi.fn>) =>
    fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST");

  it("curated: republishes without the key and echoes the old value", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes(
          prof("me", [
            { key: "editor", value: "Vim" },
            { key: "shell", value: "zsh" },
          ]),
        ),
      ) // GET existing
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "curated", key: "shell" });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toEqual([{ key: "editor", value: "Vim" }]);
    expect(logs).toContain('\n  Removed Shell (was "zsh"). → https://ymmv.fyi/me');
    expect(logs.join("\n")).not.toMatch(/Published/);
  });

  it("extra: drops it from the POSTed extras, message shows the stored casing", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: "Keyboard", value: "HHKB" }]))) // GET
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: "keyboard" });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.extras).toEqual([]);
    expect(logs).toContain('\n  Removed extra "Keyboard" (was "HHKB"). → https://ymmv.fyi/me');
  });

  it("curated no-op: not set → message, exit 0, and NO network write", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }])));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "curated", key: "multiplexer" });
    expect(noPost(fetchFn)).toBe(true);
    expect(logs).toContain("\n  Multiplexer is not set.");
    expect(process.exitCode).toBeUndefined();
  });

  it("extra no-op: unknown label → message, no POST", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes(prof("me")));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: "Keyboard" });
    expect(noPost(fetchFn)).toBe(true);
    expect(logs).toContain('\n  No extra "Keyboard".');
    expect(process.exitCode).toBeUndefined();
  });

  it("never published (404): friendly nudge, exit 0, no POST", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn().mockResolvedValueOnce(missing());
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "curated", key: "editor" });
    expect(noPost(fetchFn)).toBe(true);
    expect(logs).toContain("\n  No profile yet. Run `ymmv` to publish one.");
    expect(process.exitCode).toBeUndefined();
  });

  it("aborts (no republish) when loading the existing profile transiently fails", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn().mockResolvedValue(fail(500));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runUnset({ kind: "curated", key: "editor" })).rejects.toThrow(/fetch failed/);
    expect(noPost(fetchFn)).toBe(true);
  });

  it("refuses when the bound handle is null (reserved username)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: null });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "curated", key: "editor" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("sanitizes the echoed old value (ANSI stripped — it came off the wire)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes(prof("me", [{ key: "window-manager", value: "i3\u001b[31mX" }])),
      )
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "curated", key: "window-manager" });
    const out = logs.join("\n");
    expect(out).toMatch(/Removed Window Manager \(was "i3X"\)\./);
    expect(out).not.toContain("\u001b");
  });

  it("extra: sanitizes the echoed label AND value (both come off the wire)", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const esc = String.fromCharCode(0x1b); // explicit code point, never a raw literal
    const dirty = `Key${esc}[31mboard`;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: dirty, value: `HH${esc}[2JKB` }])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: dirty });
    const out = logs.join("\n");
    expect(out).toMatch(/Removed extra "Keyboard" \(was "HHKB"\)\./);
    expect(out).not.toContain(esc);
  });

  it("refuses when the read resolves a different handle (server-side rename) — no POST", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me-renamed", [{ key: "editor", value: "Vim" }])));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runUnset({ kind: "curated", key: "editor" })).rejects.toThrow(/ymmv login/);
    expect(noPost(fetchFn)).toBe(true);
  });

  it("removing the last entry publishes entries: []", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "curated", key: "editor" });
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string) as Profile;
    expect(body.entries).toEqual([]);
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
    expect(errs).toContain(
      "\n  Refusing to delete ymmv.fyi/me without confirmation. " +
        "Re-run with -y to confirm: ymmv delete -y",
    );
  });

  it("non-interactive WITH -y: deletes server-side, then drops the now-dead local token", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes({ ok: true })));
    await runDelete({ interactive: false, yes: true });
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(logs).toContain("\n  Deleted ymmv.fyi/me. Run `ymmv` to publish again.");
  });

  it("interactive: a 'no' at the confirm cancels without touching anything", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({ confirm: vi.fn().mockResolvedValue(false) });
    await runDelete({ interactive: true, yes: false, prompter });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
    expect(logs).toContain("\n  Cancelled. Nothing deleted.");
  });

  it("Ctrl+C at the delete confirm: Cancelled line, exit 130, nothing touched", async () => {
    vi.mocked(loadToken).mockResolvedValue({ base: "B", token: "t", handle: "me" });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({ confirm: vi.fn().mockRejectedValue(new PromptAborted()) });
    await runDelete({ interactive: true, yes: false, prompter });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
    expect(logs).toContain("\n\n  Cancelled. Nothing deleted.");
    expect(process.exitCode).toBe(130);
  });
});
