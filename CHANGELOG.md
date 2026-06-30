# Changelog

Notable changes to **ymmv** (the `ymmv-cli` package + the ymmv.fyi Worker), newest first.

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

[0.1.3]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.3
[0.1.2]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.2
[0.1.1]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.1
[0.1.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.0
