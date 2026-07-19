import { readFileSync, statSync } from "node:fs";
import {
  CURATED_KEYS,
  type CuratedKey,
  diff,
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
  fetchProfileJson,
  PublishRefusal,
  type PublishResult,
  publishProfile,
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
  displayUrl,
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
import { type Credential, deleteToken, loadToken } from "./token-store.js";

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
 * without YMMV_HANDLE is a different diagnosis: the token may be fine, the handle is just unset —
 * the reserved-word copy would be a lie there.
 */
function requireHandle(cred: Credential): string | null {
  if (cred.handle) return cred.handle;
  console.error(
    message(
      cred.source === "env"
        ? "YMMV_TOKEN is set but YMMV_HANDLE is not. Set YMMV_HANDLE to the GitHub username " +
            "the token belongs to."
        : "Your GitHub username is a reserved word, so no handle is bound. " +
            "Rename on GitHub, then run `ymmv login` again.",
    ),
  );
  process.exitCode = 1;
  return null;
}

/**
 * Refuse a read-modify-write when the pre-write read resolved to a DIFFERENT handle than the
 * login-bound one (fetchProfileJson follows the 301 a GitHub rename leaves behind). Republishing
 * would silently rebind the account to the stale handle — re-login is the only sanctioned rebind.
 */
function assertHandleUnchanged(existing: Profile | null, handle: string): void {
  if (existing && existing.handle.toLowerCase() !== handle.toLowerCase()) {
    throw new Error(
      `This login is bound to "${handle}" but your profile now lives at ` +
        `"${sanitizeValue(existing.handle)}". Run \`ymmv login\` to refresh, then retry.`,
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
    // Re-ask on an over-cap paste instead of letting the server 422 the whole publish after all
    // 13 answers are in. Defaults can never exceed the cap (existing values are server-capped,
    // detection emits short tool names), so accepting Enter-for-default stays safe.
    for (;;) {
      const answer = (await prompter.ask(KEY_LABELS[key], defaults.get(key))).trim();
      const value = answer === "-" ? "" : answer;
      if (value.length > MAX_VALUE) {
        // If the over-cap value IS the stored default (possible after a server-side cap raise
        // with a stale CLI, or a generous YMMV_API origin), Enter-to-keep would loop forever —
        // name the default as the problem and the two ways out.
        const isDefault = value === (defaults.get(key) ?? "").trim();
        console.log(
          message(
            `${c.faint}${
              isDefault
                ? `the saved value is ${value.length} characters; the cap is ${MAX_VALUE}. Type a shorter value or - to clear`
                : `that value is ${value.length} characters; the cap is ${MAX_VALUE}`
            }${c.reset}`,
          ),
        );
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
  // NOT caught: fetchProfileJson returns null only on a 404 (no profile yet) and THROWS on a real
  // read failure. Swallowing the throw would let a transient error look like "no profile", and the
  // upsert (server does delete-then-insert) would then clobber every curated key + extra. Abort.
  const existing = await fetchProfileJson(handle);
  assertHandleUnchanged(existing, handle);
  const defaults = buildDefaults(existing, detected);
  // Keys a newer taxonomy published that this build doesn't know: carried through verbatim (the
  // upsert is a full replace — rebuilding from our compiled-in key list alone would delete them).
  const carried = unknownEntries(existing);
  const extras = existing?.extras ?? [];
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

  // -y (TTY or not) and non-TTY: no prompts, no confirm — preview what will publish, then go.
  // (Also fixes TTY `ymmv -y`, which used to walk all 13 prompts despite help's "without prompts".)
  if (!io.interactive || !io.prompter || io.yes) {
    // Detection is the one input that skips both the argv and prompt pre-flights (env-derived
    // values land in the defaults verbatim), and this branch has no re-ask to recover with —
    // refuse locally instead of shipping a doomed POST. Scoped to the curated map: carried
    // entries are deliberately exempt (a newer server's caps may exceed this build's), and the
    // interactive paths recover through the re-prompt/edit loop instead.
    const over = [...values].find(([, v]) => v.length > MAX_VALUE);
    if (over) {
      console.error(
        message(
          `The detected ${KEY_LABELS[over[0]]} value is ${over[1].length} characters; ` +
            `the cap is ${MAX_VALUE}. Set a shorter one: ymmv set ${over[0]} <value>.`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    const entries = assemble();
    showCard(entries);
    printPublished(await publishProfile(newProfile(handle, entries, extras)), color);
    return;
  }

  try {
    // First-ever publish: guided walk up front (nothing merged worth previewing yet). Republish:
    // card first — Enter republishes as-is, e edits.
    if (!existing) values = await promptEntries(values, io.prompter);
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
          printPublished(await publishProfile(newProfile(handle, entries, extras)), color);
          return;
        } catch (e) {
          // A TRANSIENT failure (5xx, 429, a wire 422, network) must not discard the 13 answers
          // the user just typed — print why and re-enter the loop (card + Y/n/e). Deterministic
          // failures pass through: PromptAborted (^C during the re-login device flow) keeps its
          // exit-130 contract, and PublishRefusal means retrying the SAME attempt can never
          // succeed (identity drifted; a fresh run must rebuild the merge), so exit honestly.
          if (e instanceof PromptAborted || e instanceof PublishRefusal) throw e;
          // Honest about what's known: a server-ANSWERED failure (4xx/5xx body) proves nothing
          // was written, but a lost response (NetworkError/timeout) can arrive AFTER the server
          // committed — never claim "nothing was published" for those. (The retry also replays
          // the pre-loop read; see the RMW entry in TODOS.md.)
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
      values = await promptEntries(values, io.prompter); // "e": edit, prefilled with current answers
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

  // view never forces a login, and stays ENV-BLIND on purpose (loadToken, not loadCredential):
  // YMMV_HANDLE is unverified input, so an env credential must never label a fetched profile as
  // "you" — a mislabeled diff is confidently wrong output (pinned in commands.test.ts; see the
  // TODOS identity entry for the trusted-identity path that would lift this).
  const cred = await loadToken();
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
      console.log(renderProfile(theirs, { color: c, site: displayUrl(BASE) }));
      if (mineFailed) {
        // Degradation diagnostic, so stderr: piped stdout stays deterministic (the card only),
        // and exit stays 0 — the requested profile DID render.
        const codes = palette(c);
        console.error(message(`${codes.faint}(couldn't load your profile to diff)${codes.reset}`));
      } else {
        // Logged in but genuinely never published — the one amber nudge.
        console.log(nudge(c));
      }
      return;
    }
    // Viewing your own handle: just show it (no self-diff).
  }
  console.log(renderProfile(theirs, { color: c, site: displayUrl(BASE) }));
}

/** `ymmv set <key> <value>` / `--extra` — read-modify-write one field, then republish. */
export async function runSet(target: SetTarget): Promise<void> {
  const cred = await ensureLogin();
  const handle = requireHandle(cred);
  if (!handle) return;
  // NOT caught (same reason as publish): a transient read failure must abort, never republish a
  // truncated profile. fetchProfileJson returns null only for a genuine 404.
  const existing = await fetchProfileJson(handle);
  assertHandleUnchanged(existing, handle);
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
  const res = await publishProfile(newProfile(handle, entries, extras));
  const line =
    target.kind === "curated"
      ? `Set ${KEY_LABELS[target.key]} = ${target.value}.`
      : `Set extra ${target.label} = ${target.value}.`;
  console.log(message(`${line}${pagePointer(res.handle)}`));
}

/** `ymmv unset <key>` / `--extra <label>` — read, remove one field, republish; no-op skips the POST. */
export async function runUnset(target: UnsetTarget): Promise<void> {
  const cred = await ensureLogin();
  const handle = requireHandle(cred);
  if (!handle) return;
  // NOT caught (same reason as publish): a transient read failure must abort, never republish a
  // truncated profile. fetchProfileJson returns null only for a genuine 404.
  const existing = await fetchProfileJson(handle);
  assertHandleUnchanged(existing, handle);
  if (!existing) {
    // Removing from nothing is a harmless no-op — and never POST an empty first profile here.
    console.log(message("No profile yet. Run `ymmv` to publish one."));
    return;
  }
  const { entries, extras, removed } = applyUnset(existing, target);
  if (!removed) {
    console.log(
      message(
        target.kind === "curated"
          ? `${KEY_LABELS[target.key]} is not set.`
          : `No extra "${target.label}".`,
      ),
    );
    return; // idempotent no-op: exit 0, and crucially no network write
  }
  const res = await publishProfile(newProfile(handle, entries, extras));
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
  // name the host actually being hit (YMMV_API can point this at a dev/staging Worker). But delete
  // acts on the TOKEN's account (the request carries no handle), and an env credential's handle is
  // unverified YMMV_HANDLE input — echoing it could confirm deletion of a profile the token does
  // not own. Name the binding instead; a file credential's handle was server-minted at login.
  const target =
    cred.source === "env"
      ? "the profile bound to YMMV_TOKEN"
      : cred.handle
        ? `${displayUrl(BASE)}/${sanitizeValue(cred.handle)}`
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
