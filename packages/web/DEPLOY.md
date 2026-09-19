# Manual Web Deploy

Manual fallback for the `deploy-worker` job in `.github/workflows/release.yml` (normally fired by
a `vX.Y.Z` CLI tag). Use it for a web change with no CLI release to tag; keep it in sync if that
job changes.

Build + deploy only. Skipped vs CI:

- **D1 migrations**: only if the change adds a migration file, run
  `pnpm exec wrangler d1 migrations apply ymmv --env production --remote` (from `packages/web`) first.
- **CLI publish**: tag-only; nothing goes to npm here.

## Worker before CLI (do not roll back behind a published CLI)

The CLI's login parse requires every field the current mint response carries (`token`, `handle`,
`github_id`); a Worker that omits one fails every login with "Unexpected response". Every
`YMMV_TOKEN` command needs `GET /api/v1/auth/whoami` too: against a Worker without it, `ymmv -y`,
`ymmv set`/`unset`, and `ymmv delete` fail with an error saying the server is behind the CLI
release (`ymmv <handle>` still renders, without a diff). Every write command (`ymmv`, `ymmv set`,
`ymmv unset`) also needs `GET /api/v1/profile` (the authed own-profile read) and a `POST
/api/v1/profile` that honours `If-Match`: against a Worker without the GET they fail with the same
"behind this CLI release" error rather than publishing from scratch. A tag release already orders this
(`publish-cli` needs `deploy-worker` in `release.yml`). Manually: never roll
the Worker back to a build older than the published CLI expects, and when a manual deploy
precedes a CLI tag, deploy first, tag second.

## Two gotchas (do not skip)

- **Never bare-deploy.** Without `CLOUDFLARE_ENV=production` at build time, the config bakes the
  `ymmv-dev` name but still binds the live prod D1. Set it so `ymmv-production` + the `ymmv.fyi`
  routes bake in.
- **Set `CLOUDFLARE_ENV` for the build, unset it for the deploy.** The baked
  `dist/server/wrangler.json` has no env blocks; if it's still set at deploy, wrangler re-suffixes
  the name to `ymmv-production-production`, mismatching where the secrets live.

## Prereqs

Deploy the merged state, not a feature branch:

```powershell
git checkout main; git pull
```

Cloudflare creds in the shell (`account_id` is not committed; the custom-domain routes need DNS edit):

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = '<account id>'
$env:CLOUDFLARE_API_TOKEN  = '<token: Workers Scripts edit + Zone DNS edit>'
```

## Steps (from repo root)

### 1. Gates (same as CI's gate job)

```powershell
pnpm lint; pnpm -r build; pnpm typecheck; pnpm test
```

### 2. Production build (shared first, then web with the env baked, then unset)

```powershell
pnpm --filter @ymmv/shared build
$env:CLOUDFLARE_ENV = 'production'
pnpm --filter @ymmv/web build
Remove-Item Env:\CLOUDFLARE_ENV        # critical: must not reach wrangler deploy
```

### 3. Sanity-check the baked config (mirrors CI's RL asserts + confirms the name)

```powershell
Select-String packages/web/dist/server/wrangler.json -Pattern 'ymmv-production|RL_WRITE|RL_AUTH'
```

### 4. Zone WAF rate-limit rule, BEFORE the deploy (only when `infra/waf-ratelimit.sh` changed)

The committed rule expression is the source of truth for the edge rate limit, and it is the only
limiter in front of the bearer GETs, `/api/v1/auth/whoami` and `/api/v1/profile` (no Workers
binding). When the expression changed
since the last deploy, apply it first, so the Worker never serves a new endpoint the rule does not
yet cover; then verify. Needs a zone WAF-edit API token. Still from the repo root:

```powershell
$env:CLOUDFLARE_API_TOKEN = '...'; $env:CLOUDFLARE_ZONE_ID = '...'
bash infra/waf-ratelimit.sh apply
bash infra/waf-ratelimit.sh verify
Remove-Item Env:\CLOUDFLARE_API_TOKEN
```

`verify` reports drift between the committed expression and the live rule.

### 5. Deploy the baked config (no `--env`)

```powershell
cd packages/web
pnpm exec wrangler deploy -c dist/server/wrangler.json
```

Confirm the output names Worker `ymmv-production` and the `ymmv.fyi` / `www.ymmv.fyi` custom domains.
