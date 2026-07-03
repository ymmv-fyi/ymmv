# TODOS

## Web

### Theme resync after BFCache restore / cross-tab toggle
**Priority:** P3
Theme state (data-theme, aria-pressed, theme-color meta) syncs only at script evaluation. A
back-forward-cache restore or a toggle in another same-origin tab leaves the restored page stale
until the next full load. Add `pageshow` (persisted) + `storage` (ymmv-theme) listeners that
re-apply all three. Noticed on branch web-design-polish (red-team review).

### InstallCommand is a dead button without JS
**Priority:** P3
The click-to-copy command renders as a focusable `<button aria-label="Copy install command…">`
even when the wiring script never runs (JS off, no Clipboard API) — AT users reach a control that
promises copying and does nothing. Progressive upgrade: render as `<span>`, promote to button when
`[data-copy-ready]` wires. Pre-existing; surfaced when the button was added to every profile foot.

### Full bidi/Trojan-source sanitizer for web surfaces
**Priority:** P3
The CLI strips bidi controls (U+202A–202E, U+2066–2069, LRM/RLM) from every untrusted value;
the web only isolates the diff-extras line (`<bdi>`) and the empty-state handle. A shared
sanitizer applied at render time would close the remaining within-value spoofing gap on all
web text surfaces.

### Validate extras labels on the write path
**Priority:** P4
`POST /api/v1/profile` stores extras labels verbatim (`profile.ts:92-98`) — only type + length are
checked, so empty, whitespace-only/padded, and `=`-containing labels are all storable. The CLI now
tolerates padded labels (trimmed matchers in `profile-ops.ts`), but `=`-containing and empty
labels remain unaddressable by `ymmv unset --extra` (parse-level: `=` is rejected with a hint,
empty is a usage error). Root-cause fix: trim labels and reject degenerate ones (empty after trim)
at the write boundary. Surfaced by the `ymmv unset` pre-landing review (2026-07-01, cross-model).

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

### Default request timeout on CLI fetches
**Priority:** P4
No CLI fetch sets a timeout — a dead-but-open connection (hung proxy, packet loss after SYN)
hangs any command forever with no output. After the restyle, `safeFetch` (`packages/cli/src/
http.ts`) is the single choke point: `init.signal ??= AbortSignal.timeout(30_000)` plus a
poll-aware exception for the GitHub device flow (its long-poll pacing must not be cut short) is
the whole change, and the failure then routes through the existing can't-reach message. Surfaced
by the CLI-restyle eng review test trace (2026-07-02).

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

## Tooling

### e2e stale-server detection
**Priority:** P4
`reuseExistingServer` on :8788 can serve a stale build/seed with nothing telling the developer
(only a config comment). Also: an orphaned workerd process can hold `.wrangler/state` locked
(EPERM on cleanup) with the port free. Consider a seed canary asserted in global-setup, or
keying reuse on a hash of dist+seed.sql.

## Completed

### publishProfile 401-retry can rebind a different account mid-RMW
**Done 2026-07-02** (branch `cli-restyle`). Both auth-retry paths now refuse a rebound handle:
401 and 409 alike throw instead of retrying the pre-reauth merge (a fresh run re-reads under the
current handle). Tests pin both refusals (no second POST). Residual same-handle/different-identity
case tracked under "Compare auth-retry identity by account id".
