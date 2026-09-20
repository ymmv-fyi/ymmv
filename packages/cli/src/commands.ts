import { readFileSync, statSync } from "node:fs";
import {
  CURATED_KEYS,
  type CuratedKey,
  diff,
  displayUrl,
  type Entry,
  isCuratedKey,
  KEY_LABELS,
  MAX_EXTRAS,
  MAX_VALUE,
  type Profile,
  SCHEMA_VERSION,
} from "@ymmv/shared";
import {
  deleteProfile,
  ensureLogin,
  fetchOwnProfile,
  fetchProfileJson,
  ProfileChanged,
  PublishRefusal,
  type PublishResult,
  publishProfile,
  verifyEnvCredential,
} from "./api.js";
import { BASE } from "./config.js";
import { detectStack } from "./detect.js";
import {
  addDismissals,
  type Dismissal,
  isDismissed,
  readDismissals,
  writeDismissals,
} from "./dismissals.js";
import { displayError, isTimeoutError, NetworkError } from "./http.js";
import {
  applySet,
  applyUnset,
  buildDefaults,
  detectionDisagreements,
  entriesFromMap,
  profileChanges,
  sameContent,
  unknownEntries,
} from "./profile-ops.js";
import { PromptAborted, type Prompter } from "./prompt.js";
import {
  colorEnabled,
  link,
  linkForm,
  message,
  notFound,
  nudge,
  palette,
  relTime,
  renderDiff,
  renderProfile,
  sanitizeValue,
  shownValue,
  showsVisibleText,
  takeLine,
} from "./render.js";
import type { SetTarget, UnsetTarget } from "./resolve.js";
import { type Credential, deleteToken, loadCredential } from "./token-store.js";

// The command layer: orchestrates the pure pieces (detect/diff/render/merge) with the network +
// token store. Each command keeps its IO at the edges so the branching logic stays testable.

export interface InteractiveIO {
  interactive: boolean;
  prompter?: Prompter;
  yes: boolean;
}

export interface PublishIO extends InteractiveIO {
  /** Where dismissed detection marks are remembered. Absent = this run only, no file IO. */
  dismissalsPath?: string;
  /** Forget every dismissed mark before the first card. */
  resetMarks?: boolean;
}

/**
 * The bound handle, or null after printing the canonical "no handle" error + setting the exit code.
 * A reserved GitHub username binds to a null handle; publish/set both refuse. An env credential
 * gets its own copy: whoami said the token's account has no handle, which has TWO causes the CLI
 * can't tell apart, a reserved username (rename first) or a handle another account has since
 * proven (a login rebinds the current username, and the existing token works again after it).
 */
function requireHandle(cred: Credential): string | null {
  if (cred.handle) return cred.handle;
  console.error(
    message(
      cred.source === "env"
        ? "The account behind YMMV_TOKEN has no handle bound. Run `ymmv login` on an interactive " +
            "machine, as the same GitHub account, to rebind it. If that GitHub username is a " +
            "reserved word, rename on GitHub first."
        : "Your GitHub username is a reserved word, so no handle is bound. " +
            "Rename on GitHub, then run `ymmv login` again.",
    ),
  );
  process.exitCode = 1;
  return null;
}

/**
 * Refuse a read-modify-write when the pre-write read resolved to a DIFFERENT handle than the
 * login-bound one (the own read answers with the handle the server binds to this account NOW, so
 * a mismatch means a re-login elsewhere moved it after this credential was stored). Republishing
 * would silently rebind the account to the stale handle — re-login is the only sanctioned rebind.
 * Under an env credential the handle came from whoami moments ago, so the mismatch is a bind that
 * changed in between; `ymmv login` would only write a file token YMMV_TOKEN keeps shadowing, and
 * a fresh run looks the handle up again.
 */
function assertHandleUnchanged(existing: Profile | null, cred: Credential, handle: string): void {
  if (existing && existing.handle.toLowerCase() !== handle.toLowerCase()) {
    throw new Error(
      `This login is bound to "${handle}" but your profile now lives at ` +
        `"${sanitizeValue(existing.handle)}". ${
          cred.source === "env" ? "Re-run the command." : "Run `ymmv login` to refresh, then retry."
        }`,
    );
  }
}

function newProfile(handle: string, entries: Entry[], extras: Profile["extras"]): Profile {
  return {
    schema_version: SCHEMA_VERSION,
    handle,
    entries,
    extras,
    updated_at: new Date().toISOString(),
  };
}

/** The publish confirmation — composed here, not in the network layer (IO at the edges). */
function printPublished(res: PublishResult, color: boolean): void {
  console.log(message(`Published ${res.handle} → ${link(res.url, color)}`));
}

/** Faint pointer at the live page, appended to set/unset confirmations. Never amber — it repeats
 *  on every mutation; amber stays for links worth following + diff-differences. */
function pagePointer(handle: string): string {
  const color = colorEnabled();
  const c = palette(color);
  return ` ${c.faint}→ ${color ? displayUrl(BASE) : BASE}/${handle}${c.reset}`;
}

/** The first curated entry that fails a write rule, as the refusal to print, or undefined when the
 *  merge is clean. Every no-prompt write path (-y, set, unset) runs it before the POST: the server
 *  would 422 the same values, and its message would read as a rejection of what the user just
 *  typed. Scoped to curated keys: carried entries are deliberately exempt (a newer server's caps
 *  may exceed this build's, and its visibility rule is its own to enforce). Names the real source:
 *  a value saved before the server enforced a rule is the user's, not their environment's. */
