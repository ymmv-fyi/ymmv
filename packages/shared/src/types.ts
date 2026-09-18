/**
 * The public API contract — the shape the CLI and the web render consume, and the JSON
 * returned by `GET /api/v1/u/<handle>`. Documented so external integrators can build on it.
 * Also holds the CLI<->Worker auth contract (`MintResult`, `WhoamiResult`), so the two surfaces
 * compile against one shape instead of two hand-typed copies.
 *
 * SECURITY: every string here (`value`, `label`, `handle`, ...) is USER-CONTROLLED and
 * UNTRUSTED. `@ymmv/shared` never sanitizes — each surface sanitizes at its own boundary
 * (the web render HTML-escapes; the CLI strips/escapes ANSI). Do not treat these as safe
 * domain data. The one field that is NOT display data is `MintResult.token`: a bearer SECRET
 * the CLI stores 0600 and never logs, echoes, or prints.
 */

import type { CuratedKey } from "./keys.js";

/** Profile payload contract version — the wire/JSON contract version, not a DB-schema version. */
export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

/**
 * `GET /api/v1/auth/whoami` response: the identity a bearer token resolves to. `github_id` is the
 * stable GitHub account id; `handle` is the handle currently bound to it, or null when none is
 * (a reserved GitHub username, or a handle another account has since proven ownership of). Not
 * versioned by SCHEMA_VERSION — that governs the Profile payload only.
 */
export interface WhoamiResult {
  github_id: number;
  handle: string | null;
}

/**
 * `POST /api/v1/auth/token` (device-flow mint) response: the minted token plus the identity it is
 * bound to. The CLI stores `github_id` and compares it across a re-login, because a handle string
 * can change hands (rename + reclaim) while the id cannot. Not versioned by SCHEMA_VERSION.
 */
export interface MintResult extends WhoamiResult {
  token: string;
}

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
