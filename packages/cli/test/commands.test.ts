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
import { deleteToken, loadCredential, loadToken, type StoredToken } from "../src/token-store.js";

function prof(
  handle: string,
  entries: Profile["entries"] = [],
  extras: Profile["extras"] = [],
): Profile {
  return { schema_version: SCHEMA_VERSION, handle, entries, extras, updated_at: "2026-01-01" };
}
/** A file credential as loadToken returns it; id 1001 is the account this run logged in as. */
const stored = (o: Partial<StoredToken> = {}): StoredToken => ({
  base: "B",
  token: "t",
  handle: "me",
  github_id: 1001,
  ...o,
});
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** The Worker's own "no profile" 404 envelope — the ONLY 404 the own-profile read treats as none. */
const missing = () => jsonRes({ error: "not_found" }, 404);
const fail = (status: number) => new Response("err", { status }); // a real error, NOT a 404
/** The own-profile read (GET /api/v1/profile) as the Worker answers it: the profile + its ETag. The
 *  CLI builds the tag from the body stamp (never the header), so the tag is stamped into the body. */
const own = (p: Profile, etag = '"2026-01-01"') =>
  new Response(JSON.stringify({ ...p, updated_at: etag.slice(1, -1) }), {
    status: 200,
    headers: { etag },
  });
/** The If-Match header of fetch call `call` (a POST), or undefined when none was sent. */
const ifMatchOf = (fetchFn: { mock: { calls: unknown[][] } }, call: number) =>
  ((fetchFn.mock.calls[call][1] as RequestInit).headers as Record<string, string>)["if-match"];

