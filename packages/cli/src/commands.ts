import { readFileSync, statSync } from "node:fs";
import {
  CURATED_KEYS,
  type CuratedKey,
  diff,
  type Entry,
  isCuratedKey,
  KEY_LABELS,
  type Profile,
  SCHEMA_VERSION,
} from "@ymmv/shared";
import { deleteProfile, ensureLogin, fetchProfileJson, publishProfile } from "./api.js";
import { BASE } from "./config.js";
import { detectStack } from "./detect.js";
import {
  applySet,
  applyUnset,
  buildDefaults,
  entriesFromMap,
  unknownEntries,
} from "./profile-ops.js";
import type { Prompter } from "./prompt.js";
import {
  colorEnabled,
  notFound,
  nudge,
  renderDiff,
  renderProfile,
  sanitizeValue,
} from "./render.js";
import type { SetTarget, UnsetTarget } from "./resolve.js";
import { deleteToken, loadToken, type StoredToken } from "./token-store.js";

// The command layer: orchestrates the pure pieces (detect/diff/render/merge) with the network +
// token store. Each command keeps its IO at the edges so the branching logic stays testable.

export interface InteractiveIO {
  interactive: boolean;
  prompter?: Prompter;
  yes: boolean;
}

/**
 * The bound handle, or null after printing the canonical "no handle" error + setting the exit code.
 * A reserved GitHub username binds to a null handle; publish/set both refuse.
 */
