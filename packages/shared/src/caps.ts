/**
 * Product WRITE caps for a profile — enforced by the web write handler (`api/v1/profile.ts`)
 * and pre-flighted by the CLI before any network call. Validation constants, NOT wire format:
 * changing one is not a SCHEMA_VERSION event. Distinct from parse.ts's private MAX_PARSE_*
 * read-side ceilings, which are deliberately more generous (see the comment there).
 *
 * RAISING a cap is a soft-breaking event for shipped CLIs: every published binary pre-flights
 * the value bundled at its build and refuses locally — it never POSTs, so a more permissive
 * server can't reach it. Treat a cap raise like a feature release: stale installs keep
 * enforcing (and naming) the stale cap until upgraded. Lowering a cap only tightens the server;
 * old CLIs then fall back to the server's 422 message.
 *
 * `packages/cli/README.md` and the CHANGELOG name these numbers in prose — update them together
 * with any cap change (nothing fails automatically when the docs lag).
 */
export const MAX_ENTRIES = 50;
export const MAX_EXTRAS = 32;
export const MAX_LABEL = 64;
export const MAX_VALUE = 256;