/** The Profile JSON the test POSTed: fetch call `call` (default 1, after the GET), its RequestInit body. */
function posted(fetchFn: { mock: { calls: unknown[][] } }, call = 1): Profile {
  const init = fetchFn.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Profile;
}
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
  // Default credential source mirrors the real file path: whatever loadToken is stubbed to return,
  // tagged source "file". Env-credential tests override loadCredential directly.
  vi.mocked(loadCredential).mockImplementation(async () => {
    const stored = await loadToken();
    return stored ? { ...stored, source: "file" } : null;
  });
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored({ handle: null }));
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    const body = posted(fetchFn);
    expect(body.entries).toEqual([{ key: "editor", value: "Neovim" }]);
    expect(body.handle).toBe("me");
  });

  it("prints carried + dup-extra notes as ONE unit with 4-space carried rows", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
    const foreign = { key: "launcher", value: "Raycast" } as unknown as Profile["entries"][number];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [foreign, { key: "editor", value: "Vim" }])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    const ask = vi.fn();
    const prompter = stubPrompter({ ask, choice: vi.fn().mockResolvedValue("y") });
    await publish({ interactive: true, yes: false, prompter });
    const body = posted(fetchFn);
    expect(body.entries).toContainEqual(foreign);
    expect(body.entries).toContainEqual({ key: "editor", value: "Vim" });
    expect(ask).not.toHaveBeenCalled(); // card-first: Enter-to-publish, no field walk
    expect(logs.join("\n")).toMatch(/\+1 newer field kept as-is/);
    expect(logs.join("\n")).toMatch(/launcher = Raycast/); // carried rows are listed, not hidden
  });

  it("republish + e: the edit pass walks all curated keys, never the carried ones", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    const body = posted(fetchFn);
    expect(body.entries).toContainEqual(foreign);
    expect(body.entries).toContainEqual({ key: "editor", value: "Vim" });
    expect(ask).toHaveBeenCalledTimes(CURATED_KEYS.length); // one prompt per curated key, no more
    expect(ask.mock.calls.some((c) => /launcher/i.test(String(c[0])))).toBe(false);
  });

  it("prints the Published confirmation after y (the line has a positive pin, not just negatives)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    const body = posted(fetchFn);
    expect(body.entries).toEqual([{ key: "editor", value: "Vim" }]);
    const out = logs.join("\n");
    expect(out).toMatch(/ymmv\.fyi\/me/); // breadcrumb
    expect(out).toMatch(/Font\s+—/); // preview gap row for a never-set key
    expect(out).not.toMatch(/updated/); // preview never claims a timestamp
  });

  // REGRESSION (behavior fix): -y on a TTY used to walk all 13 prompts despite help's
  // "publish without prompts". It must now publish the merged defaults with zero interaction.
  it("-y interactive: no prompts, no confirm — preview card then POST", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    const body = posted(fetchFn);
    expect(body.entries).toEqual([{ key: "editor", value: "Zed" }]);
    expect(logs.filter(isCard).length).toBe(2);
  });

  it('e-loop: clearing with "-" surfaces as a — gap row on the next card', async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
    const foreign = { key: "launcher", value: "Raycast" } as unknown as Profile["entries"][number];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [foreign])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })) // POST (carry run)
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST (clean run)
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: true });
    const body = posted(fetchFn);
    expect(body.entries).toContainEqual(foreign);
    expect(logs.join("\n")).toMatch(/newer field/);

    logs.length = 0;
    await publish({ interactive: false, yes: true });
    expect(logs.join("\n")).not.toMatch(/newer field/);
  });

  it("interactive: declining the confirm publishes nothing", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi.fn().mockResolvedValue(fail(500)); // GET existing → 5xx, not a 404
    vi.stubGlobal("fetch", fetchFn);
    await expect(publish({ interactive: false, yes: true })).rejects.toThrow(/fetch failed/);
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("aborts when the pre-publish read resolves a different handle (rename guard) — no POST", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes(prof("me-renamed")));
    vi.stubGlobal("fetch", fetchFn);
    await expect(publish({ interactive: false, yes: true })).rejects.toThrow(/ymmv login/);
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("a failed publish keeps the prompt answers: card + choice re-run, second y succeeds", async () => {
    // The finding's trigger: 13 answers typed, confirm, POST fails → the whole session used to be
    // discarded (exit 1). Now the loop re-enters with the answers intact and no re-walk.
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    const post1 = posted(fetchFn);
    const post2 = posted(fetchFn, 2);
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
      .mockResolvedValueOnce(stored()) // the command's own login
      .mockResolvedValue(stored({ token: "t2", handle: "mallory", github_id: 2002 })); // publishProfile's re-check
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

  it("a same-handle store under a DIFFERENT account at the first send is refused (id passed through)", async () => {
    // publish() hands publishProfile the credential it merged under, so a squat that keeps the
    // handle string is caught before the first POST, not only on the post-reauth retry.
    vi.mocked(loadToken)
      .mockResolvedValueOnce(stored()) // the command's own login
      .mockResolvedValue(stored({ token: "t2", github_id: 2002 })); // publishProfile's re-check
    const fetchFn = vi.fn().mockResolvedValueOnce(missing()); // GET existing only — no POST
    vi.stubGlobal("fetch", fetchFn);
    const choice = vi.fn().mockResolvedValue("y");
    const prompter = stubPrompter({ ask: vi.fn(async () => ""), choice });
    await expect(publish({ interactive: true, yes: false, prompter })).rejects.toThrow(
      /login changed/,
    );
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("a lost response mid-loop prints the may-not-have-completed copy, never a false negative", async () => {
    // A NetworkError can arrive AFTER the server committed — "Nothing was published" would be a
    // lie the CLI can't back up. Server-answered failures keep the definite copy (tested above).
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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

  it("reads the OWN profile (bearer, never cached) and sends its ETag back as If-Match", async () => {
    // The public /api/v1/u/<handle> read declares an edge-cache policy; a merge built on a stale
    // copy would silently drop a write made moments earlier. The RMW read is the authed one.
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        own(prof("me", [{ key: "editor", value: "vim" }]), '"2026-05-05T00:00:00.000Z"'),
      )
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: true });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/profile$/);
    expect(init.method).toBeUndefined(); // GET
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer t");
    expect(init.redirect).toBe("manual");
    expect(ifMatchOf(fetchFn, 1)).toBe('"2026-05-05T00:00:00.000Z"');
    expect(process.exitCode).toBeUndefined();
  });

  it("a first publish (no profile yet) sends no If-Match", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: true });
    expect(ifMatchOf(fetchFn, 1)).toBeUndefined();
  });

  it("-y: a 412 (the profile changed since the read) fails with the re-run copy after ONE POST", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(prof("me")))
      .mockResolvedValueOnce(
        jsonRes({ error: "precondition_failed", message: "server copy" }, 412),
      );
    vi.stubGlobal("fetch", fetchFn);
    await expect(publish({ interactive: false, yes: true })).rejects.toThrow(
      /Your profile changed since this command read it\. Re-run the command\./,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(login).not.toHaveBeenCalled();
  });

  it("an old Worker's non-envelope 404 on the own read aborts — never a from-scratch publish", async () => {
    // A Worker without GET /api/v1/profile answers the HTML 404. Reading that as "no profile"
    // would POST an empty merge over whatever is live; the read must throw instead.
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>404</html>", { status: 404 }));
    vi.stubGlobal("fetch", fetchFn);
    await expect(publish({ interactive: false, yes: true })).rejects.toThrow(
      /behind this CLI release/,
    );
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("412 mid-loop: rebases onto the live profile, re-offers, and the second y sends the fresh tag", async () => {
    // Someone published from another device while the user sat at the confirm. Retrying the same
    // merge would clobber it; exiting would discard the answers. On a republish nobody was
    // prompted, so the curated values are server state: the reload must take the LIVE ones.
    vi.mocked(loadToken).mockResolvedValue(stored());
    const foreign = { key: "launcher", value: "Raycast" } as unknown as Profile["entries"][number];
    const before = prof(
      "me",
      [{ key: "editor", value: "vim" }],
      [{ label: "Launcher", value: "x" }],
    );
    const after = prof(
      "me",
      [{ key: "editor", value: "emacs" }, foreign],
      [{ label: "Keyboard", value: "HHKB" }],
    );
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(before, '"A"'))
      .mockResolvedValueOnce(jsonRes({ error: "precondition_failed" }, 412)) // POST 1
      .mockResolvedValueOnce(own(after, '"B"')) // the reload
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST 2
    vi.stubGlobal("fetch", fetchFn);
    const choice = vi.fn().mockResolvedValue("y");
    const prompter = stubPrompter({ ask: vi.fn(async () => ""), choice });
    await publish({ interactive: true, yes: false, prompter });
    expect(ifMatchOf(fetchFn, 1)).toBe('"A"');
    expect(ifMatchOf(fetchFn, 3)).toBe('"B"');
    const post2 = posted(fetchFn, 3);
    // No edits were made, so the concurrent curated edit (emacs) is what gets republished, with
    // the reloaded newer-taxonomy key and extras — never the stale first read.
    expect(post2.entries).toEqual([{ key: "editor", value: "emacs" }, foreign]);
    expect(post2.extras).toEqual([{ label: "Keyboard", value: "HHKB" }]);
    expect(choice).toHaveBeenCalledTimes(2);
    expect(logs.filter(isCard)).toHaveLength(2); // a fresh card after the reload
    expect(errs).toContain(
      "\n  Your profile changed since this command read it. Reloaded the current version; your answers are kept.",
    );
    expect(logs.join("\n")).toMatch(/Published me/);
    expect(process.exitCode).toBeUndefined();
  });

  it("412 mid-loop: explicit edits survive the rebase, cleared keys included", async () => {
    // The user edited (e) before confirming: Editor typed, OS cleared with "-". Another device
    // then changed editor+os+shell. The rebase keeps the two edits and takes the live shell.
    vi.mocked(loadToken).mockResolvedValue(stored());
    const before = prof("me", [
      { key: "editor", value: "vim" },
      { key: "os", value: "Arch" },
      { key: "shell", value: "fish" },
    ]);
    const after = prof("me", [
      { key: "editor", value: "emacs" },
      { key: "os", value: "Debian" },
      { key: "shell", value: "zsh" },
    ]);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(before, '"A"'))
      .mockResolvedValueOnce(jsonRes({ error: "precondition_failed" }, 412))
      .mockResolvedValueOnce(own(after, '"B"'))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    // Enter keeps the default (the prompter hands it back); "-" clears.
    const ask = vi.fn(async (label: string, def?: string) =>
      label === "Editor" ? "Neovim" : label === "OS" ? "-" : (def ?? ""),
    );
    const choice = vi.fn().mockResolvedValueOnce("e").mockResolvedValue("y");
    const prompter = stubPrompter({ ask, choice });
    await publish({ interactive: true, yes: false, prompter });
    expect(posted(fetchFn, 3).entries).toEqual([
      { key: "editor", value: "Neovim" },
      { key: "shell", value: "zsh" },
    ]);
    expect(ifMatchOf(fetchFn, 3)).toBe('"B"');
    expect(process.exitCode).toBeUndefined();
  });

  it("412 then a deleted-meanwhile re-read (404) refuses: nothing recreated, nothing further sent", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(prof("me", [{ key: "editor", value: "vim" }]), '"A"'))
      .mockResolvedValueOnce(jsonRes({ error: "precondition_failed" }, 412))
      .mockResolvedValueOnce(missing());
    vi.stubGlobal("fetch", fetchFn);
    const choice = vi.fn().mockResolvedValue("y");
    const prompter = stubPrompter({ ask: vi.fn(async () => ""), choice });
    await expect(publish({ interactive: true, yes: false, prompter })).rejects.toThrow(
      /deleted since this command read it/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(choice).toHaveBeenCalledTimes(1);
  });

  it("a 412 reload after publishProfile's own 401 heal goes out under the NEW token", async () => {
    // The heal swaps the stored token mid-loop; the command's in-memory credential is the old
    // one. The reload must re-read the store, or it 401s seconds after a successful login.
    vi.mocked(loadToken)
      .mockResolvedValueOnce(stored()) // the command's own login
      .mockResolvedValue(stored({ token: "t2" })); // after the heal
    vi.mocked(login).mockResolvedValue(undefined); // the device flow succeeds
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(prof("me"), '"A"'))
      .mockResolvedValueOnce(new Response("{}", { status: 401 })) // POST → heal
      .mockResolvedValueOnce(jsonRes({ error: "precondition_failed" }, 412)) // healed retry
      .mockResolvedValueOnce(own(prof("me"), '"B"')) // the reload
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    const choice = vi.fn().mockResolvedValue("y");
    const prompter = stubPrompter({ ask: vi.fn(async () => ""), choice });
    await publish({ interactive: true, yes: false, prompter });
    const reload = fetchFn.mock.calls[3]?.[1] as RequestInit;
    expect((reload.headers as Record<string, string>).authorization).toBe("Bearer t2");
    expect(ifMatchOf(fetchFn, 4)).toBe('"B"');
    expect(logs.join("\n")).toMatch(/Published me/);
  });

  it("a second 412 reloads again: every retry carries the tag of the read it was built on", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(prof("me"), '"A"'))
      .mockResolvedValueOnce(jsonRes({ error: "precondition_failed" }, 412))
      .mockResolvedValueOnce(own(prof("me"), '"B"'))
      .mockResolvedValueOnce(jsonRes({ error: "precondition_failed" }, 412))
      .mockResolvedValueOnce(own(prof("me"), '"C"'))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    const choice = vi.fn().mockResolvedValue("y");
    const prompter = stubPrompter({ ask: vi.fn(async () => ""), choice });
    await publish({ interactive: true, yes: false, prompter });
    expect([ifMatchOf(fetchFn, 1), ifMatchOf(fetchFn, 3), ifMatchOf(fetchFn, 5)]).toEqual([
      '"A"',
      '"B"',
      '"C"',
    ]);
    expect(choice).toHaveBeenCalledTimes(3);
    expect(logs.join("\n")).toMatch(/Published me/);
    expect(process.exitCode).toBeUndefined();
  });

  it("412 then a reload that resolves a DIFFERENT handle refuses — no second POST", async () => {
    // A rename (re-login on another device) landed while the user sat at the confirm. The reload
    // is checked exactly like the pre-loop read: publishing the merge under the old handle would
    // write it to whatever now answers there.
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(prof("me"), '"A"'))
      .mockResolvedValueOnce(jsonRes({ error: "precondition_failed" }, 412))
      .mockResolvedValueOnce(own(prof("me-renamed"), '"B"'));
    vi.stubGlobal("fetch", fetchFn);
    const choice = vi.fn().mockResolvedValue("y");
    const prompter = stubPrompter({ ask: vi.fn(async () => ""), choice });
    await expect(publish({ interactive: true, yes: false, prompter })).rejects.toThrow(
      /your profile now lives at "me-renamed"/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(choice).toHaveBeenCalledTimes(1);
  });

  it("412 then a transiently failing re-read aborts (no further POST), like the pre-loop read", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(prof("me"), '"A"'))
      .mockResolvedValueOnce(jsonRes({ error: "precondition_failed" }, 412))
      .mockResolvedValueOnce(fail(500));
    vi.stubGlobal("fetch", fetchFn);
    const choice = vi.fn().mockResolvedValue("y");
    const prompter = stubPrompter({ ask: vi.fn(async () => ""), choice });
    await expect(publish({ interactive: true, yes: false, prompter })).rejects.toThrow(
      /fetch failed/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(choice).toHaveBeenCalledTimes(1);
  });

  it("n after a 412 reload aborts cleanly with nothing further sent", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(prof("me"), '"A"'))
      .mockResolvedValueOnce(jsonRes({ error: "precondition_failed" }, 412))
      .mockResolvedValueOnce(own(prof("me"), '"B"'));
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({
      ask: vi.fn(async () => ""),
      choice: vi.fn().mockResolvedValueOnce("y").mockResolvedValueOnce("n"),
    });
    await publish({ interactive: true, yes: false, prompter });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(logs).toContain("\n  Aborted. Nothing published.");
    expect(process.exitCode).toBeUndefined();
  });

  it("an interactive answer exactly at the cap is accepted without a re-ask", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    const body = posted(fetchFn);
    expect(body.entries).toEqual([{ key: "editor", value: atCap }]);
  });

  it("an over-cap interactive answer re-prompts in place instead of failing after the walk", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    const body = posted(fetchFn);
    expect(body.entries).toEqual([{ key: "editor", value: "Neovim" }]); // no 422 round-trip
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("first-send identity drift is caught on every publish path (id passed through)", () => {
  // Same handle, different account between the command's own login and the send: the handle
  // string can't tell, the id can. One case per publishProfile call site outside the loop.
  const drift = () =>
    vi
      .mocked(loadToken)
      .mockResolvedValueOnce(stored()) // the command's own login
      .mockResolvedValue(stored({ token: "t2", github_id: 2002 })); // publishProfile's re-check

  it("ymmv -y (non-interactive publish)", async () => {
    drift();
    const fetchFn = vi.fn().mockResolvedValueOnce(missing()); // GET existing only
    vi.stubGlobal("fetch", fetchFn);
    await expect(publish({ interactive: false, yes: true })).rejects.toThrow(/login changed/);
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("ymmv set", async () => {
    drift();
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes(prof("me")));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runSet({ kind: "curated", key: "shell", value: "zsh" })).rejects.toThrow(
      /login changed/,
    );
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("ymmv unset", async () => {
    drift();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "shell", value: "zsh" }])));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runUnset({ kind: "curated", key: "shell" })).rejects.toThrow(/login changed/);
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });
});

