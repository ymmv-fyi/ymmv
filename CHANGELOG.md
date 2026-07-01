# Changelog

Notable changes to **ymmv** (the `ymmv-cli` package + the ymmv.fyi Worker), newest first.

## [0.1.5] - 2026-06-30

### Security
- **The `ymmv` credential directory is now created private (0700).** The saved token file was already
  owner-only (0600), but the enclosing `~/.config/ymmv` directory was world-traversable, so another
  local user could see that a ymmv credential existed. It's now locked to your user, and an older
  directory left more open is tightened on the next save. POSIX only — Windows relies on your per-user
  profile permissions.
- **External links on a profile page no longer leak the referring URL.** Links to your published
  dotfiles/other URLs now carry `rel="noreferrer"`, so the destination site no longer receives which
  ymmv.fyi page the visitor came from. (Reverse-tabnabbing was already blocked by `noopener`.)
- **Sign-in and sign-out no longer follow HTTP redirects.** A redirect can't trick the CLI into
  re-sending your GitHub token to another location or reading a redirect as a successful sign-out.
  Hardening only — the production service doesn't redirect these requests.

### Fixed
- **A brief GitHub hiccup during sign-in no longer aborts the whole login.** If GitHub returned a
  transient error while the CLI was waiting for you to authorize the device code, login used to fail
  outright; it now keeps polling through the blip. A sustained outage or a blocking proxy fails fast
  with a clear message instead of hanging until the code expires.
- **The CLI validates profile data it fetches.** A malformed response (e.g. from a custom `YMMV_API`
  endpoint) now fails with a clear error instead of crashing partway through a diff.

## [0.1.4] - 2026-06-30

### Security
- **Sign-in now verifies your GitHub token was actually issued to ymmv.** The device-flow sign-in
  endpoint used to trust any valid GitHub access token's identity — so a token leaked, or phished for a
  *different* OAuth app, could be used to mint a ymmv session for that account. Sign-in now verifies each
  token belongs to ymmv's own GitHub app (token introspection) and rejects foreign or invalid tokens.
  Signing in through the `ymmv` CLI is unchanged.
- **Sign-in is rate-limited.** The mint endpoint now caps requests per identity and per client IP, so it
  can't be hammered to inflate the database or amplify calls to GitHub. The CLI shows a clear "too many
  login attempts — try again shortly."

### Notes
- Residual (unchanged): a token obtained by phishing a victim into authorizing ymmv's *own* app still
  validates — this is inherent to the GitHub device flow and out of scope for this change.

## [0.1.3] - 2026-06-30

### Fixed
- **Reclaiming a recycled GitHub username locked the new owner out of publishing.** After GitHub
  freed a username a prior ymmv user had renamed away from, the new owner could sign in but every
  `ymmv set` returned "handle taken" and `ymmv.fyi/<handle>` kept redirecting to the previous owner.
  A GitHub-proven sign-in now clears the stale ownership record, so the rightful owner publishes
  immediately.

## [0.1.2] - 2026-06-29

### Fixed
- **`ymmv delete` and `ymmv logout` 403'd.** The Worker's CSRF check blocked the CLI; disabled it
  (bearer-token API, no CSRF surface). Publish and sign-in were unaffected.

## [0.1.1] - 2026-06-29

### Fixed
- **`ymmv` did nothing on Linux, macOS, and WSL.** A global install (`npm i -g ymmv-cli`) and
  `npx ymmv-cli` install the binary as a symlink, which tripped a faulty "am I being run directly?"
  check and made the command exit silently. It now runs no matter how it's installed or invoked.
  Windows was unaffected.

## [0.1.0] - 2026-06-29

### Added
- **`ymmv-cli`** — the command-line tool. `ymmv` detects and publishes your stack; `ymmv <handle>`
  views anyone's, and diffs it against yours when you're logged in; plus `set`, `delete`, `view`,
  `login`, and `logout`. Honors `NO_COLOR`. Published to npm with build provenance and bundled
  self-contained, so `npx ymmv-cli` needs nothing installed.
- **Profile page** — a typography-led page at `ymmv.fyi/<handle>` in light and dark, with a
  side-by-side diff at `ymmv.fyi/<handle>/vs/<viewer>`.
- **Open JSON API** — every profile is data too: `GET /api/v1/u/<handle>`, versioned (each payload
  carries a `schema_version`) so integrations don't break.
- **GitHub sign-in** — passwordless device flow. Tokens are revocable and tied to your GitHub
  account; `logout` revokes them server-side.
- **Rate limiting** — a per-identity cap on writes, plus an edge rule that sheds high-volume traffic
  before it reaches the Worker.
- **CI/CD** — every PR is linted, type-checked, and tested (unit + browser e2e); tagging a release
  publishes the CLI with provenance and deploys the site per environment, after a staging dry-run.

[0.1.5]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.5
[0.1.4]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.4
[0.1.3]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.3
[0.1.2]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.2
[0.1.1]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.1
[0.1.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.0
