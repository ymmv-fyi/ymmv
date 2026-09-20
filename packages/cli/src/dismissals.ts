import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CuratedKey, canonical, isCuratedKey, MAX_VALUE } from "@ymmv/shared";
import envPaths from "env-paths";
import { shownValue } from "./render.js";

// Detection marks the user answered "n" to in publish's per-key take, remembered across runs so a
// deliberate mismatch (a saved Zed with $EDITOR=nvim) stops being marked on every republish. A
// dismissal is the exact (key, saved value, detected value) the user was asked about: it hides
// that one question and nothing else, so a changed detection or a changed saved value is marked
// again. Entries are never pruned on a detection mismatch (the env-dependent keys flip between
// terminals, and a dismissal made in one must survive a run from another); the cap bounds growth.
// Unscoped by API base or handle on purpose: an entry only ever hides its own exact pair, and one
// file per scope would let a staging run overwrite production's.
// Accepted limit: a build that does not know a newer build's curated key drops that key's
// entries when it next records an "n". The cost is one mark shown again.

export interface Dismissal {
  key: CuratedKey;
  saved: string;
  detected: string;
}

/** Oldest entries drop first. Far above what one person's environments produce. */
const MAX_DISMISSALS = 64;
/** Above the largest file writeDismissals can produce: MAX_VALUE counts UTF-16 units, and one
 *  unit serializes to at most 6 bytes (a lone surrogate, escaped), so 64 entries of two full
 *  values stay under 200 KiB. A smaller bound would make a full non-ASCII history unreadable. */
const MAX_FILE_BYTES = 256 * 1024;

/** Sibling of token.json and update-check.json. */
export function dismissalsPath(): string {
  return join(envPaths("ymmv", { suffix: "" }).config, "dismissed-marks.json");
}

const sameTool = (key: CuratedKey, a: string, b: string): boolean =>
  canonical(key, shownValue(a)) === canonical(key, shownValue(b));

/** Whether this exact disagreement was dismissed. Compared like the marks themselves (shown form,
 *  then canonical), so respelling the saved value as the same tool does not bring the mark back. */
export function isDismissed(
  list: readonly Dismissal[],
  key: CuratedKey,
  saved: string,
  detected: string,
): boolean {
  return list.some(
    (d) => d.key === key && sameTool(key, d.saved, saved) && sameTool(key, d.detected, detected),
  );
}

function isDismissal(x: unknown): x is Dismissal {
  if (typeof x !== "object" || x === null) return false;
  const d = x as Partial<Record<keyof Dismissal, unknown>>;
  const text = (v: unknown): boolean => typeof v === "string" && v !== "" && v.length <= MAX_VALUE;
  return typeof d.key === "string" && isCuratedKey(d.key) && text(d.saved) && text(d.detected);
}

/** The file's entries. [] when there is nothing usable to keep (no file, unparseable, wrong shape;
 *  a malformed entry is dropped alone), and null when something is there that could not be read:
 *  a transient EBUSY/EPERM, or a file this refuses to open. Bounded like detection's os-release
 *  read: a FIFO would hang the publish and an oversized file would be parsed whole. */
async function load(path: string): Promise<Dismissal[] | null> {
  let text: string;
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    text = await readFile(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return [];
    const list = (parsed as { dismissed?: unknown }).dismissed;
    if (!Array.isArray(list)) return [];
    return list
      .filter(isDismissal)
      .map(({ key, saved, detected }) => ({ key, saved, detected }))
      .slice(-MAX_DISMISSALS);
  } catch {
    return [];
  }
}

/** Lenient read, same posture as the update cache: any failure is "none dismissed", so the worst
 *  a bad file can do is show a mark again. */
export async function readDismissals(path: string): Promise<Dismissal[]> {
  return (await load(path)) ?? [];
}

/** Record this run's new dismissals on top of what the file holds NOW, not what the run read at
 *  its start: another ymmv may have written, or reset, in between. A file that cannot be read is
 *  left alone rather than replaced by this run's few entries, which would erase a history the
 *  run never saw over one transient read error. */
export async function addDismissals(path: string, added: readonly Dismissal[]): Promise<void> {
  const current = await load(path);
  if (current !== null) await writeDismissals(path, [...current, ...added]);
}

/** Atomic like the update cache's write (unique temp + rename) and as best-effort: a read-only
 *  config dir must never break a publish. A failed write costs the memory, not the run, since the
 *  caller's in-memory list still hides the mark until the process exits. Private like token.json
 *  (0700 dir when this creates it, 0600 file): the entries are values the user declined to
 *  publish. Tightening a dir that already exists stays saveToken's job. */
export async function writeDismissals(path: string, list: readonly Dismissal[]): Promise<void> {
  const dismissed: Dismissal[] = [];
  for (const d of list) {
    if (!isDismissed(dismissed, d.key, d.saved, d.detected)) dismissed.push(d);
  }
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify({ dismissed: dismissed.slice(-MAX_DISMISSALS) }), {
      mode: 0o600,
    });
    await rename(tmp, path);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
