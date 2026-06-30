/**
 * The public API contract — the shape the CLI and the web render consume, and the JSON
 * returned by `GET /api/v1/u/<handle>`. Documented so external integrators can build on it.
 *
 * SECURITY: every string here (`value`, `label`, `handle`, ...) is USER-CONTROLLED and
 * UNTRUSTED. `@ymmv/shared` never sanitizes — each surface sanitizes at its own boundary
 * (the web render HTML-escapes; the CLI strips/escapes ANSI). Do not treat these as safe
 * domain data.
 */

import type { CuratedKey } from "./keys.js";

/** Profile payload contract version — the wire/JSON contract version, not a DB-schema version. */
export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

/** A single curated key/value pair. */
export interface Entry {
  key: CuratedKey;
  value: string;
}

/** A free-form "extra" — pure expression, no schema, never diffed. */
export interface Extra {
  label: string;
  value: string;
}

/** A published profile, as returned by the public read endpoint. */
export interface Profile {
  schema_version: SchemaVersion;
  handle: string;
  entries: Entry[];
  extras: Extra[];
  updated_at: string;
}

/** Per-row diff outcome for a curated key. */
export type DiffStatus = "same" | "changed" | "only_mine" | "only_theirs";

/** One row of a diff — a curated key compared across two profiles. */
export interface DiffRow {
  key: CuratedKey;
  label: string;
  mine: string | null;
  theirs: string | null;
  status: DiffStatus;
}

/** Extras don't diff (free labels) — rendered as separate blocks, carried verbatim. */
export interface ExtraDiff {
  mine: Extra[];
  theirs: Extra[];
}

/** The full result of `diff()`. Invariant: `differ + shared === rows.length`. */
export interface DiffResult {
  rows: DiffRow[];
  extras: ExtraDiff;
  differ: number;
  shared: number;
}
