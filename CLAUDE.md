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
  for API consumers.
- **Flag every manual step explicitly:** Cloudflare Worker secrets/env, D1
  migrations (new file in `packages/web/migrations` + apply local for tests
  **and** prod on deploy), the `RL_WRITE` binding, npm publish (tag-driven OIDC
  `release.yml`), DNS.
- **Versioning is tag-driven - NEVER bump a version.** There is no VERSION file,
  and all four `package.json`s are intentionally `0.0.0` (CI runs `npm pkg set
  version` from the `vX.Y.Z` tag at publish time, ephemerally on the runner).
  Record the change in a new `CHANGELOG.md` section; the number is set by the
  tag a maintainer pushes. **Creating a VERSION file or editing any
  `package.json` `version` is a bug** - leave them at `0.0.0`. (This is the one
  place the generic gstack `/ship` "bump VERSION" step does NOT apply to this
  repo.)
- **DB-test parity:** web unit tests run in workerd and apply migrations
  per-suite - a new column needs both a migration **and** the test seed
  (`packages/web/test/e2e/seed.sql`) updated.
- **Secrets:** never log the ymmv bearer or the GitHub access_token (regression
  tests must not print tokens).

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
