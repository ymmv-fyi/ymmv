# ymmv

What ymmv is: "Your Mileage May Vary" - terminal-native developer tool-stack
profiles. Publish your dev environment (editor/os/shell/prompt/terminal/
browser/wm/font/theme/multiplexer/version-manager/dotfiles/ai-tool) from a
CLI (npx ymmv-cli), get a page at ymmv.fyi/<handle>, and diff your stack
against anyone's. Stack: TypeScript CLI (npm/npx), Astro 7 web on Cloudflare
Workers + D1.

## Global rules (embed in every session)

- **Gates, in order:**
  - `pnpm lint` (biome ci)
  - `pnpm -r build` (**`@ymmv/shared` builds first - order matters**)
  - `pnpm typecheck` (web auto-runs `wrangler types` first)
  - `pnpm test` (vitest). Web/api → also `pnpm --filter @ymmv/web test:e2e` (Playwright).
- **Never run repo-wide `pnpm format`** (rewrites the whole tree). Scope Biome
  to touched files: `biome check --write <path>`.
- **Cross-package contract:** changing `@ymmv/shared` (esp. `types.ts` /
  `SCHEMA_VERSION`) ripples to **both** cli and web - update both surfaces
  together; bump `SCHEMA_VERSION` only when the **wire format** changes. Changes
  to the public JSON API response shape (`api/v1/u/[handle]`) are **breaking**
  for API consumers. `types.ts` also holds the CLI<->Worker auth contract
  (`MintResult`, `WhoamiResult`), which is **outside** `SCHEMA_VERSION`: the CLI
  refuses a mint or whoami reply missing a field, and every `YMMV_TOKEN` command
  needs `GET /api/v1/auth/whoami` to exist, so a change there deploys the Worker
  **before** the CLI tag (release.yml already orders it; never roll the Worker
  back behind a published CLI).
- **Flag every manual step explicitly:** Cloudflare Worker secrets/env, D1
  migrations (new file in `packages/web/migrations` + apply local for tests
  **and** prod on deploy), the `RL_WRITE`/`RL_AUTH` bindings, npm publish (tag-driven OIDC
  `release.yml`), DNS.
- **Versioning is tag-driven - NEVER bump a version.** There is no VERSION file,
  and all four `package.json`s are intentionally `0.0.0` (CI runs `npm pkg set
  version` from the `vX.Y.Z` tag at publish time, ephemerally on the runner).
  Record the change in a new `CHANGELOG.md` section; the number is set by the
  tag a maintainer pushes. **Creating a VERSION file or editing any
  `package.json` `version` is a bug** - leave them at `0.0.0`. (This is the one
  place the generic gstack `/ship` "bump VERSION" step does NOT apply to this
  repo.)
- **CHANGELOG is the CLI release log, not the web's.** `CHANGELOG.md` stages the
  tag-driven `ymmv-cli` train: the `[Unreleased]` section accumulates CLI changes
  until a maintainer cuts a `vX.Y.Z` tag - that is what "unreleased" means here.
  **Pure Worker/web changes get NO entry** - the web deploys by hand (not by tag; see
  the manual deploy runbook), so it is live the moment it ships and there is no
  "unreleased" web state to stage. Log a Worker change ONLY when it rides along with a
  CLI change in the **same tagged release** (e.g. a `@ymmv/shared` wire-format bump
  that touches both surfaces). Landing/UI/copy reworks are never a CHANGELOG entry.
  And only **notable** changes - never background/invisible ones.
- **DB-test parity:** web unit tests run in workerd and apply migrations
  per-suite - a new column needs both a migration **and** the test seed
  (`packages/web/test/e2e/seed.sql`) updated.
- **Secrets:** never log the ymmv bearer or the GitHub access_token (regression
  tests must not print tokens).

## Deploy Configuration (configured by /setup-deploy)
- Platform: Cloudflare Workers (wrangler), Worker `ymmv-production`
- Production URL: https://ymmv.fyi
- Deploy workflow: `.github/workflows/release.yml` (`deploy-worker`), fires on a
  `vX.Y.Z` tag only. **Merging to main deploys nothing.**
- Deploy status command: `gh run list --workflow release.yml --limit 1`
- Merge method: rebase
- Project type: web app + API (Worker) and npm CLI (`ymmv-cli`)
- Post-deploy health check: https://ymmv.fyi

### Custom deploy hooks
- Pre-merge: none (CI gates the PR)
- Deploy trigger: web-only change = manual runbook `packages/web/DEPLOY.md`
  (maintainer, needs Cloudflare creds); CLI or CLI+Worker = maintainer pushes a
  `vX.Y.Z` tag
- Deploy status: tag = the `release.yml` run; manual = wrangler output names
  `ymmv-production` + the `ymmv.fyi` / `www.ymmv.fyi` custom domains
- Health check: https://ymmv.fyi (200) and https://ymmv.fyi/api/v1/u/bardisty
  (200, JSON)