describe("set", () => {
  it("curated: merges into the existing profile and republishes the union", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }]))) // GET existing
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "curated", key: "shell", value: "zsh" });
    const body = posted(fetchFn);
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

  it("curated: with color on, the pointer shows the site host, not the scheme", async () => {
    vi.stubEnv("FORCE_COLOR", "1");
    try {
      vi.mocked(loadToken).mockResolvedValue(stored());
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }]))) // GET existing
        .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
      vi.stubGlobal("fetch", fetchFn);
      await runSet({ kind: "curated", key: "shell", value: "zsh" });
      const out = logs.join(" ");
      expect(out).toContain("→ ymmv.fyi/me");
      expect(out).not.toContain("https://ymmv.fyi/me");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("extra: adds a free-form extra even with no existing profile", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing()) // no existing profile
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "extra", label: "Launcher", value: "Raycast" });
    const body = posted(fetchFn);
    expect(body.extras).toEqual([{ label: "Launcher", value: "Raycast" }]);
    expect(ifMatchOf(fetchFn, 1)).toBeUndefined(); // nothing was read, so nothing to condition on
  });

  it("refuses when the bound handle is null (reserved username)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored({ handle: null }));
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "curated", key: "shell", value: "zsh" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("aborts (no republish) when loading the existing profile transiently fails", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(500)));
    await expect(runSet({ kind: "curated", key: "shell", value: "zsh" })).rejects.toThrow(
      /fetch failed/,
    );
  });

  it("reads the own profile and sends its ETag back as If-Match", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(prof("me"), '"E"'))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "curated", key: "shell", value: "zsh" });
    expect(String(fetchFn.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/profile$/);
    expect(ifMatchOf(fetchFn, 1)).toBe('"E"');
  });

  it("a 412 (the profile changed since the read) fails with the re-run copy after ONE POST", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(prof("me"), '"E"'))
      .mockResolvedValueOnce(jsonRes({ error: "precondition_failed" }, 412));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runSet({ kind: "curated", key: "shell", value: "zsh" })).rejects.toThrow(
      /changed since this command read it/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("an old Worker's non-envelope 404 on the own read aborts, no POST", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>404</html>", { status: 404 }));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runSet({ kind: "curated", key: "shell", value: "zsh" })).rejects.toThrow(
      /behind this CLI release/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refuses when the read resolves a different handle (server-side rename) — no POST", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes(prof("me-renamed")));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runSet({ kind: "curated", key: "shell", value: "zsh" })).rejects.toThrow(
      /ymmv login/,
    );
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("a genuine 33rd extra is refused locally with the cap named — no POST, exit 1", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
    const atCap = Array.from({ length: 32 }, (_, i) => ({ label: `L${i}`, value: "v" }));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], atCap))) // GET
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "extra", label: "L5", value: "updated" });
    const body = posted(fetchFn);
    expect(body.extras).toHaveLength(32);
    expect(body.extras).toContainEqual({ label: "L5", value: "updated" });
    expect(process.exitCode).toBeUndefined();
  });

  it("-y refuses locally when a DETECTED value exceeds the cap (no doomed POST, no re-ask path)", async () => {
    // Detection is env-derived and skips both the argv and prompt pre-flights; the -y branch has
    // no edit loop to recover with, so an over-cap detected value must fail before the network.
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    const body = posted(fetchFn);
    expect(body.entries).toEqual([{ key: "editor", value: "Vim" }]);
    expect(logs).toContain('\n  Removed Shell (was "zsh"). → https://ymmv.fyi/me');
    expect(logs.join("\n")).not.toMatch(/Published/);
  });

  it("extra: drops it from the POSTed extras, message shows the stored casing", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: "Keyboard", value: "HHKB" }]))) // GET
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: "keyboard" });
    const body = posted(fetchFn);
    expect(body.extras).toEqual([]);
    expect(logs).toContain('\n  Removed extra "Keyboard" (was "HHKB"). → https://ymmv.fyi/me');
  });

  it("curated no-op: not set → message, exit 0, and NO network write", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes(prof("me")));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: "Keyboard" });
    expect(noPost(fetchFn)).toBe(true);
    expect(logs).toContain('\n  No extra "Keyboard".');
    expect(process.exitCode).toBeUndefined();
  });

  it('extra: a label containing "=" is removed when it matches (curl-written rows)', async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: "Mode=Vi", value: "yes" }]))) // GET
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" })); // POST
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: "mode=vi" });
    const body = posted(fetchFn);
    expect(body.extras).toEqual([]);
    expect(logs).toContain('\n  Removed extra "Mode=Vi" (was "yes"). → https://ymmv.fyi/me');
  });

  it('extra: "Label=Value" with no match → no-op plus just-the-label note, exit 0, no POST', async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: "Keyboard", value: "HHKB" }])));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: "Keyboard=HHKB" });
    expect(noPost(fetchFn)).toBe(true);
    expect(logs).toContain(
      '\n  No extra "Keyboard=HHKB".\n  (unset takes just the label: ymmv unset --extra "Keyboard")',
    );
    expect(errs).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('extra: a leading "=" has no head, so no note (exit 0)', async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: "Keyboard", value: "HHKB" }])));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: "=foo" });
    expect(noPost(fetchFn)).toBe(true);
    expect(logs).toContain('\n  No extra "=foo".');
    expect(logs.join("\n")).not.toMatch(/just the label/);
    expect(process.exitCode).toBeUndefined();
  });

  it('extra: the note trims the head ("Keyboard =HHKB" → "Keyboard")', async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: "Keyboard", value: "HHKB" }])));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: "Keyboard =HHKB" });
    expect(noPost(fetchFn)).toBe(true);
    expect(logs.join("\n")).toContain('ymmv unset --extra "Keyboard")');
    expect(process.exitCode).toBeUndefined();
  });

  it('extra: a "=" label that misses with no stored head is the plain no-op (idempotent re-run)', async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: "Mode=Vi", value: "yes" }])));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: "Mode=Vim" }); // typo of a curl-written label
    expect(noPost(fetchFn)).toBe(true);
    expect(logs).toContain('\n  No extra "Mode=Vim".');
    expect(logs.join("\n")).not.toMatch(/just the label/);
    expect(process.exitCode).toBeUndefined();
  });

  it("extra: the pasteable suggestion falls back to a placeholder for a shell-unsafe head", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: "$(echo x)", value: "y" }])));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: "$(echo x)=y" });
    const out = logs.join("\n");
    expect(out).toContain('ymmv unset --extra "Label")');
    expect(out).not.toContain('--extra "$(');
    expect(process.exitCode).toBeUndefined();
  });

  it("extra: the pasteable head keeps plain punctuation (digits, dot, space)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: "Neovim 0.10", value: "stable" }])));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: "Neovim 0.10=stable" });
    expect(logs.join("\n")).toContain('ymmv unset --extra "Neovim 0.10")');
  });

  it("extra: a lone quote in the head is enough to fall back to the placeholder", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: 'a"b', value: "x" }])));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: 'a"b=x' });
    const out = logs.join("\n");
    expect(out).toContain('ymmv unset --extra "Label")');
    expect(out).not.toContain('--extra "a"');
  });

  it("extra: the no-op echo strips escapes from argv, and the note never carries them", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const esc = String.fromCharCode(0x1b); // explicit code point, never a raw literal
    const dirty = `Key${esc}[31mboard`;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [], [{ label: dirty, value: "HHKB" }])));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "extra", label: `${dirty}=HHKB` });
    const out = logs.join("\n");
    expect(out).toContain('No extra "Keyboard=HHKB".');
    expect(out).toContain('ymmv unset --extra "Label")');
    expect(out).not.toContain(esc);
    expect(process.exitCode).toBeUndefined();
  });

  it("reads the own profile and sends its ETag back as If-Match", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(prof("me", [{ key: "editor", value: "vim" }]), '"E"'))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "curated", key: "editor" });
    expect(String(fetchFn.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/profile$/);
    expect(ifMatchOf(fetchFn, 1)).toBe('"E"');
  });

  it("a 412 (the profile changed since the read) fails with the re-run copy after ONE POST", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(own(prof("me", [{ key: "editor", value: "vim" }]), '"E"'))
      .mockResolvedValueOnce(jsonRes({ error: "precondition_failed" }, 412));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runUnset({ kind: "curated", key: "editor" })).rejects.toThrow(
      /changed since this command read it/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("an old Worker's non-envelope 404 on the own read aborts, no POST (not the no-profile no-op)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>404</html>", { status: 404 }));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runUnset({ kind: "curated", key: "editor" })).rejects.toThrow(
      /behind this CLI release/,
    );
    expect(noPost(fetchFn)).toBe(true);
    expect(logs.join("\n")).not.toContain("No profile yet");
  });

  it("never published (404): friendly nudge, exit 0, no POST", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi.fn().mockResolvedValueOnce(missing());
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "curated", key: "editor" });
    expect(noPost(fetchFn)).toBe(true);
    expect(logs).toContain("\n  No profile yet. Run `ymmv` to publish one.");
    expect(process.exitCode).toBeUndefined();
  });

  it("aborts (no republish) when loading the existing profile transiently fails", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi.fn().mockResolvedValue(fail(500));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runUnset({ kind: "curated", key: "editor" })).rejects.toThrow(/fetch failed/);
    expect(noPost(fetchFn)).toBe(true);
  });

  it("refuses when the bound handle is null (reserved username)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored({ handle: null }));
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "curated", key: "editor" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("sanitizes the echoed old value (ANSI stripped — it came off the wire)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me-renamed", [{ key: "editor", value: "Vim" }])));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runUnset({ kind: "curated", key: "editor" })).rejects.toThrow(/ymmv login/);
    expect(noPost(fetchFn)).toBe(true);
  });

  it("removing the last entry publishes entries: []", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "Vim" }])))
      .mockResolvedValueOnce(jsonRes({ ok: true, handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "curated", key: "editor" });
    const body = posted(fetchFn);
    expect(body.entries).toEqual([]);
  });
});

