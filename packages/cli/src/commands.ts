import {
  CURATED_KEYS,
  type CuratedKey,
  diff,
  type Entry,
  KEY_LABELS,
  type Profile,
  SCHEMA_VERSION,
} from "@ymmv/shared";
import { deleteProfile, ensureLogin, fetchProfileJson, publishProfile } from "./api.js";
import { detectStack } from "./detect.js";
import { applySet, buildDefaults, entriesFromMap } from "./profile-ops.js";
import type { Prompter } from "./prompt.js";
import { notFound, nudge, renderDiff, renderProfile, useColor } from "./render.js";
import type { SetTarget } from "./resolve.js";
import { deleteToken, loadToken, type StoredToken } from "./token-store.js";

// The command layer: orchestrates the pure pieces (detect/diff/render/merge) with the network +
// token store. Each command keeps its IO at the edges so the branching logic stays testable.

export interface InteractiveIO {
  interactive: boolean;
  prompter?: Prompter;
  yes: boolean;
}

function colorEnabled(): boolean {
  return useColor(process.env, Boolean(process.stdout.isTTY));
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
  const cred = await ensureLogin();
  const handle = requireHandle(cred);
  if (!handle) return;

  const detected = detectStack(process.env, process.platform);
  // NOT caught: fetchProfileJson returns null only on a 404 (no profile yet) and THROWS on a real
  // read failure. Swallowing the throw would let a transient error look like "no profile", and the
  // upsert (server does delete-then-insert) would then clobber every curated key + extra. Abort.
  const existing = await fetchProfileJson(handle);
  const defaults = buildDefaults(existing, detected);

  let entries = entriesFromMap(defaults);
  const extras = existing?.extras ?? [];
  if (io.interactive && io.prompter) {
    entries = await promptEntries(defaults, io.prompter);
  }

  const profile = newProfile(handle, entries, extras);
  console.log(renderProfile(profile, { color: colorEnabled() }));

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
    console.log(notFound(handle));
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
  const { entries, extras } = applySet(existing, target);
  await publishProfile(newProfile(handle, entries, extras));
  if (target.kind === "curated") {
    console.log(`Set ${KEY_LABELS[target.key]} = ${target.value}.`);
  } else {
    console.log(`Set extra ${target.label} = ${target.value}.`);
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