function writeRuleRefusal(entries: Entry[], existing: Profile | null): string | undefined {
  const saved = savedKeys(existing);
  for (const { key, value } of entries) {
    if (!isCuratedKey(key)) continue;
    const problem = valueProblem(value);
    if (problem === undefined) continue;
    const remedy = problem === "invisible" ? "Set one" : "Set a shorter one";
    const source = saved.has(key) ? "saved" : "detected";
    // A saved value with nothing visible is more likely wanted gone than replaced; unset works
    // because applyUnset drops the entry before this check sees the merge.
    const remove =
      problem === "invisible" && source === "saved" ? `, or remove it: ymmv unset ${key}` : "";
    return (
      `The ${source} ${KEY_LABELS[key]} value ${ruleClause(problem, value)}. ` +
      `${remedy}: ymmv set ${key} <value>${remove}.`
    );
  }
  return undefined;
}

/** Which write rule a curated value fails, or undefined. The ONE predicate behind the three
 *  siblings of the argv pre-flight: promptEntries' re-ask, the publish loop's walk gate, and
 *  writeRuleRefusal. They must agree exactly, or a value the gate rejects and the re-ask accepts
 *  would walk the 13 prompts forever without ever reaching a card. */
function valueProblem(value: string): "invisible" | "over-cap" | undefined {
  if (!showsVisibleText(value)) return "invisible";
  if (value.length > MAX_VALUE) return "over-cap";
  return undefined;
}

/** The rule half of a refusal sentence, one source for every surface; each appends its remedy. */
function ruleClause(problem: "invisible" | "over-cap", value: string): string {
  return problem === "invisible"
    ? "has no visible text"
    : `is ${value.length} characters; the cap is ${MAX_VALUE}`;
}

/** Every key the saved profile carries (curated and newer-taxonomy alike): a failing default under
 *  one of these is the user's own stored value, anything else came from detection. */
function savedKeys(existing: Profile | null): ReadonlySet<string> {
  return new Set((existing?.entries ?? []).map((e) => e.key));
}

/** Two example values per key, shown at a walk prompt that has no default to explain itself
 *  ("Prompt" alone reads as a question to anyone who has not met Starship). Hand-written: the
 *  catalog (TOOLS) lists only tools that need a diff alias, so it has no Starship, tmux or mise.
 *  A test keeps every name here spelled the way the catalog or the detector spells it. */
export const KEY_EXAMPLES: Record<Exclude<CuratedKey, "dotfiles">, readonly [string, string]> = {
  editor: ["Neovim", "VS Code"],
  os: ["macOS", "Arch Linux"],
  shell: ["zsh", "fish"],
  prompt: ["Starship", "Oh My Posh"],
  terminal: ["Ghostty", "WezTerm"],
  browser: ["Firefox", "Chrome"],
  "window-manager": ["Hyprland", "GNOME"],
  font: ["JetBrains Mono", "Fira Code"],
  theme: ["Catppuccin", "Tokyo Night"],
  multiplexer: ["tmux", "Zellij"],
  "version-manager": ["mise", "nvm"],
  "ai-tool": ["Claude Code", "Cursor"],
};

/** The faint parenthetical for a walk prompt with no default. */
export function walkHint(key: CuratedKey): string {
  return key === "dotfiles" ? "a URL" : `e.g. ${KEY_EXAMPLES[key].join(", ")}`;
}

/** A dotfiles value typed without a scheme never links, on the page or in the card: offer its
 *  https form once and return whichever the user picked. `exact` because the question shows a URL
 *  the user might paste back, which must re-ask and never count as "n". `tight` inside the walk,
 *  which is one unit; at `ymmv set` the question is the command's first output and opens its own. */
async function offerLinkForm(
  value: string,
  handle: string,
  prompter: Prompter,
  tight: boolean,
): Promise<string> {
  const url = linkForm(value, handle);
  if (url === undefined) return value;
  const ans = await prompter.choice(`use ${url}?`, ["y", "n"], "y", "Y/n", { tight, exact: true });
  return ans === "y" ? url : value;
}

/** Walk the curated keys, offering each detected/existing value as the default ("-" clears a key).
 *  `marked` holds the rows a fresh detection disagrees with: each prompt carries the detected
 *  value as a faint hint, so Enter there is a keep made with the detection in view. A prompt with
 *  no default carries an example instead. `handle` is whose `user/repo` a dotfiles answer may name.
 *  Returns the chosen map so the edit loop can re-enter with the previous answers prefilled. */
async function promptEntries(
  defaults: Map<CuratedKey, string>,
  saved: ReadonlySet<string>,
  prompter: Prompter,
  marked: ReadonlyMap<CuratedKey, string>,
  handle: string,
): Promise<Map<CuratedKey, string>> {
  const c = palette(colorEnabled());
  console.log(message(`${c.faint}Enter to keep, "-" to clear${c.reset}`));
  const chosen = new Map<CuratedKey, string>();
  for (const key of CURATED_KEYS) {
    const detectedNow = marked.get(key);
    // A default explains itself (`[Starship]`), so the example is for the bare prompt only: no
    // default, or one that sanitizes to nothing (promptLine's own test for printing no brackets).
    const hint =
      detectedNow !== undefined
        ? `detected: ${detectedNow}`
        : sanitizeValue(defaults.get(key) ?? "")
          ? undefined
          : walkHint(key);
    // Re-ask on an over-cap or invisible-only paste instead of letting the server 422 the whole
    // publish after all 13 answers are in. A DETECTED default can fail either rule (an env value
    // of only U+200B survives detection's trim; a stale CLI can see a server-raised cap), and then
    // Enter-to-keep would loop forever — so name the default as the problem and the two ways out.
    for (;;) {
      const answer = (await prompter.ask(KEY_LABELS[key], defaults.get(key), hint)).trim();
      const value = answer === "-" ? "" : answer;
      // Enter returns the SANITIZED default (prompt.ts), so compare against that form: a default
      // carrying a bidi control would otherwise never read as "the saved value". A default that
      // sanitizes to nothing comes back as "", which must not pass for "no answer, skip the key":
      // under "Enter to keep" that would silently clear it, and a 412 rebase replays the clear.
      const rawDefault = defaults.get(key) ?? "";
      const isDefault = value === shownValue(rawDefault);
      const emptiedDefault = answer === "" && rawDefault !== "";
      const problem = emptiedDefault ? "invisible" : value === "" ? undefined : valueProblem(value);
      if (problem !== undefined) {
        // Name the default's real source when it is the problem (a saved value is the user's own,
        // a detected one is their environment's), and the two ways out.
        const which = `the ${saved.has(key) ? "saved" : "detected"} value`;
        const clause = ruleClause(problem, value);
        const note = isDefault
          ? `${which} ${clause}. Type a ${problem === "invisible" ? "value" : "shorter value"} or - to clear`
          : `that value ${clause}`;
        console.log(message(`${c.faint}${note}${c.reset}`));
        continue;
      }
      // A kept default is not re-offered: declining once makes the typed form the default of any
      // later walk, and Enter there keeps it.
      const final =
        key === "dotfiles" && !isDefault
          ? await offerLinkForm(value, handle, prompter, true)
          : value;
      if (final) chosen.set(key, final);
      break;
    }
  }
  return chosen;
}