describe("delete", () => {
  it("non-interactive WITHOUT -y: refuses (no network, no token drop, exit 1)", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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
    vi.mocked(loadToken).mockResolvedValue(stored());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes({ ok: true })));
    await runDelete({ interactive: false, yes: true });
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(logs).toContain("\n  Deleted ymmv.fyi/me. Run `ymmv` to publish again.");
  });

  it("interactive: a 'no' at the confirm cancels without touching anything", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({ confirm: vi.fn().mockResolvedValue(false) });
    await runDelete({ interactive: true, yes: false, prompter });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
    expect(logs).toContain("\n  Cancelled. Nothing deleted.");
  });

  it("a file login with NO handle bound names no page, and never the env binding's copy", async () => {
    // The third leaf of the consent-target choice (handle → page URL, env → the binding, file →
    // neither): a reserved GitHub username binds to a null handle, and there is no page to name.
    vi.mocked(loadToken).mockResolvedValue(stored({ handle: null }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes({ ok: true })));
    await runDelete({ interactive: false, yes: true });
    const out = logs.join("\n");
    expect(out).toContain("Deleted your profile.");
    expect(out).not.toContain("YMMV_TOKEN");
    expect(deleteToken).toHaveBeenCalledTimes(1); // a FILE credential still drops the dead token
  });

  it("Ctrl+C at the delete confirm: Cancelled line, exit 130, nothing touched", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
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

/// The CI persona: YMMV_TOKEN (+ optional YMMV_HANDLE) instead of a stored login. The credential is
// read-only config — commands must work without a device flow, and never touch the token FILE.
// Its identity comes from GET /api/v1/auth/whoami, so every env command's FIRST fetch is that
// lookup (view's is its second: the target profile is fetched before any credential is touched).
describe("env credential (YMMV_TOKEN) command flows", () => {
  /** The RAW env credential, exactly as loadCredential() returns it: `handle` is whatever
   *  YMMV_HANDLE claims (null when unset) and there is no id until whoami supplies one. */
  const envCred = (ymmvHandle: string | null) => ({
    base: "B",
    token: "ymmv_env",
    handle: ymmvHandle,
    github_id: null,
    source: "env" as const,
  });
  const whoami = (handle: string | null, github_id = 2002) => jsonRes({ github_id, handle });
  const urlOf = (fetchFn: { mock: { calls: unknown[][] } }, call: number) =>
    String(fetchFn.mock.calls[call]?.[0]);
  const initOf = (fetchFn: { mock: { calls: unknown[][] } }, call: number) =>
    fetchFn.mock.calls[call]?.[1] as RequestInit;

  it("headline: `ymmv -y` publishes with YMMV_HANDLE UNSET, under the whoami handle, with NO device flow", async () => {
    // Regression pin for the drift guard: publishProfile used to re-read the RAW credential
    // (handle null here), which would refuse every publish that leaves YMMV_HANDLE unset.
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(whoami("me"))
      .mockResolvedValueOnce(missing()) // no existing profile
      .mockResolvedValueOnce(jsonRes({ handle: "me" })); // POST commits
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: true });
    expect(login).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("Published me");
    expect(urlOf(fetchFn, 0)).toContain("/api/v1/auth/whoami");
    expect(initOf(fetchFn, 0).redirect).toBe("manual");
    // The own read: the bearer names the account (no handle in the URL), and the reply is what
    // the merge is built on — assertHandleUnchanged then compares it to the VERIFIED handle.
    expect(urlOf(fetchFn, 1)).toMatch(/\/api\/v1\/profile$/);
    expect((initOf(fetchFn, 1).headers as Record<string, string>).authorization).toBe(
      "Bearer ymmv_env",
    );
    expect(posted(fetchFn, 2).handle).toBe("me");
  });

  it("a matching YMMV_HANDLE passes, compared case-insensitively, and the whoami casing wins", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred("ME"));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(whoami("Me"))
      .mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(jsonRes({ handle: "Me" }));
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: true });
    expect(process.exitCode).toBeUndefined();
    expect(posted(fetchFn, 2).handle).toBe("Me");
  });

  it("a YMMV_HANDLE naming a different account refuses before any read or POST, naming both", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred("bob"));
    const fetchFn = vi.fn().mockResolvedValueOnce(whoami("alice"));
    vi.stubGlobal("fetch", fetchFn);
    await expect(publish({ interactive: false, yes: true })).rejects.toThrow(
      'YMMV_HANDLE is "bob" but YMMV_TOKEN belongs to "alice". Fix or unset YMMV_HANDLE.',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1); // whoami only
  });

  it("YMMV_HANDLE set while the token's account has NO handle is a mismatch too", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred("bob"));
    const fetchFn = vi.fn().mockResolvedValueOnce(whoami(null));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runSet({ kind: "curated", key: "editor", value: "vim" })).rejects.toThrow(
      'YMMV_HANDLE is "bob" but the YMMV_TOKEN account has no handle bound.',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("no handle bound + YMMV_HANDLE unset: the two-cause copy, not the file login's reserved-word diagnosis", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const fetchFn = vi.fn().mockResolvedValueOnce(whoami(null));
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: true });
    expect(fetchFn).toHaveBeenCalledTimes(1); // whoami only, never a read or POST
    expect(process.exitCode).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain("The account behind YMMV_TOKEN has no handle bound.");
    expect(out).toContain("`ymmv login`"); // fixes a handle another account has since proven
    expect(out).toContain("rename on GitHub first"); // the only fix for a reserved username
    expect(out).not.toContain("—");
  });

  it("a whoami failure fails the write command with its own copy and sends nothing else", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const fetchFn = vi.fn().mockResolvedValueOnce(missing()); // a Worker without the endpoint
    vi.stubGlobal("fetch", fetchFn);
    await expect(runUnset({ kind: "curated", key: "editor" })).rejects.toThrow(
      "has no identity lookup for YMMV_TOKEN",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled(); // never falls back to a device flow
  });

  it("delete names the VERIFIED page, keeps the token file, and sends the env bearer", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(whoami("carol"))
      .mockResolvedValueOnce(jsonRes({ ok: true }));
    vi.stubGlobal("fetch", fetchFn);
    await runDelete({ interactive: false, yes: true });
    expect(deleteToken).not.toHaveBeenCalled(); // the file may hold a DIFFERENT account's login
    expect(logs.join("\n")).toContain("Deleted ymmv.fyi/carol.");
    expect(initOf(fetchFn, 1).method).toBe("DELETE");
    expect((initOf(fetchFn, 1).headers as Record<string, string>).authorization).toBe(
      "Bearer ymmv_env",
    );
  });

  it("delete refusal (non-TTY, no -y) names the verified page and sends no DELETE", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const fetchFn = vi.fn().mockResolvedValueOnce(whoami("carol"));
    vi.stubGlobal("fetch", fetchFn);
    await runDelete({ interactive: false, yes: false });
    expect(fetchFn).toHaveBeenCalledTimes(1); // whoami only
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("Refusing to delete ymmv.fyi/carol");
  });

  it("delete with no handle bound still names the binding it is about to act on", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(whoami(null))
      .mockResolvedValueOnce(jsonRes({ ok: true }));
    vi.stubGlobal("fetch", fetchFn);
    await runDelete({ interactive: false, yes: true });
    expect(logs.join("\n")).toContain("Deleted the profile bound to YMMV_TOKEN.");
  });

  // The guard on a permanent delete: the secret pair says bob, the token is alice's. Nothing may
  // leave the machine after the lookup, with -y or at the interactive prompt.
  it("delete with a mismatched YMMV_HANDLE refuses BEFORE any DELETE request (-y)", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred("bob"));
    const fetchFn = vi.fn().mockResolvedValueOnce(whoami("alice"));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runDelete({ interactive: false, yes: true })).rejects.toThrow(
      'YMMV_TOKEN belongs to "alice"',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(deleteToken).not.toHaveBeenCalled();
  });

  it("delete with a mismatched YMMV_HANDLE never reaches the confirm prompt (interactive)", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred("bob"));
    const fetchFn = vi.fn().mockResolvedValueOnce(whoami("alice"));
    vi.stubGlobal("fetch", fetchFn);
    const prompter = stubPrompter({ confirm: vi.fn().mockResolvedValue(true) });
    await expect(runDelete({ interactive: true, yes: false, prompter })).rejects.toThrow(
      "Fix or unset YMMV_HANDLE",
    );
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("view: a verified env credential diffs as 'you'", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("them", [{ key: "editor", value: "vim" }])))
      .mockResolvedValueOnce(whoami("me"))
      .mockResolvedValueOnce(jsonRes(prof("me", [{ key: "editor", value: "helix" }])));
    vi.stubGlobal("fetch", fetchFn);
    await view("them");
    expect(urlOf(fetchFn, 1)).toContain("/api/v1/auth/whoami");
    expect(urlOf(fetchFn, 2)).toContain("/api/v1/u/me"); // "mine" is the VERIFIED handle
    const out = logs.join("\n");
    expect(out).toContain("you");
    expect(out).toContain("helix");
    expect(errs).toEqual([]);
  });

  it("view: viewing the token's own handle shows the card, never a self-diff", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const mine = prof("me", [{ key: "editor", value: "helix" }]);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(mine))
      .mockResolvedValueOnce(whoami("Me")) // casing differs; still the same profile
      .mockResolvedValueOnce(jsonRes(mine));
    vi.stubGlobal("fetch", fetchFn);
    await view("me");
    const out = logs.join("\n");
    expect(out).toContain("helix");
    expect(out).not.toContain("you");
  });

  it("view: a verified env credential with NO handle bound shows the card and says why there is no diff", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("them", [{ key: "editor", value: "vim" }])))
      .mockResolvedValueOnce(whoami(null));
    vi.stubGlobal("fetch", fetchFn);
    await view("them");
    expect(fetchFn).toHaveBeenCalledTimes(2); // no "mine" fetch: there is no handle to fetch
    expect(process.exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("vim");
    expect(logs.join("\n")).not.toContain("you");
    expect(errs.join("\n")).toContain(
      "(no diff: the account behind YMMV_TOKEN has no handle bound)",
    );
  });

  it("set and unset complete under a verified env credential, reading and writing the whoami handle", async () => {
    // The common CI path after publish: requireHandle takes the whoami handle, the read goes to
    // it, assertHandleUnchanged compares against it, and publishProfile reuses the credential.
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const existing = () => jsonRes(prof("me", [{ key: "editor", value: "vim" }]));
    let fetchFn = vi
      .fn()
      .mockResolvedValueOnce(whoami("me"))
      .mockResolvedValueOnce(existing())
      .mockResolvedValueOnce(jsonRes({ handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    await runSet({ kind: "curated", key: "shell", value: "fish" });
    expect(process.exitCode).toBeUndefined();
    expect(urlOf(fetchFn, 1)).toMatch(/\/api\/v1\/profile$/); // the own read, under the env bearer
    expect(posted(fetchFn, 2).handle).toBe("me");
    expect(logs.join("\n")).toContain("Set Shell = fish.");

    fetchFn = vi
      .fn()
      .mockResolvedValueOnce(whoami("me"))
      .mockResolvedValueOnce(existing())
      .mockResolvedValueOnce(jsonRes({ handle: "me" }));
    vi.stubGlobal("fetch", fetchFn);
    await runUnset({ kind: "curated", key: "editor" });
    expect(process.exitCode).toBeUndefined();
    expect(posted(fetchFn, 2).entries.find((e) => e.key === "editor")).toBeUndefined();
    expect(logs.join("\n")).toContain('Removed Editor (was "vim").');
  });

  it("a renamed profile under an env credential says re-run, never `ymmv login` (which YMMV_TOKEN shadows)", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(whoami("old"))
      .mockResolvedValueOnce(jsonRes(prof("new"))); // the read followed a rename 301
    vi.stubGlobal("fetch", fetchFn);
    const err = await runSet({ kind: "curated", key: "shell", value: "fish" }).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toContain("Re-run the command.");
    expect((err as Error).message).not.toContain("ymmv login");
    expect(fetchFn).toHaveBeenCalledTimes(2); // no POST
  });

  it("view: a target 404 returns before any credential is touched, so the token is never sent", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const fetchFn = vi.fn().mockResolvedValueOnce(missing());
    vi.stubGlobal("fetch", fetchFn);
    await view("ghost");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("view: a whoami failure degrades to the plain card with the REAL reason on stderr, exit 0", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred(null));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("them", [{ key: "editor", value: "vim" }])))
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchFn);
    await view("them");
    expect(fetchFn).toHaveBeenCalledTimes(2); // never a "mine" fetch under an unverified identity
    expect(process.exitCode).toBeUndefined(); // the requested profile DID render
    expect(logs.join("\n")).toContain("vim");
    expect(logs.join("\n")).not.toContain("you");
    const err = errs.join("\n");
    expect(err).toContain("No diff: The server rejected the token in YMMV_TOKEN");
    expect(err).not.toContain("(No diff"); // whole sentences are never wrapped in parens
    expect(err).not.toContain("ymmv_env"); // the token never prints
  });

  it("view: a mismatched YMMV_HANDLE never labels anyone 'you'; stderr names both handles, exit 0", async () => {
    vi.mocked(loadCredential).mockResolvedValue(envCred("bob"));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(prof("them", [{ key: "editor", value: "vim" }])))
      .mockResolvedValueOnce(whoami("alice"));
    vi.stubGlobal("fetch", fetchFn);
    await view("them");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeUndefined();
    expect(logs.join("\n")).not.toContain("you");
    expect(errs.join("\n")).toContain('YMMV_HANDLE is "bob" but YMMV_TOKEN belongs to "alice"');
  });
});

