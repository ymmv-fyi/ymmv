/**
 * Value normalization for the diff — comparison ONLY. Reduces a raw value to a canonical
 * identity token so equality means "same tool," not "same text". Never mutates displayed
 * values (diff rows carry the raw strings; sanitize-at-render still owns untrusted input).
 *
 *     canonical(key, value)
 *        │
 *        ├─ dotfiles (URL/path) ─► value.trim()                 verbatim, case-sensitive
 *        └─ every other field  ─► fold(value) ─► ALIASES[key][folded] ?? folded
 *                                 case + NFC + strip-whitespace   curated per-field synonyms
 *
 * ALIASES is derived once from TOOLS: only `canonical` ∪ `aliases` become diff variants —
 * `envTokens` are detector heuristics, never diff aliases (so `vi` ≠ `Vim` at diff time).
 */
import type { CuratedKey } from "./keys.js";
import type { Tool } from "./tools.js";
import { TOOLS } from "./tools.js";

const WS = /\s+/g;

/**
 * Fold a value to a comparison token: case-lowered, NFC-normalized, whitespace-stripped.
 * Simple case-lowering + NFC (not full Unicode case-folding — unnecessary for tool names).
 * NFC runs AFTER `toLowerCase()` so any decomposition a lowercase mapping introduces recomposes,
 * keeping equal-looking values byte-equal.
 */
export function fold(value: string): string {
  return value.toLowerCase().normalize("NFC").replace(WS, "");
}

/**
 * Per-field alias map: fold(variant) → fold(canonical), for variants in {canonical} ∪ aliases.
 * Identity self-maps are skipped, so a canonical token is never itself a key (single-hop lookup).
 */
function buildAliases(tools: Tool[]): Partial<Record<CuratedKey, Record<string, string>>> {
  const out: Partial<Record<CuratedKey, Record<string, string>>> = {};
  for (const tool of tools) {
    const target = fold(tool.canonical);
    let bucket = out[tool.key];
    if (bucket === undefined) {
      bucket = {};
      out[tool.key] = bucket;
    }
    for (const variant of [tool.canonical, ...(tool.aliases ?? [])]) {
      const folded = fold(variant);
      if (folded === target) continue; // never map a token to itself
      bucket[folded] = target;
    }
  }
  return out;
}

const ALIASES = buildAliases(TOOLS);

/**
 * Free-form / URL fields compared verbatim (trim-only, case-sensitive) — never folded.
 * A dotfiles value is a repo URL/path where case, path segments, branch, and host are all
 * significant, so folding it would be a false-positive risk.
 */
const RAW_COMPARE_KEYS: ReadonlySet<CuratedKey> = new Set<CuratedKey>(["dotfiles"]);

/** Canonical identity token for comparing a curated field's value. */
export function canonical(key: CuratedKey, value: string): string {
  if (RAW_COMPARE_KEYS.has(key)) return value.trim();
  const folded = fold(value);
  // `value` is user-controlled, so a folded key of "__proto__"/"constructor" would read an
  // inherited member off the plain-object bucket (Object.prototype / the Object fn) rather than
  // a real alias. Accept the hit only when it's a string; otherwise fall through to `folded`.
  const hit = ALIASES[key]?.[folded];
  return typeof hit === "string" ? hit : folded;
}