/**
 * `ymmv` (default) — detect → card-first confirm/edit → upsert. Detection never blocks.
 *
 *   ymmv (publish)
 *     ├─ non-TTY, no -y ──────────────► refuse (needs -y), exit 1
 *     ├─ non-TTY + -y  OR  TTY + -y ──► preview card ─┬─ changes something ► POST  (no prompts)
 *     │                                               └─ nothing to change ► say so  exit 0
 *     └─ interactive
 *          ├─ no existing profile ────► guided 13 prompts (hint line once) ─┐
 *          ├─ existing profile ───────► (skip prompts) ─────────────────────┤
 *          └─► LOOP: preview card (rows a fresh detection disagrees with carry a faint
 *               │     "(detected: X)" note, unless that exact disagreement was dismissed in
 *               │     an earlier run; rows the publish would change on the live profile carry
 *               │     a `~`/`+`/`-` gutter mark) + carried-note + dup-extra note (recomputed)
 *               ├─ choice "Publish to <site>/<h>?" [Y/n/e=edit] (+d=detected while a row is marked)
 *               │  Nothing differs from what is live ► "Nothing changed. Last published <when>."
 *               │  and the choice becomes "Publish to <site>/<h> anyway?" [y/N/e=edit]
 *               ├─ y ──► POST ─┬─ ok ────────────► Published
 *               │              ├─ transient err ─► "…Your answers are kept." ─► LOOP
 *               │              ├─ 412 changed ───► re-read, rebase answers onto it ─► LOOP
 *               │              └─ PublishRefusal ► rethrow (identity drifted)  exit 1
 *               ├─ n ──► "Aborted. Nothing published." ("Left as is." at the anyway prompt)  exit 0
 *               ├─ e ──► 13 prompts prefilled with current answers; a marked row's prompt shows
 *               │        "(detected: X)", and Enter there keeps the value for this run ─► LOOP
 *               ├─ d ──► per marked row "Label  saved → detected" [Y/n]: y takes the detected
 *               │        value, n keeps the saved one and dismisses the mark (remembered
 *               │        across runs; `--reset-marks` forgets) ─► LOOP
 *               └─ ^C ─► PromptAborted ► "Aborted. Nothing published."  exit 130
 *
 *   Every walk (first run, `e`, the write-rule gate): a prompt with no default shows a faint
 *   example, and a dotfiles answer typed without a scheme is offered once in its https form,
 *   "use <url>?" [Y/n].
 *
 *   After a failed POST nothing is called unchanged until a 412 reload settles what is live.
 *   After a lost response (the write may have landed) both abort lines read "Aborted. The
 *   earlier publish may have completed." for the rest of the run.
 */
