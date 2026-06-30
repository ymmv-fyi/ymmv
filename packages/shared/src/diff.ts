/**
 * The diff engine — the soul of ymmv. Compares two profiles across the curated keys.
 *
 * Pure, deterministic, render-agnostic: it returns structured data, and each surface
 * (CLI ANSI, web 3-column) renders it. It does NOT sanitize — values come back raw and
 * UNTRUSTED (see `Profile`); sanitize at render.
 *
 *     diff(mine, theirs)   // mine = the viewer ("you"); theirs = the profile being viewed
 *
 * Rules:
 *  - Iterate CURATED_KEYS in canonical order → deterministic row order, independent of input.
 *  - A row exists for every key present on EITHER side; keys absent on both → no row.
 *  - Equality compares TRIMMED values (whitespace-insensitive); values are returned
 *    verbatim and case stays significant ("Code" ≠ "code").
 *  - Duplicate keys in `entries` resolve LAST-WINS (Map insertion semantics).
 *  - Non-curated keys in `entries` are IGNORED (never a row) — the API rejects them on
 *    write, so this is purely defensive against malformed input.
 *  - extras never diff: both sides are carried through unchanged for separate-block render.
 *
 *     mine.entries ──┐                              ┌── rows[] (CURATED_KEYS order)
 *                    ├─► build lookups ─► compare ──┤
 *     theirs.entries─┘                              └── differ / shared counts
 *                                  extras ─────────────► carried verbatim (unmatched)
 */

import type { CuratedKey } from "./keys.js";
import { CURATED_KEYS, KEY_LABELS } from "./keys.js";
import type { DiffResult, DiffRow, DiffStatus, Profile } from "./types.js";

/** Curated-key → value lookup; last-wins on duplicate keys, non-curated keys ignored on read. */
function toLookup(entries: Profile["entries"]): Map<CuratedKey, string> {
  const map = new Map<CuratedKey, string>();
  for (const entry of entries) {
    // Re-setting an existing key is last-wins by construction. A non-curated key may sneak
    // in via malformed input; it lands in the map but is never read (we only iterate
    // CURATED_KEYS below), so it can never become a row.
    map.set(entry.key, entry.value);
  }
  return map;
}

function classify(mine: string | null, theirs: string | null): DiffStatus {
  if (mine !== null && theirs !== null) {
    return mine.trim() === theirs.trim() ? "same" : "changed";
  }
  return mine !== null ? "only_mine" : "only_theirs";
}

export function diff(mine: Profile, theirs: Profile): DiffResult {
  const mineLookup = toLookup(mine.entries);
  const theirsLookup = toLookup(theirs.entries);

  const rows: DiffRow[] = [];
  let differ = 0;
  let shared = 0;

  for (const key of CURATED_KEYS) {
    const mineValue = mineLookup.get(key) ?? null;
    const theirsValue = theirsLookup.get(key) ?? null;
    if (mineValue === null && theirsValue === null) {
      continue;
    }

    const status = classify(mineValue, theirsValue);
    if (status === "same") {
      shared += 1;
    } else {
      differ += 1;
    }

    rows.push({ key, label: KEY_LABELS[key], mine: mineValue, theirs: theirsValue, status });
  }

  return {
    rows,
    extras: { mine: [...mine.extras], theirs: [...theirs.extras] },
    differ,
    shared,
  };
}
