// Worker API base. Defaults to production (ymmv.fyi); `YMMV_API` overrides it (set to
// http://localhost:4321 for the local astro-dev loop, a `wrangler dev` URL, or the staging
// workers.dev URL). Trailing slashes are stripped so `${BASE}/api/...` never double-slashes.
// YMMV_API must be a bare origin (no path prefix): the Worker's rename 301 sends a root-absolute
// Location, so a path-mounted base would lose its prefix on the redirect.
export const BASE = (process.env.YMMV_API ?? "https://ymmv.fyi").replace(/\/+$/, "");
