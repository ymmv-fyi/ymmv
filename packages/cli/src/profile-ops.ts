import { CURATED_KEYS, type CuratedKey, type Entry, type Extra, type Profile } from "@ymmv/shared";
import type { SetTarget } from "./resolve.js";

// Pure profile transforms shared by the publish + set commands. No IO — given the current profile
// (or null) and an input, they return the next entries/extras. Kept separate so the merge rules are
// unit-testable without touching the network or a prompt.

/**
 * Per-key defaults for the publish edit prompt. An existing published value wins over a fresh
 * detection (never clobber a deliberate choice on republish); detection only fills the gaps.
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

/** A curated-key map → ordered Entry[] (canonical CURATED_KEYS order, empty keys dropped). */
export function entriesFromMap(map: Map<CuratedKey, string>): Entry[] {
  return CURATED_KEYS.flatMap((key) => {
    const value = map.get(key);
    return value ? [{ key, value }] : [];
  });
}

/**
 * Apply one `set` change to a profile, returning fresh entries/extras (never mutates the input).
 * Curated keys upsert by key; extras upsert by case-insensitive label.
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
    const i = extras.findIndex((x) => x.label.toLowerCase() === target.label.toLowerCase());
    const next: Extra = { label: target.label, value: target.value };
    if (i >= 0) extras[i] = next;
    else extras.push(next);
  }
  return { entries, extras };
}
