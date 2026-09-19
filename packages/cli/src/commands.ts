import { readFileSync, statSync } from "node:fs";
import {
  CURATED_KEYS,
  type CuratedKey,
  diff,
  displayUrl,
  type Entry,
  hasVisibleContent,
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
import { displayError, isTimeoutError, NetworkError } from "./http.js";
import {
  applySet,
  applyUnset,
  buildDefaults,
  entriesFromMap,
  unknownEntries,
} from "./profile-ops.js";
import { PromptAborted, type Prompter } from "./prompt.js";
import {
  colorEnabled,
  link,
  message,
  notFound,
  nudge,
  palette,
  renderDiff,
  renderProfile,
  sanitizeValue,
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

/** Walk the curated keys, offering each detected/existing value as the default ("-" clears a key).
 *  Returns the chosen map so the edit loop can re-enter with the previous answers prefilled. */
async function promptEntries(
  defaults: Map<CuratedKey, string>,
  prompter: Prompter,
): Promise<Map<CuratedKey, string>> {
  const c = palette(colorEnabled());
  console.log(message(`${c.faint}Enter to keep, "-" to clear${c.reset}`));
  const chosen = new Map<CuratedKey, string>();
  for (const key of CURATED_KEYS) {
    // Re-ask on an over-cap or invisible-only paste instead of letting the server 422 the whole
    // publish after all 13 answers are in. A DETECTED default can fail either rule (an env value
    // of only U+200B survives detection's trim; a stale CLI can see a server-raised cap), and then
    // Enter-to-keep would loop forever — so name the default as the problem and the two ways out.
    for (;;) {
      const answer = (await prompter.ask(KEY_LABELS[key], defaults.get(key))).trim();
      const value = answer === "-" ? "" : answer;
      // Enter returns the SANITIZED default (prompt.ts), so compare against that form: a default
      // carrying a bidi control would otherwise never read as "the saved value". A default that
      // sanitizes to nothing comes back as "", which must not pass for "no answer, skip the key":
      // under "Enter to keep" that would silently clear it, and a 412 rebase replays the clear.
      const rawDefault = defaults.get(key) ?? "";
      const isDefault = value === sanitizeValue(rawDefault).trim();
      const emptiedDefault = answer === "" && rawDefault !== "";
      let problem: string | undefined;
      if (emptiedDefault || (value !== "" && !hasVisibleContent(value))) {
        problem = isDefault
          ? "the saved value has no visible text. Type a value or - to clear"
          : "that value has no visible text";
      } else if (value.length > MAX_VALUE) {
        problem = isDefault
          ? `the saved value is ${value.length} characters; the cap is ${MAX_VALUE}. Type a shorter value or - to clear`
          : `that value is ${value.length} characters; the cap is ${MAX_VALUE}`;
      }
      if (problem !== undefined) {
        console.log(message(`${c.faint}${problem}${c.reset}`));
        continue;
      }
      if (value) chosen.set(key, value);
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
 *     ├─ non-TTY + -y  OR  TTY + -y ──► preview card ► POST            (no prompts)
 *     └─ interactive
 *          ├─ no existing profile ────► guided 13 prompts (hint line once) ─┐
 *          ├─ existing profile ───────► (skip prompts) ─────────────────────┤
 *          └─► LOOP: preview card + carried-note + dup-extra note (recomputed)
 *               ├─ choice "Publish to <site>/<h>?" [Y/n/e=edit]
 *               ├─ y ──► POST ─┬─ ok ────────────► Published
 *               │              ├─ transient err ─► "…Your answers are kept." ─► LOOP
 *               │              ├─ 412 changed ───► re-read, rebase answers onto it ─► LOOP
 *               │              └─ PublishRefusal ► rethrow (identity drifted)  exit 1
 *               ├─ n ──► "Aborted. Nothing published."  exit 0
 *               ├─ e ──► 13 prompts prefilled with current answers ─► LOOP
 *               └─ ^C ─► PromptAborted ► "Aborted. Nothing published."  exit 130
 */
export async function publish(io: InteractiveIO): Promise<void> {
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
  // `let`, with `extras` and `ifMatch`: a 412 mid-loop reloads all three from a fresh read;
  // showCard/assemble close over them, so the next card is the reload.
  let carried = unknownEntries(existing);
  let extras = existing?.extras ?? [];
  let ifMatch = own?.etag;
  const color = colorEnabled();
  const site = displayUrl(BASE);

  // Preview card + its notes, recomputed per render: an edit pass can create or remove the
  // duplicate-extra condition, so the hints must describe THIS iteration's entries.
  const showCard = (entries: Entry[]): void => {
    console.log(
      renderProfile(newProfile(handle, entries, extras), { color, site, mode: "preview" }),
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
  // The user's explicit edits (undefined = cleared with "-"), kept apart from `values`: on a
  // republish nobody is prompted, so `values` is server state, not answers. A 412 reload rebases
  // onto the live profile and re-applies exactly these.
  const edits = new Map<CuratedKey, string | undefined>();
  const prompt = async (prompter: Prompter): Promise<void> => {
    const before = values;
    values = await promptEntries(values, prompter);
    for (const key of CURATED_KEYS) {
      const after = values.get(key);
      if (after !== before.get(key)) edits.set(key, after);
    }
  };

  // -y (TTY or not) and non-TTY: no prompts, no confirm — preview what will publish, then go.
  // (Also fixes TTY `ymmv -y`, which used to walk all 13 prompts despite help's "without prompts".)
  if (!io.interactive || !io.prompter || io.yes) {
    // Detection is the one input that skips both the argv and prompt pre-flights (env-derived
    // values land in the defaults verbatim), and this branch has no re-ask to recover with —
    // refuse locally instead of shipping a doomed POST. Scoped to the curated map: carried
    // entries are deliberately exempt (a newer server's caps may exceed this build's, and its
    // visibility rule is its own to enforce), and the interactive paths recover through the
    // re-prompt/edit loop instead.
    // Name the real source: buildDefaults prefers a saved value over detection, and a value
    // stored before the server enforced a rule is the user's, not their environment's.
    const saved = new Set((existing?.entries ?? []).map((e) => e.key));
    for (const [key, v] of values) {
      const problem = !hasVisibleContent(v)
        ? "has no visible text. Set one"
        : v.length > MAX_VALUE
          ? `is ${v.length} characters; the cap is ${MAX_VALUE}. Set a shorter one`
          : undefined;
      if (problem === undefined) continue;
      const source = saved.has(key) ? "saved" : "detected";
      console.error(
        message(`The ${source} ${KEY_LABELS[key]} value ${problem}: ymmv set ${key} <value>.`),
      );
      process.exitCode = 1;
      return;
    }
    const entries = assemble();
    showCard(entries);
    printPublished(
      await publishProfile(newProfile(handle, entries, extras), cred, { ifMatch }),
      color,
    );
    return;
  }

  try {
    // First-ever publish: guided walk up front (nothing merged worth previewing yet). Republish:
    // card first — Enter republishes as-is, e edits — unless a merged default fails a write rule
    // (detection filled a key the saved profile lacks with an invisible-only or over-cap value):
    // then walk first, where the re-ask names the saved value and offers "-", rather than offer a
    // card the server would 422 and re-offer unchanged.
    const failsRule = ([, v]: [CuratedKey, string]) =>
      !hasVisibleContent(v) || v.length > MAX_VALUE;
    if (!existing || [...values].some(failsRule)) await prompt(io.prompter);
    for (;;) {
      const entries = assemble();
      showCard(entries);
      const ans = await io.prompter.choice(
        `Publish to ${site}/${sanitizeValue(handle)}?`,
        ["y", "n", "e"],
        "y",
        "Y/n/e=edit",
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
        console.log(message("Aborted. Nothing published."));
        return;
      }
      await prompt(io.prompter); // "e": edit, prefilled with current answers
    }
  } catch (e) {
    if (e instanceof PromptAborted) {
      // The first newline closes the interrupted prompt line; then the standard unit.
      console.log(`\n${message("Aborted. Nothing published.")}`);
      process.exitCode = 130;
      return;
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

/** `ymmv set <key> <value>` / `--extra` — read-modify-write one field, then republish. */
export async function runSet(target: SetTarget): Promise<void> {
  const cred = await ensureLogin();
  const handle = requireHandle(cred);
  if (!handle) return;
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
  const res = await publishProfile(newProfile(handle, entries, extras), cred, {
    ifMatch: own?.etag,
  });
  // argv echo: same strip-escapes rule as every rejection echo (an ESC-only value is invisible
  // to the pre-flight only after sanitizing, so the raw string can still carry a sequence).
  const line =
    target.kind === "curated"
      ? `Set ${KEY_LABELS[target.key]} = ${sanitizeValue(target.value)}.`
      : `Set extra ${sanitizeValue(target.label)} = ${sanitizeValue(target.value)}.`;
  console.log(message(`${line}${pagePointer(res.handle)}`));
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
  const res = await publishProfile(newProfile(handle, entries, extras), cred, {
    ifMatch: own?.etag,
  });
  // removed.* comes off the wire (unlike runSet's echo of the user's own argv) — sanitize it.
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
