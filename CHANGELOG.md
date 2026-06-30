# Changelog

Notable changes to **ymmv** (the `ymmv-cli` package + the ymmv.fyi Worker), newest first.

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

[0.1.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.0
