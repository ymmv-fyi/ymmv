/**
 * GitHub OAuth app identity shared by the CLI (device flow) and the Worker (token introspection).
 *
 * This is the PUBLIC client id of the "ymmv" GitHub OAuth app — safe to commit (device flow is a
 * public-client flow with no secret on the client side). It is the single source of truth so the
 * CLI's device-flow requests and the Worker's introspection call
 * (`POST /applications/{client_id}/token`) always target the SAME app; a mismatch would make every
 * login fail. The paired client SECRET is never here — it lives only as the Worker's runtime
 * `GITHUB_CLIENT_SECRET` (set via `wrangler secret put`), never committed.
 */
export const GITHUB_CLIENT_ID = "Ov23liMoD29eizQcN1KZ";
