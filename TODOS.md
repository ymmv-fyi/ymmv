# TODOS

## Web

### Full bidi/Trojan-source sanitizer for web surfaces
**Priority:** P3
The CLI strips bidi controls (U+202A–202E, U+2066–2069, LRM/RLM) from every untrusted value;
the web only isolates the diff-extras line (`<bdi>`) and the empty-state handle. A shared
sanitizer applied at render time would close the remaining within-value spoofing gap on all
web text surfaces.

### `=`-containing extras labels are unaddressable by `ymmv unset --extra`
**Priority:** P4
The write path now trims extras labels/values and rejects empty ones, so padded and blank labels
are gone. A label containing `=` is still storable via curl and still cannot be targeted by
`ymmv unset --extra` (parse-level: `=` splits label from value and is rejected with a hint). Either
reject `=` in labels at the write boundary, or give the CLI an escape syntax. Surfaced by the
`ymmv unset` pre-landing review (2026-07-01, cross-model); narrowed once trim+empty-rejection shipped.

### `/404` carries no cache-control header
**Priority:** P4
`profile-read.ts:117` states every response carries an explicit edge policy, but `/404` is served
by the static `404.astro`, which sits off the shared resolver path and sets no `cache-control` —
unlike a `[handle]` not-found, which gets `readCacheControl("notfound")`. Cosmetic while nothing
edge-caches Worker responses; fix alongside "Uncached read path for RMW mutations". Surfaced by the
reserved-handle eng review outside voice (2026-07-09).

### og:image share card
**Priority:** P3
No `og:image` anywhere — profile/diff links preview as text-only cards. Needs either a static
brand card in `/public` or generation infra (satori/resvg on Workers). Deferred from the
design-polish plan (2026-07-01).

## CLI

### Harden displayUrl display-shortening on both surfaces (web + CLI)
**Priority:** P4
`displayUrl()` strips only a leading `https://` for display (web `display-value.ts:6-16`, CLI
`render.ts` — deliberate copy). URL-parse-based display decisions would close the userinfo
spoofing niche (`https://good.com@evil.com` displays as `good.com@evil.com`) and punycode
lookalikes. Threat is a self-published URL on the attacker's own profile — low value, but both
surfaces should change together (candidate for one shared helper in `@ymmv/shared`). Constraint:
`display-shortening-must-not-collide-compared-values` (never shorten diff-compared cells into
collision). Surfaced by the CLI-restyle eng review outside voice (2026-07-02).

### Uncached read path for RMW mutations
**Priority:** P4
`publish`/`set`/`unset` read the current profile via the public `GET /api/v1/u/<handle>`, whose
responses declare `s-maxage=30, stale-while-revalidate=86400` (`profile-read.ts:120-124`). Nothing
edge-caches Worker responses today, so reads are fresh — but a future cache rule on `/api/v1/u/*`
would make rapid consecutive mutations read stale state, and the full-replace publish would then
silently drop writes made moments earlier. The same clobber also occurs with no cache at all when
two writers race (`set`/`unset` in two terminals — both read fresh, last POST resurrects the key
the first removed). One server-side fix covers both: an `If-Match`/`updated_at` precondition on
the POST (plus an authed own-profile read or cache-rule exclusion for the staleness case) — not a
client `no-cache` header Cloudflare would ignore. See the invariant comment on `fetchProfileJson`
(`packages/cli/src/api.ts`). Surfaced by the `ymmv unset` eng review (2026-07-01, cross-model).
The interactive publish retry loop (2026-07-19) widens this window: a failed POST re-offers `y`
against the pre-loop read, so a concurrent write during the user's wait at the confirm step is
replayed over. The loop's copy stays honest about ambiguity (lost responses say "may not have
completed"), but the real fix remains the same server-side precondition.

### Compare auth-retry identity by account id, not handle
**Priority:** P3
The 401/409 reauth guard (`packages/cli/src/api.ts`) refuses a retry when the re-minted handle
differs — but it cannot see identity behind an IDENTICAL handle (rename + squat: the handle's
current owner authorizes the device flow, handle string matches, the pre-reauth merge publishes).
Residual accepted at ship (2026-07-02, Codex P1): the actor must interactively approve a device
flow from the victim's own terminal session. Real fix is cross-package: mint response
(`/api/v1/auth/token`) gains a stable `github_id`, `MintResult` in `@ymmv/shared` carries it, the
CLI compares id instead of handle. Wire-format addition — additive, but touches Worker + shared +
CLI together.

### CLI visible-content pre-check for zero-width-only values
**Priority:** P4
`promptEntries`/`parseSet` length-check input locally, but a value made only of invisible
characters (U+200B etc.) survives `.trim()` and round-trips to the server just to be refused
with `invalid_value` — the last pre-flightable 422. The invisible-char class already exists as
`INVISIBLE_RE` in `packages/cli/src/http.ts` and server-side as `hasVisibleContent`
(`api/v1/profile.ts`); cleanest after a shared visibility helper lives in `@ymmv/shared` so all
three surfaces stop drifting. UX-only (the interactive loop now survives the 422). Surfaced by
the publish-resilience eng review outside voice (2026-07-18).

## Tooling

### e2e stale-server detection
**Priority:** P4
`reuseExistingServer` on :8788 can serve a stale build/seed with nothing telling the developer
(only a config comment). Also: an orphaned workerd process can hold `.wrangler/state` locked
(EPERM on cleanup) with the port free. Consider a seed canary asserted in global-setup, or
keying reuse on a hash of dist+seed.sql.