export async function publish(io: PublishIO): Promise<void> {
  // No terminal means no confirm step, so publishing needs the explicit -y — the same non-TTY
  // consent gate `ymmv delete` enforces. Detection fills most of a profile now; a scripted bare
  // `ymmv` silently adding newly detected public fields would betray "nothing publishes until
  // you confirm". Checked before login so a refused CI run can't trigger a device flow either.
  if (!io.interactive && !io.yes) {
    console.error(
      message("Non-interactive publish needs -y (nothing publishes unconfirmed): ymmv -y"),
    );
    process.exitCode = 1;
    return;
  }
  const cred = await ensureLogin();
  const handle = requireHandle(cred);
  if (!handle) return;

  // The injected reader is detection's one sanctioned file read (/etc/os-release — see DetectOpts).
  // Bounded: refuse non-regular files (a FIFO would hang readFileSync) and anything over 64 KiB
  // (a real os-release is <1 KiB) — linuxDistro() catches the throw and falls back to "Linux".
  const detected = detectStack(process.env, process.platform, {
    readTextFile: (p) => {
      const st = statSync(p);
      if (!st.isFile() || st.size > 64 * 1024) throw new Error("not a readable os-release");
      return readFileSync(p, "utf8");
    },
  });
  // NOT caught: fetchOwnProfile returns null only on the Worker's own "no profile yet" 404 and
  // THROWS on a real read failure. Swallowing the throw would let a transient error look like "no
  // profile", and the upsert (server does delete-then-insert) would then clobber every curated key
  // + extra. Abort.
  const own = await fetchOwnProfile(cred);
  const existing = own?.profile ?? null;
  assertHandleUnchanged(existing, cred, handle);
  const defaults = buildDefaults(existing, detected);
  // Keys a newer taxonomy published that this build doesn't know: carried through verbatim (the
  // upsert is a full replace — rebuilding from our compiled-in key list alone would delete them).
  // `let`, with `extras`, `ifMatch` and `live`: a 412 mid-loop reloads all four from a fresh
  // read; showCard/assemble close over them, so the next card is the reload.
  let carried = unknownEntries(existing);
  let extras = existing?.extras ?? [];
  let ifMatch = own?.etag;
  // What the change marks and the nothing-changed check compare against. `existing` stays the
  // profile this run started from (first publish or not); `live` follows a 412 reload.
  let live = existing;
  const color = colorEnabled();
  const site = displayUrl(BASE);

  // Preview card + its notes, recomputed per render: an edit pass can create or remove the
  // duplicate-extra condition, so the hints must describe THIS iteration's entries. The row
  // marks (`disagreements`, `changes`) are this iteration's too: a `d`, a walk, or a 412 reload
  // changes them.
  const showCard = (
    entries: Entry[],
    disagreements: ReadonlyMap<CuratedKey, string>,
    changes: ReadonlyMap<CuratedKey, string | null> | undefined,
  ): void => {
    console.log(
      renderProfile(newProfile(handle, entries, extras), {
        color,
        site,
        mode: "preview",
        disagreements,
        changes,
      }),
    );
    const notes: string[] = [];
    if (carried.length > 0) {
      // renderProfile shows only the keys this build knows — list what's riding along instead of
      // previewing a lie. Values came off the wire, so they get the same sanitize-before-print.
      const s = carried.length === 1 ? "" : "s";
      notes.push(`(+${carried.length} newer field${s} kept as-is; upgrade ymmv-cli to edit them)`);
      for (const e of carried) {
        notes.push(`  ${sanitizeValue(e.key)} = ${sanitizeValue(e.value)}`);
      }
    }
    // Migration nudge: pre-0.5 profiles carried Theme/Prompt/… as free-form extras (the documented
    // escape hatch the curated keys replaced). Once a curated field holds the value, the old extra
    // only duplicates the row on the page and in diffs — point at the cleanup, never auto-delete.
    const publishedLabels = new Set(
      entries.filter((e) => isCuratedKey(e.key)).map((e) => KEY_LABELS[e.key].toLowerCase()),
    );
    for (const x of extras) {
      if (publishedLabels.has(x.label.trim().toLowerCase())) {
        const label = sanitizeValue(x.label.trim());
        notes.push(`(extra "${label}" duplicates a curated field; ymmv unset --extra "${label}")`);
      }
    }
    // One notes unit, separate from the card (tests index cards by their breadcrumb line).
    if (notes.length > 0) console.log(message(notes.join("\n")));
  };

  let values = defaults;
  const assemble = (): Entry[] => [...entriesFromMap(values), ...carried];
  // What this publish would change on the live profile, for the card's marks; undefined on a
  // first publish, where every row would be new and the marks would say nothing.
  const pending = (): Map<CuratedKey, string | null> | undefined =>
    live ? profileChanges(live, values) : undefined;
  // Set when a POST failed: `live` may no longer be what is live. A lost response can follow a
  // commit, and so can a 5xx a gateway answered for a Worker that did commit (publishProfile
  // does not type those apart, and being wrong here costs one ordinary publish). Until a 412
  // reload settles it, nothing is called unchanged, and the retry goes out under the old tag for
  // the server to arbitrate (a 412 if the write did land).
  let unsure = false;
  // A lost response, for the rest of the run: a reload makes `live` trustworthy again, not the
  // claim that this run published nothing.
  let maybePublished = false;
  const aborted = (): string =>
    maybePublished
      ? "Aborted. The earlier publish may have completed."
      : "Aborted. Nothing published.";
  // The line for a publish that would only move the updated date and spend a write-limit slot,
  // else undefined. Byte-for-byte against the payload as the server would store it (it trims
  // every value and label), which is stricter than the marks: a stored value or extra label
  // padded before the server trimmed writes shows no mark, but publishing still normalizes it,
  // so that run publishes (once; the next one is unchanged).
  const unchangedLine = (entries: Entry[]): string | undefined => {
    const sent = entries.map((e) => ({ ...e, value: e.value.trim() }));
    const sentExtras = extras.map((x) => ({ label: x.label.trim(), value: x.value.trim() }));
    return live && !unsure && sameContent(live, sent, sentExtras)
      ? `Nothing changed. Last published ${relTime(live.updated_at)}.`
      : undefined;
  };
  // The user's explicit edits (undefined = cleared with "-"), kept apart from `values`: on a
  // republish nobody is prompted, so `values` is server state, not answers. A 412 reload rebases
  // onto the live profile and re-applies exactly these.
  const edits = new Map<CuratedKey, string | undefined>();
  // Marked keys a walk visited without changing, with the value that was kept: Enter (or retyping
  // the value) is "keep", and a kept value must not be replaced by a later `d`. A 412 rebase
  // keeps the decision only where the live value still equals it; a key another device changed
  // is marked afresh, since a decision about the old value says nothing about the new one.
  const kept = new Map<CuratedKey, string>();
  // Marks the user answered "n" to in the per-key take, this run's and (loaded below, past the
  // -y branch) earlier runs'. Each is the exact (key, saved, detected) asked about, so unlike
  // `kept` it needs no 412 care: a reload that changes the live value no longer matches it.
  let dismissed: Dismissal[] = [];
  let saved = savedKeys(existing);
  // Rows to mark on this card: where a fresh detection names a different tool than the shown
  // value, minus keys the user already decided this session (edited, cleared, taken, kept), minus
  // disagreements dismissed in this or an earlier run, minus detected values the write rules
  // refuse (an invisible one would print "(detected: )", and taking it would send `d` into the
  // loop-top walk, where the re-ask calls it "the saved value").
  const disagreeing = (): Map<CuratedKey, string> => {
    const out = detectionDisagreements(
      values,
      detected,
      new Set([...edits.keys(), ...kept.keys()]),
    );
    for (const [key, value] of out) {
      const current = values.get(key);
      const hidden = current !== undefined && isDismissed(dismissed, key, current, value);
      if (hidden || valueProblem(value) !== undefined) out.delete(key);
    }
    return out;
  };
  const prompt = async (prompter: Prompter): Promise<void> => {
    const before = values;
    const marked = disagreeing();
    values = await promptEntries(values, saved, prompter, marked, handle);
    for (const key of CURATED_KEYS) {
      const after = values.get(key);
      if (after !== before.get(key)) edits.set(key, after);
    }
    // Every marked row's prompt showed its detection; a mark that survives that look is a
    // decision, not a gap. This run only: persisting takes the per-key "n".
    for (const key of marked.keys()) {
      const value = values.get(key);
      if (!edits.has(key) && value !== undefined) kept.set(key, value);
    }
  };

  // -y (TTY or not) and non-TTY: no prompts, no confirm — preview what will publish, then go.
  // (Also fixes TTY `ymmv -y`, which used to walk all 13 prompts despite help's "without prompts".)
  if (!io.interactive || !io.prompter || io.yes) {
    // Detection (env-derived values land in the defaults verbatim) and a value saved before a
    // rule existed both skip the argv and prompt pre-flights, and this branch has no re-ask to
    // recover with — refuse locally instead of shipping a doomed POST; the interactive path
    // recovers through the re-prompt/edit loop.
    const entries = assemble();
    const refusal = writeRuleRefusal(entries, existing);
    if (refusal !== undefined) {
      console.error(message(refusal));
      process.exitCode = 1;
      return;
    }
    // No detection marks here: a scripted run's environment (a CI runner) is rarely the user's
    // stack, so a "(detected: X)" note would describe the wrong machine, with no key to act on
    // anyway. The change marks do print: they describe the write itself, and a runner's detection
    // filling a gap is exactly the `+` row a log reader should see.
    showCard(entries, new Map(), pending());
    // After the refusal on purpose: an unchanged profile whose curated value no longer passes a
    // write rule is still worth exit 1. Skipping the write keeps a scheduled `ymmv -y` from moving
    // the updated date every run.
    const same = unchangedLine(entries);
    if (same) {
      console.log(message(`${same} Nothing to publish.`));
      return;
    }
    printPublished(
      await publishProfile(newProfile(handle, entries, extras), cred, { ifMatch }),
      color,
    );
    return;
  }

  // Past the -y branch on purpose: a scripted run shows no marks, so it reads no dismissals.
  // `--reset-marks` empties the file before the first card, so it holds even if the user then
  // walks away from the confirm. It sits behind the login and the profile read like the rest of
  // the interactive path: a run those stop never got as far as showing a mark.
  const { dismissalsPath } = io;
  if (dismissalsPath !== undefined) {
    if (io.resetMarks) await writeDismissals(dismissalsPath, []);
    else dismissed = await readDismissals(dismissalsPath);
  }

  try {
    // First-ever publish: guided walk up front (nothing merged worth previewing yet). Republish:
    // card first — Enter publishes, or leaves the page alone when nothing would change (see
    // unchangedLine), e edits.
    if (!existing) await prompt(io.prompter);
    const failsRule = ([, v]: [CuratedKey, string]) => valueProblem(v) !== undefined;
    for (;;) {
      // Never offer a card the server would 422 and this loop would re-offer unchanged: when a
      // merged default fails a write rule (a value saved before the rule existed, or a detected
      // value filling a key the saved profile lacks), walk first, where the re-ask names the saved
      // value and offers "-". At the loop top so a 412 reload's fresh merge is gated the same way.
      if ([...values].some(failsRule)) await prompt(io.prompter);
      const entries = assemble();
      const disagreements = disagreeing();
      showCard(entries, disagreements, pending());
      // Nothing differs from what is live: say so and flip the default, so Enter from someone who
      // only came to look writes nothing. Still a question, not an exit: `e` is how a returning
      // user edits, a `d` mark is often the one thing to act on at such a card, and `y` is the way
      // to move the updated date on purpose.
      const same = unchangedLine(entries);
      if (same) console.log(message(same));
      // `d` exists only while a row is marked, so a first publish and a republish that changes
      // something keep the exact prompt the landing transcript mirrors; an unoffered `d` simply
      // re-asks.
      const offerD = disagreements.size > 0;
      const ans = await io.prompter.choice(
        `Publish to ${site}/${sanitizeValue(handle)}${same ? " anyway" : ""}?`,
        offerD ? ["y", "n", "e", "d"] : ["y", "n", "e"],
        same ? "n" : "y",
        `${same ? "y/N" : "Y/n"}/e=edit${offerD ? "/d=detected" : ""}`,
      );
      if (ans === "y") {
        try {
          printPublished(
            await publishProfile(newProfile(handle, entries, extras), cred, { ifMatch }),
            color,
          );
          return;
        } catch (e) {
          // 412: a write landed elsewhere (another device, a CI run) while the user was at the
          // prompt. Retrying the same merge would clobber it, and exiting would throw away the
          // answers — so reload what is live, rebase onto it (fresh defaults + the user's explicit
          // edits, cleared keys included), and re-offer the card. The re-read is NOT caught: a
          // transient failure there aborts, like the pre-loop read. A deleted profile is a
          // refusal: silently re-offering a card that would recreate it is not "answers kept".
          if (e instanceof ProfileChanged) {
            console.error(
              message(
                "Your profile changed since this command read it. " +
                  "Reloaded the current version; your answers are kept.",
              ),
            );
            // publishProfile's own heal may have replaced the stored token: re-read it so the
            // reload does not go out under a revoked one (an env credential is the caller's, never
            // re-read). The write is still judged against the credential the merge was built under.
            const liveCred = cred.source === "env" ? cred : ((await loadCredential()) ?? cred);
            const fresh = await fetchOwnProfile(liveCred);
            if (!fresh) {
              throw new PublishRefusal(
                "Your profile was deleted since this command read it. Nothing was published. " +
                  "Run `ymmv` again to recreate it.",
              );
            }
            assertHandleUnchanged(fresh.profile, cred, handle);
            const rebased = buildDefaults(fresh.profile, detected);
            for (const [key, value] of edits) {
              if (value === undefined) rebased.delete(key);
              else rebased.set(key, value);
            }
            values = rebased;
            for (const [key, value] of kept) if (rebased.get(key) !== value) kept.delete(key);
            saved = savedKeys(fresh.profile);
            live = fresh.profile;
            unsure = false;
            carried = unknownEntries(fresh.profile);
            extras = fresh.profile.extras;
            ifMatch = fresh.etag;
            continue;
          }
          // A TRANSIENT failure (5xx, 429, a wire 422, network) must not discard the 13 answers
          // the user just typed — print why and re-enter the loop (card + Y/n/e). Deterministic
          // failures pass through: PromptAborted (^C during the re-login device flow) keeps its
          // exit-130 contract, and PublishRefusal means retrying the SAME attempt can never
          // succeed (identity drifted; a fresh run must rebuild the merge), so exit honestly.
          if (e instanceof PromptAborted || e instanceof PublishRefusal) throw e;
          // Honest about what's known: a server-ANSWERED failure (4xx/5xx body) proves nothing
          // was written, but a lost response (NetworkError/timeout) can arrive AFTER the server
          // committed — never claim "nothing was published" for those. The retry re-sends the
          // same tag, so a write that landed in between surfaces as the 412 branch above.
          const ambiguous = e instanceof NetworkError || isTimeoutError(e);
          unsure = true;
          if (ambiguous) maybePublished = true;
          console.error(
            message(
              `${displayError(e)}\n${
                ambiguous
                  ? "The publish may not have completed. Your answers are kept."
                  : "Nothing was published. Your answers are kept."
              }`,
            ),
          );
          continue;
        }
      }
      if (ans === "n") {
        // Declining at a nothing-changed card aborts nothing. It can also follow a lost response
        // whose write did land (the 412 reload then shows it as live), where "Nothing published"
        // would be false.
        console.log(message(same ? "Left as is." : aborted()));
        return;
      }
      if (ans === "d") {
        // One question per marked row, even for a single mark: detection is session-contextual
        // (an editor's terminal, tmux, SSH), so the row the user wants rarely travels alone, and
        // "n" is the only quick way to say "I know, stop telling me". Taken values are explicit
        // edits: a 412 rebase re-applies them over the reloaded profile.
        values = new Map(values);
        const width = Math.max(...[...disagreements.keys()].map((k) => KEY_LABELS[k].length));
        let tight = false;
        const before = dismissed.length;
        try {
          for (const [key, value] of disagreements) {
            // A marked key always has a value (a gap is never a disagreement); this only narrows.
            const current = values.get(key);
            if (current === undefined) continue;
            const take = await io.prompter.choice(
              takeLine(KEY_LABELS[key], width, current, value, color),
              ["y", "n"],
              "y",
              "Y/n",
              { tight, exact: true },
            );
            tight = true;
            if (take === "y") {
              values.set(key, value);
              edits.set(key, value);
            } else {
              dismissed = [...dismissed, { key, saved: shownValue(current), detected: value }];
            }
          }
        } finally {
          // In a finally so an "n" answered before a ^C is remembered: it was about the saved
          // and detected values, not about this publish. A "y" before one is lost with the run.
          if (dismissalsPath !== undefined && dismissed.length > before) {
            await addDismissals(dismissalsPath, dismissed.slice(before));
          }
        }
        // The one side effect the row question does not show: an "n" outlives the run. Say so
        // once the questions are done, with the way back (which forgets every dismissal, not just
        // these). Only when there is a file for it to live in. A ^C mid-questions skips this: the
        // prompt line is torn and the abort message owns that moment.
        const keptNow = dismissed.length - before;
        if (keptNow > 0 && dismissalsPath !== undefined) {
          const c = palette(color);
          console.log(
            message(
              `${c.faint}Kept ${keptNow} as saved. ymmv --reset-marks brings every dismissed mark back.${c.reset}`,
            ),
          );
        }
        continue;
      }
      await prompt(io.prompter); // "e": edit, prefilled with current answers
    }
  } catch (e) {
    if (e instanceof PromptAborted) {
      // The first newline closes the interrupted prompt line; then the standard unit.
      console.log(`\n${message(aborted())}`);
      process.exitCode = 130;
      return;
    }
    // Whatever ends the run now (a refusal, a failed re-read) may say "Nothing was published"
    // about ITS attempt; after a lost response that reads as a claim about the whole run.
    if (maybePublished) {
      console.error(message("The earlier publish may have completed."));
    }
    throw e;
  }
}

