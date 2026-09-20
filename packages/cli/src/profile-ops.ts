import {
  CURATED_KEYS,
  type CuratedKey,
  canonical,
  type Entry,
  type Extra,
  isCuratedKey,
  type Profile,
} from "@ymmv/shared";
import { shownValue } from "./render.js";
import type { SetTarget, UnsetTarget } from "./resolve.js";

// Pure profile transforms shared by the write commands (publish/set/unset). No IO — given the
// current profile (or null) and an input, they return the next entries/extras. Kept separate so
// the merge rules are unit-testable without touching the network or a prompt.

/**
 * Per-key defaults for the publish edit prompt. An existing published value wins over a fresh
 * detection (never clobber a deliberate choice on republish); detection only fills the gaps.
 * What it silently won over is surfaced by detectionDisagreements, so the card can mark the row
 * and the confirm can offer `d` to take the detection.
 */
export function buildDefaults(
  existing: Profile | null,
  detected: Map<CuratedKey, string>,
): Map<CuratedKey, string> {
  const existingByKey = new Map<CuratedKey, string>(
    (existing?.entries ?? []).map((e) => [e.key, e.value]),
  );
  const out = new Map<CuratedKey, string>();
  for (const key of CURATED_KEYS) {
    const value = existingByKey.get(key) ?? detected.get(key);
    if (value?.trim()) out.set(key, value.trim());
  }
  return out;
}

/**
 * Keys whose current answer names a different tool than a fresh detection, with the detected
 * value as the card shows it: the complement of buildDefaults, which lets the saved value win
 * silently. Compared on the SHOWN form (sanitized, trimmed, then canonical), so same-tool
 * spellings (`vim`/`Vim`, `vscode`/`VS Code`) and invisible-character differences are not
 * disagreements, and the value returned is the one `d` may store — what you saw is what you
 * accept. A key only one side has is not a disagreement either (a gap was already filled by
 * buildDefaults; a clear stands), nor is a key in `decided`: one the user typed, cleared, took, or
 * kept in a walk this session. Rule-agnostic on purpose: the write rules live in commands.ts.
 */
export function detectionDisagreements(
  values: ReadonlyMap<CuratedKey, string>,
  detected: ReadonlyMap<CuratedKey, string>,
  decided: ReadonlySet<CuratedKey> = new Set(),
): Map<CuratedKey, string> {
  const out = new Map<CuratedKey, string>();
  for (const key of CURATED_KEYS) {
    const current = values.get(key);
    const fresh = detected.get(key);
    if (current === undefined || fresh === undefined || decided.has(key)) continue;
    const take = shownValue(fresh);
    if (take && canonical(key, shownValue(current)) !== canonical(key, take)) out.set(key, take);
  }
  return out;
}

/** A curated-key map → ordered Entry[] (canonical CURATED_KEYS order, empty keys dropped). */
export function entriesFromMap(map: Map<CuratedKey, string>): Entry[] {
  return CURATED_KEYS.flatMap((key) => {
    const value = map.get(key);
    return value ? [{ key, value }] : [];
  });
}

/**
 * Entries whose keys this CLI build doesn't recognize — set by a NEWER client/server taxonomy.
 * Bare publish is a full replace built from the compiled-in CURATED_KEYS, so without carrying
 * these through verbatim, an older CLI would silently delete a newer field on republish. They can
 * only ever originate from the server (reads return server-curated keys), so re-POSTing them is
 * always accepted. Never prompted, never defaulted — just preserved.
 */
export function unknownEntries(existing: Profile | null): Entry[] {
  return (existing?.entries ?? []).filter((e) => !isCuratedKey(e.key));
}

/**
 * Apply one `set` change to a profile, returning fresh entries/extras (never mutates the input).
 * Curated keys upsert by key; extras upsert by trimmed, case-insensitive label (the server trims
 * labels at the write boundary now, but rows stored before that fix — or by foreign clients
 * predating it — may still be padded, so the padded label must still match; the upsert then
 * replaces it with the clean one).
 */
export function applySet(
  existing: Profile | null,
  target: SetTarget,
): { entries: Entry[]; extras: Extra[] } {
  const entries: Entry[] = (existing?.entries ?? []).map((e) => ({ ...e }));
  const extras: Extra[] = (existing?.extras ?? []).map((x) => ({ ...x }));

  if (target.kind === "curated") {
    const i = entries.findIndex((e) => e.key === target.key);
    const next: Entry = { key: target.key, value: target.value };
    if (i >= 0) entries[i] = next;
    else entries.push(next);
  } else {
    const wanted = target.label.trim().toLowerCase();
    const i = extras.findIndex((x) => x.label.trim().toLowerCase() === wanted);
    const next: Extra = { label: target.label, value: target.value };
    if (i >= 0) extras[i] = next;
    else extras.push(next);
  }
  return { entries, extras };
}

/**
 * Apply one `unset` to a profile, returning fresh entries/extras (never mutates the input) plus
 * what was removed — `removed: null` means nothing matched and the caller must skip the republish.
 * `removed.label` is raw stored data (the curated key / the extra's stored casing); display
 * formatting is the caller's job. Extras drop EVERY trimmed, case-insensitive label match: the
 * server trims labels on write but never lowercases them and enforces no uniqueness, so stored
 * data can hold "Keyboard" and "keyboard" together (plus " Keyboard " on rows written before the
 * write path trimmed) — first-match-only (or exact-match-only) would leave a visible ghost behind
 * a success (or lying no-op) message.
 */
export function applyUnset(
  existing: Profile,
  target: UnsetTarget,
): { entries: Entry[]; extras: Extra[]; removed: { label: string; value: string } | null } {
  const entries: Entry[] = existing.entries.map((e) => ({ ...e }));
  const extras: Extra[] = existing.extras.map((x) => ({ ...x }));

  if (target.kind === "curated") {
    const hit = entries.find((e) => e.key === target.key);
    if (!hit) return { entries, extras, removed: null };
    return {
      entries: entries.filter((e) => e.key !== target.key),
      extras,
      removed: { label: hit.key, value: hit.value },
    };
  }
  const wanted = target.label.trim().toLowerCase();
  const hit = extras.find((x) => x.label.trim().toLowerCase() === wanted);
  if (!hit) return { entries, extras, removed: null };
  return {
    entries,
    extras: extras.filter((x) => x.label.trim().toLowerCase() !== wanted),
    removed: { label: hit.label, value: hit.value },
  };
}