// A stored login's identity was server-minted at login: it must never cost a whoami round trip.
describe("file credential never triggers the identity lookup", () => {
  it("publish, set, unset, view, and delete send no whoami request", async () => {
    vi.mocked(loadToken).mockResolvedValue(stored());
    const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes({ handle: "me" });
      if (init?.method === "DELETE") return jsonRes({ ok: true });
      return String(input).endsWith("/u/them")
        ? jsonRes(prof("them"))
        : jsonRes(prof("me", [{ key: "editor", value: "vim" }]));
    });
    vi.stubGlobal("fetch", fetchFn);
    await publish({ interactive: false, yes: true });
    await runSet({ kind: "curated", key: "shell", value: "fish" });
    await runUnset({ kind: "curated", key: "editor" });
    await view("them");
    expect(loadCredential).toHaveBeenCalled(); // view reads the env-aware store, as a FILE login
    await runDelete({ interactive: false, yes: true });
    // Every command RAN to completion (a refusal or early return would make the whoami check
    // below pass vacuously): exit 0 throughout, and the exact request sequence.
    expect(process.exitCode).toBeUndefined();
    const sent = fetchFn.mock.calls.map(
      (c) =>
        `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${String(c[0]).replace(/^.*\/api/, "/api")}`,
    );
    expect(sent).toEqual([
      "GET /api/v1/profile", // publish read (own, authed)
      "POST /api/v1/profile",
      "GET /api/v1/profile", // set read
      "POST /api/v1/profile",
      "GET /api/v1/profile", // unset read
      "POST /api/v1/profile",
      "GET /api/v1/u/them", // view target (public)
      "GET /api/v1/u/me", // view "mine" (public: display only)
      "DELETE /api/v1/profile",
    ]);
  });
});
