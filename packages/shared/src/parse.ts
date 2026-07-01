/**
 * Runtime guard for the Profile wire contract.
 *
 * The first-party API (`GET /api/v1/u/<handle>`) always returns a conforming Profile, but the CLI can
 * be pointed at a non-conforming origin (the documented `YMMV_API` override, a TLS-MITM, or a future
 * integrator embedding this package). Without a guard, a malformed body flows through `fetchProfileJson`'s
 * bare `as Profile` cast straight into `diff()` / `buildDefaults`, where `for (const entry of entries)`
 * on a non-array (e.g. `entries: null`) throws an opaque TypeError from deep inside `diff()` — caught
 * only by the CLI's top-level handler as a confusing stack rather than a clear message.
 *
 * `parseProfile` converts that into a typed `ProfileParseError` at the fetch boundary. It is
 * ADDITIVE to the wire contract — no SCHEMA_VERSION bump — and is the single validated entry the CLI
 * consumes (the web SSR path reconstructs Profiles from D1 and defends separately via parseExtras/
 * orderEntries).
 */

import type { Entry, Extra, Profile } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

// Defensive READ-side ceilings — deliberately NOT the product WRITE caps (MAX_ENTRIES=50, MAX_VALUE=256,
// … live in the web write handler `api/v1/profile.ts` and reject on POST). These are generous and
// decoupled on purpose: a future write-cap increase must never make the CLI reject a legit first-party
// profile. Their only job is to stop a hostile/buggy origin from feeding the CLI pathological unbounded
// input that the terminal ANSI/bidi sanitizer would then scan.
const MAX_PARSE_ENTRIES = 256;
const MAX_PARSE_EXTRAS = 256;
const MAX_PARSE_VALUE = 4096;
const MAX_PARSE_LABEL = 4096;

/** Thrown by `parseProfile` when an untrusted value doesn't match the Profile wire contract. */
export class ProfileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileParseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validate an untrusted value (a fetched JSON body) against the Profile contract, returning a typed
 * `Profile` or throwing `ProfileParseError`. A non-curated `key` is preserved verbatim (the wire
 * contract is `{string,string}`; `diff()`/`orderEntries` only ever read CURATED_KEYS, so a stray key
 * is inert) — this guard checks SHAPE, not the curated taxonomy.
 */
export function parseProfile(raw: unknown): Profile {
  if (!isRecord(raw)) throw new ProfileParseError("profile is not an object");
  if (raw.schema_version !== SCHEMA_VERSION) {
    throw new ProfileParseError(`unsupported schema_version: ${String(raw.schema_version)}`);
  }
  if (typeof raw.handle !== "string") throw new ProfileParseError("handle is not a string");
  if (typeof raw.updated_at !== "string") throw new ProfileParseError("updated_at is not a string");

  if (!Array.isArray(raw.entries)) throw new ProfileParseError("entries is not an array");
  if (raw.entries.length > MAX_PARSE_ENTRIES) {
    throw new ProfileParseError(`too many entries (>${MAX_PARSE_ENTRIES})`);
  }
  // Index loop, not `.map`: `.map` skips holes in a sparse array, which would let a hand-built
  // `[ <hole> ]` slip past per-element validation. JSON.parse can't produce holes, but this is an
  // exported guard, so keep it sound for a direct caller.
  const entries: Entry[] = [];
  for (let i = 0; i < raw.entries.length; i++) {
    const entry = raw.entries[i];
    if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.value !== "string") {
      throw new ProfileParseError(`entry ${i} is not {key,value} strings`);
    }
    if (entry.value.length > MAX_PARSE_VALUE) {
      throw new ProfileParseError(`entry ${i} value exceeds ${MAX_PARSE_VALUE} chars`);
    }
    entries.push({ key: entry.key as Entry["key"], value: entry.value });
  }

  if (!Array.isArray(raw.extras)) throw new ProfileParseError("extras is not an array");
  if (raw.extras.length > MAX_PARSE_EXTRAS) {
    throw new ProfileParseError(`too many extras (>${MAX_PARSE_EXTRAS})`);
  }
  const extras: Extra[] = [];
  for (let i = 0; i < raw.extras.length; i++) {
    const extra = raw.extras[i];
    if (!isRecord(extra) || typeof extra.label !== "string" || typeof extra.value !== "string") {
      throw new ProfileParseError(`extra ${i} is not {label,value} strings`);
    }
    if (extra.label.length > MAX_PARSE_LABEL || extra.value.length > MAX_PARSE_VALUE) {
      throw new ProfileParseError(`extra ${i} exceeds the length ceiling`);
    }
    extras.push({ label: extra.label, value: extra.value });
  }

  return {
    schema_version: SCHEMA_VERSION,
    handle: raw.handle,
    entries,
    extras,
    updated_at: raw.updated_at,
  };
}