/** `ymmv <handle>` — view a profile: own→diff, logged-in-no-profile→nudge, unknown→friendly. */
export async function view(handle: string): Promise<void> {
  const theirs = await fetchProfileJson(handle);
  const c = colorEnabled();
  if (!theirs) {
    console.log(notFound(handle, c, BASE));
    return;
  }
  // The plain card, optionally with a diff-degradation diagnostic. The note goes to stderr so
  // piped stdout stays deterministic (the card only), and exit stays 0: the requested profile DID
  // render. Faint, never amber: it repeats on every degraded view. A short fragment is wrapped in
  // parens; an error message (whole sentences, often with parens of its own) is not.
  const plainCard = (note?: string, wrap = true): void => {
    console.log(renderProfile(theirs, { color: c, site: displayUrl(BASE) }));
    if (note) {
      const codes = palette(c);
      console.error(message(`${codes.faint}${wrap ? `(${note})` : note}${codes.reset}`));
    }
  };

  // view never forces a login. An env credential labels a fetched profile as "you" only once
  // whoami has VERIFIED it: YMMV_HANDLE alone is unverified input, and a mislabeled diff is
  // confidently wrong output. A failed verification (dead token, stale YMMV_HANDLE, old Worker,
  // network) degrades to the plain card with the real reason on stderr, never a guess and never a
  // hidden failure. The lookup sits AFTER the 404 return above, so a miss never sends the token.
  let cred = await loadCredential();
  if (cred?.source === "env") {
    try {
      cred = await verifyEnvCredential(cred);
    } catch (e) {
      plainCard(`No diff: ${displayError(e)}`, false);
      return;
    }
    if (cred.handle === null) {
      // Verified, but the account has no handle to diff under (the two causes requireHandle
      // names). Say so: a silent plain card here would read exactly like being logged out.
      plainCard("no diff: the account behind YMMV_TOKEN has no handle bound");
      return;
    }
  }
  if (cred?.handle) {
    // A transient failure fetching MY profile degrades to a plain view (read-only path, no
    // writes) — but it must NOT be conflated with the genuine 404 null below: telling a published
    // user "publish yours to diff" because a fetch timed out is wrong copy. The sentinel keeps
    // the two apart.
    let mineFailed = false;
    const mine = await fetchProfileJson(cred.handle).catch(() => {
      mineFailed = true;
      return null;
    });
    if (mine && mine.handle.toLowerCase() !== theirs.handle.toLowerCase()) {
      console.log(
        renderDiff(diff(mine, theirs), { color: c, theirsLabel: theirs.handle, mineLabel: "you" }),
      );
      return;
    }
    if (!mine) {
      if (mineFailed) {
        plainCard("couldn't load your profile to diff");
      } else {
        // Logged in but genuinely never published — the one amber nudge.
        plainCard();
        console.log(nudge(c));
      }
      return;
    }
    // Viewing your own handle: just show it (no self-diff).
  }
  plainCard();
}

