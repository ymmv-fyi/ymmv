# Manual Web Deploy

Manual fallback for the `deploy-worker` job in `.github/workflows/release.yml` (normally fired by
a `vX.Y.Z` CLI tag). Use it for a web change with no CLI release to tag; keep it in sync if that
job changes.

Build + deploy only. Skipped vs CI:

- **D1 migrations**: only if the change adds a migration file, run
  `pnpm exec wrangler d1 migrations apply ymmv --env production --remote` (from `packages/web`) first.
- **CLI publish**: tag-only; nothing goes to npm here.

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

### 4. Deploy the baked config (no `--env`)

```powershell
cd packages/web
pnpm exec wrangler deploy -c dist/server/wrangler.json
```

Confirm the output names Worker `ymmv-production` and the `ymmv.fyi` / `www.ymmv.fyi` custom domains.