function requireHandle(cred: StoredToken): string | null {
  if (cred.handle) return cred.handle;
  console.error(
    "Your GitHub username is a reserved word, so no handle is bound. " +
      "Rename on GitHub, then run `ymmv login` again.",
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
      `this login is bound to "${handle}" but your profile now lives at ` +
        `"${sanitizeValue(existing.handle)}" — run \`ymmv login\` to refresh, then retry.`,
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

/** Walk the curated keys, offering each detected/existing value as the default ("-" clears a key). */
async function promptEntries(
  defaults: Map<CuratedKey, string>,
  prompter: Prompter,
): Promise<Entry[]> {
  const chosen = new Map<CuratedKey, string>();
  for (const key of CURATED_KEYS) {
    const answer = (await prompter.ask(KEY_LABELS[key], defaults.get(key))).trim();
    const value = answer === "-" ? "" : answer;
    if (value) chosen.set(key, value);
  }
  return entriesFromMap(chosen);
}

/** `ymmv` (default) — detect → show → confirm/edit → upsert. Detection never blocks. */
export async function publish(io: InteractiveIO): Promise<void> {
  // No terminal means no confirm step, so publishing needs the explicit -y — the same non-TTY
  // consent gate `ymmv delete` enforces. Detection fills most of a profile now; a scripted bare
  // `ymmv` silently adding newly detected public fields would betray "nothing publishes until
  // you confirm". Checked before login so a refused CI run can't trigger a device flow either.
  if (!io.interactive && !io.yes) {
    console.error("Non-interactive publish needs -y (nothing publishes unconfirmed): ymmv -y");
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

  let entries = entriesFromMap(defaults);
  const extras = existing?.extras ?? [];
  if (io.interactive && io.prompter) {
    entries = await promptEntries(defaults, io.prompter);
  }
  entries = [...entries, ...carried];

  const profile = newProfile(handle, entries, extras);
  console.log(renderProfile(profile, { color: colorEnabled() }));
  if (carried.length > 0) {
    // renderProfile shows only the keys this build knows — list what's riding along instead of
    // previewing a lie. Values came off the wire, so they get the same sanitize-before-print.
    const s = carried.length === 1 ? "" : "s";
    console.log(`(+${carried.length} newer field${s} kept as-is — upgrade ymmv-cli to edit them)`);
    for (const e of carried) {
      console.log(`    ${sanitizeValue(e.key)} = ${sanitizeValue(e.value)}`);
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
      console.log(`(extra "${label}" duplicates a curated field — ymmv unset --extra "${label}")`);
    }
  }

  if (io.interactive && io.prompter && !io.yes) {
    const go = await io.prompter.confirm(`Publish to ymmv.fyi/${handle}?`, true);
    if (!go) {
      console.log("Aborted — nothing published.");
      return;
    }
  }
  await publishProfile(profile);
}

/** `ymmv <handle>` — view a profile: own→diff, logged-in-no-profile→nudge, unknown→friendly. */
export async function view(handle: string): Promise<void> {
  const theirs = await fetchProfileJson(handle);
  const c = colorEnabled();
  if (!theirs) {
    console.log(notFound(handle, c, BASE));
    return;
  }

  const cred = await loadToken(); // view never forces a login
  if (cred?.handle) {
    // A transient failure fetching MY profile degrades to a plain view (read-only path, no writes).
    const mine = await fetchProfileJson(cred.handle).catch(() => null);
    if (mine && mine.handle.toLowerCase() !== theirs.handle.toLowerCase()) {
      console.log(
        renderDiff(diff(mine, theirs), { color: c, theirsLabel: theirs.handle, mineLabel: "you" }),
      );
      return;
    }
    if (!mine) {
      // Logged in but haven't published — show theirs plus the one amber nudge.
      console.log(renderProfile(theirs, { color: c }));
      console.log(nudge(c));
      return;
    }
    // Viewing your own handle: just show it (no self-diff).
  }
  console.log(renderProfile(theirs, { color: c }));
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
  await publishProfile(newProfile(handle, entries, extras));
  if (target.kind === "curated") {
    console.log(`Set ${KEY_LABELS[target.key]} = ${target.value}.`);
  } else {
    console.log(`Set extra ${target.label} = ${target.value}.`);
  }
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
    console.log("No profile yet — run `ymmv` to publish one.");
    return;
  }
  const { entries, extras, removed } = applyUnset(existing, target);
  if (!removed) {
    console.log(
      target.kind === "curated"
        ? `${KEY_LABELS[target.key]} is not set.`
        : `No extra "${target.label}".`,
    );
    return; // idempotent no-op: exit 0, and crucially no network write
  }
  await publishProfile(newProfile(handle, entries, extras));
  // removed.* comes off the wire (unlike runSet's echo of the user's own argv) — sanitize it.
  if (target.kind === "curated") {
    console.log(`Removed ${KEY_LABELS[target.key]} (was "${sanitizeValue(removed.value)}").`);
  } else {
    console.log(
      `Removed extra "${sanitizeValue(removed.label)}" (was "${sanitizeValue(removed.value)}").`,
    );
  }
}

/** `ymmv delete` — confirm, then hard-delete server-side + drop the now-revoked local token. */
export async function runDelete(io: InteractiveIO): Promise<void> {
  const cred = await ensureLogin();
  const target = cred.handle ? `ymmv.fyi/${cred.handle}` : "your profile";

  // Destructive: require explicit consent. Interactive → confirm prompt; non-interactive (pipe / CI
  // / no TTY) → REFUSE unless -y was passed. Never hard-delete a profile with neither a prompt nor an
  // explicit flag (the asymmetry with publish is deliberate — publish is an idempotent upsert).
  if (!io.yes) {
    if (!io.interactive || !io.prompter) {
      console.error(
        `Refusing to delete ${target} without confirmation. Re-run with -y to confirm: ymmv delete -y`,
      );
      process.exitCode = 1;
      return;
    }
    const go = await io.prompter.confirm(`Delete ${target}? This is permanent`, false);
    if (!go) {
      console.log("Cancelled — nothing deleted.");
      return;
    }
  }
  await deleteProfile();
  await deleteToken(); // the server revoked every token for this account; drop the dead local one
  console.log(`Deleted ${target}. Run \`ymmv\` to publish again.`);
}