/** `ymmv set <key> <value>` / `--extra` — read-modify-write one field, then republish (unless
 *  the field already holds exactly that, which writes nothing). A dotfiles value typed without a
 *  scheme gets the walk's offer when `prompter` is given (index.ts passes one only with a terminal
 *  on both ends) and the login is a person's: `set` is what the README recommends for CI, so under
 *  YMMV_TOKEN it never waits on a question, pty or not. With no one to ask, the value is stored as
 *  typed and a faint stderr line names the command that would make it a link. */
export async function runSet(typed: SetTarget, prompter?: Prompter): Promise<void> {
  const cred = await ensureLogin();
  const handle = requireHandle(cred);
  if (!handle) return;
  let target = typed;
  let linkNote: string | undefined;
  if (typed.kind === "curated" && typed.key === "dotfiles") {
    if (prompter && cred.source !== "env") {
      // Asked BEFORE the read: a human pause between it and the If-Match POST would only widen
      // the window for a 412.
      try {
        target = { ...typed, value: await offerLinkForm(typed.value, handle, prompter, false) };
      } catch (e) {
        if (e instanceof PromptAborted) {
          // The first newline closes the interrupted prompt line; then the standard unit.
          console.log(`\n${message("Cancelled. Nothing set.")}`);
          process.exitCode = 130;
          return;
        }
        throw e;
      }
    } else {
      const url = linkForm(typed.value, handle);
      if (url !== undefined) {
        linkNote = `Stored as text, not a link. Link it: ymmv set dotfiles ${url}`;
      }
    }
  }
  // NOT caught (same reason as publish): a transient read failure must abort, never republish a
  // truncated profile. fetchOwnProfile returns null only for the Worker's own "no profile" 404.
  const own = await fetchOwnProfile(cred);
  const existing = own?.profile ?? null;
  assertHandleUnchanged(existing, cred, handle);
  const { entries, extras } = applySet(existing, target);
  // Count pre-flight needs the merged profile, so it lives here, not in parseSet. Only a genuine
  // 33rd extra trips it — applySet replaces an existing label in place, so editing at the cap
  // keeps length === MAX_EXTRAS and publishes. (Stored profiles can't exceed the cap: the server
  // has enforced it since the initial commit.)
  if (target.kind === "extra" && extras.length > MAX_EXTRAS) {
    console.error(
      message(
        `Your profile already has ${MAX_EXTRAS} extras; that's the cap. ` +
          `Remove one first: ymmv unset --extra "Label".`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  // The target itself was pre-flighted at the argv boundary; this catches a SAVED value that no
  // longer passes, so the refusal names that key instead of reading as a rejection of the set.
  const refusal = writeRuleRefusal(entries, existing);
  if (refusal !== undefined) {
    console.error(message(refusal));
    process.exitCode = 1;
    return;
  }
  if (existing && sameContent(existing, entries, extras)) {
    // Same echo rule as the success line below. Byte-equal only: a respelled value or an
    // extra label's new casing is a change, and publishes.
    const line =
      target.kind === "curated"
        ? `${KEY_LABELS[target.key]} is already ${sanitizeValue(target.value)}.`
        : `Extra "${sanitizeValue(target.label)}" is already ${sanitizeValue(target.value)}.`;
    console.log(message(line));
    noteOnStderr(linkNote);
    return; // idempotent no-op, like unset's: exit 0, no network write, the updated date stays
  }
  const res = await publishProfile(newProfile(handle, entries, extras), cred, {
    ifMatch: own?.etag,
  });
  // Echo of the value set: same strip-escapes rule as every rejection echo. From argv the
  // pre-flight only rejects a value with nothing visible, so one mixing an escape sequence with
  // real text arrives here raw (an accepted link form is ASCII by linkForm's own patterns).
  const line =
    target.kind === "curated"
      ? `Set ${KEY_LABELS[target.key]} = ${sanitizeValue(target.value)}.`
      : `Set extra ${sanitizeValue(target.label)} = ${sanitizeValue(target.value)}.`;
  console.log(message(`${line}${pagePointer(res.handle)}`));
  noteOnStderr(linkNote);
}

/** A faint aside about a write, on stderr so captured stdout stays the result line alone. */
function noteOnStderr(note: string | undefined): void {
  if (note === undefined) return;
  const c = palette(colorEnabled());
  console.error(message(`${c.faint}${note}${c.reset}`));
}

// The suggestion below is meant to be pasted, so the label rides inside it only when it cannot
// change the command's meaning: letters, digits, and a few plain separators. Anything else (quotes,
// `$(`, backticks, escapes, bidi controls) falls back to the generic placeholder.
const PASTE_SAFE_LABEL = /^[\p{L}\p{N} _.+/:-]+$/u;

/** Muscle-memory nudge for `unset --extra "Label=Value"`: parseSet splits on the first "=", so when
 *  the part before it names a stored extra, that is almost certainly the label meant. Only reached
 *  on a miss and only ever adds a line: a genuine "=" label (curl-written) that is already gone
 *  stays the exit-0 no-op, with the nudge still naming a stored head if one happens to exist. */
function extraHint(existing: Profile, label: string): string {
  const eq = label.indexOf("=");
  const head = eq > 0 ? label.slice(0, eq).trim() : "";
  if (!head || !applyUnset(existing, { kind: "extra", label: head }).removed) return "";
  const shown = PASTE_SAFE_LABEL.test(head) ? head : "Label";
  return `\n(unset takes just the label: ymmv unset --extra "${shown}")`;
}

/** `ymmv unset <key>` / `--extra <label>` — read, remove one field, republish; no-op skips the POST. */
export async function runUnset(target: UnsetTarget): Promise<void> {
  const cred = await ensureLogin();
  const handle = requireHandle(cred);
  if (!handle) return;
  // NOT caught (same reason as publish): a transient read failure must abort, never republish a
  // truncated profile. fetchOwnProfile returns null only for the Worker's own "no profile" 404.
  const own = await fetchOwnProfile(cred);
  const existing = own?.profile ?? null;
  assertHandleUnchanged(existing, cred, handle);
  if (!existing) {
    // Removing from nothing is a harmless no-op — and never POST an empty first profile here.
    console.log(message("No profile yet. Run `ymmv` to publish one."));
    return;
  }
  const { entries, extras, removed } = applyUnset(existing, target);
  if (!removed) {
    // target.label is argv, echoed on a no-op: same strip-escapes rule as every rejection echo.
    const line =
      target.kind === "curated"
        ? `${KEY_LABELS[target.key]} is not set.`
        : `No extra "${sanitizeValue(target.label)}".${extraHint(existing, target.label)}`;
    console.log(message(line));
    return; // idempotent no-op: exit 0, and crucially no network write
  }
  // Same as runSet: a SAVED value that no longer passes a write rule is named before the POST.
  const refusal = writeRuleRefusal(entries, existing);
  if (refusal !== undefined) {
    console.error(message(refusal));
    process.exitCode = 1;
    return;
  }
  const res = await publishProfile(newProfile(handle, entries, extras), cred, {
    ifMatch: own?.etag,
  });
  // removed.* comes off the wire — sanitize it, as every echo here is (runSet's argv one too).
  const line =
    target.kind === "curated"
      ? `Removed ${KEY_LABELS[target.key]} (was "${sanitizeValue(removed.value)}").`
      : `Removed extra "${sanitizeValue(removed.label)}" (was "${sanitizeValue(removed.value)}").`;
  console.log(message(`${line}${pagePointer(res.handle)}`));
}

/** `ymmv delete` — confirm, then hard-delete server-side + drop the now-revoked local token. */
export async function runDelete(io: InteractiveIO): Promise<void> {
  const cred = await ensureLogin();
  // BASE-derived like every other printed page reference — consent for a permanent delete must
  // name the host actually being hit (YMMV_API can point this at a dev/staging Worker). Delete acts
  // on the TOKEN's account (the request carries no handle), so the handle named here must be one
  // the server vouched for: minted at login for a file credential, looked up by whoami for an env
  // one (ensureLogin already refused a YMMV_HANDLE that names a different account). With no handle
  // bound there is no page to name; an env credential still names its binding, so the consent line
  // for a permanent delete says WHICH account is about to lose every session.
  const target = cred.handle
    ? `${displayUrl(BASE)}/${sanitizeValue(cred.handle)}`
    : cred.source === "env"
      ? "the profile bound to YMMV_TOKEN"
      : "your profile";

  // Destructive: require explicit consent. Interactive → confirm prompt; non-interactive (pipe / CI
  // / no TTY) → REFUSE unless -y was passed. Never hard-delete a profile with neither a prompt nor an
  // explicit flag (the asymmetry with publish is deliberate — publish is an idempotent upsert).
  if (!io.yes) {
    if (!io.interactive || !io.prompter) {
      console.error(
        message(
          `Refusing to delete ${target} without confirmation. Re-run with -y to confirm: ymmv delete -y`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    let go: boolean;
    try {
      go = await io.prompter.confirm(`Delete ${target}? This is permanent`, false);
    } catch (e) {
      if (e instanceof PromptAborted) {
        // The first newline closes the interrupted prompt line; then the standard unit.
        console.log(`\n${message("Cancelled. Nothing deleted.")}`);
        process.exitCode = 130;
        return;
      }
      throw e;
    }
    if (!go) {
      console.log(message("Cancelled. Nothing deleted."));
      return;
    }
  }
  // The credential the user just confirmed — deleteProfile must never re-read the store.
  await deleteProfile(cred);
  // The server revoked every token for the deleted account; drop the dead local one. An env
  // credential leaves the file ALONE: it may hold a different account's still-live token, and the
  // env var itself is not the CLI's to delete.
  if (cred.source === "file") await deleteToken();
  console.log(message(`Deleted ${target}. Run \`ymmv\` to publish again.`));
}
