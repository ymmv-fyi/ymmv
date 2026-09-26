# Manual Web Deploy

Manual fallback for the `deploy-worker` job in `.github/workflows/release.yml` (normally fired by
a `vX.Y.Z` CLI tag). Use it for a web change with no CLI release to tag; keep it in sync if that
job changes.

Build + deploy only. Skipped vs CI:

- **D1 migrations**: only if the change adds a migration file, run
  `pnpm exec wrangler d1 migrations apply ymmv --env production --remote` (from `packages/web`) first.
- **CLI publish**: tag-only; nothing goes to npm here.

## Worker before CLI (do not roll back behind a published CLI)

The CLI's login parse requires every field the current mint response carries: a Worker that omits
`token`, `handle`, or `github_id` fails every login with "Unexpected response", and one that omits
`revoked` when the request carried `revoke` (every re-login with a stored token; a first login
still works) fails with "did not retire the previous login" until the Worker is updated or the
user runs `ymmv logout` first. Every
`YMMV_TOKEN` command needs `GET /api/v1/auth/whoami` too: against a Worker without it, `ymmv -y`,
`ymmv set`/`unset`, and `ymmv delete` fail with an error saying the server is behind the CLI
release (`ymmv <handle>` still renders, without a diff). Every write command (`ymmv`, `ymmv set`,
`ymmv unset`) also needs `GET /api/v1/profile` (the authed own-profile read) and a `POST
/api/v1/profile` that honours `If-Match`: against a Worker without the GET they fail with the same
"behind this CLI release" error rather than publishing from scratch. A tag release already orders this
(`publish-cli` needs `deploy-worker` in `release.yml`). Manually: never roll
the Worker back to a build older than the published CLI expects, and when a manual deploy
precedes a CLI tag, deploy first, tag second.

## Canonical origin + HSTS

The Worker (`src/middleware.ts`) redirects `http://` and `www.` to `https://ymmv.fyi`, same path
and query: 301 for GET/HEAD, 308 for other methods. Page and API responses on `ymmv.fyi` and
`www.ymmv.fyi` over https carry `strict-transport-security: max-age=31536000; includeSubDomains`.
No zone setting is involved ("Always Use HTTPS" stays off).

- **Static assets get neither.** Workers Static Assets serves `/_astro/*` and `public/*` before
  the Worker runs, so `http://ymmv.fyi/og.png` still answers 200, with no HSTS header. A few
  Astro replies skip the middleware too (listed in `src/middleware.ts`). Pages link assets
  root-relative and every page is Worker-rendered, so browsers get HSTS on their first page view,
  and one pinned response covers the host.
- **HSTS can't be taken back early.** A browser that saw it refuses plain http on `ymmv.fyi`
  and every subdomain for a year, so every `*.ymmv.fyi` DNS record, existing or new, must serve
  HTTPS. Cloudflare's Universal SSL covers the apex and first-level names only: a deeper name
  (`a.b.ymmv.fyi`) needs a Worker custom domain or an advanced certificate, and a DNS-only
  record needs HTTPS at its origin.
- **A new custom domain** in `wrangler.jsonc` must also be added to `canonicalHosts()` in
  `src/lib/canonical-origin.ts`, or it serves every page as a second origin
  (`test/wrangler-config.test.ts` fails until both match).

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

### 6. Smoke the live site

```powershell
curl.exe -s -o NUL -w "%{http_code}\n" https://ymmv.fyi/api/v1/u/bardisty   # 200
foreach ($u in 'https://ymmv.fyi/', 'https://www.ymmv.fyi/bardisty') {
  curl.exe -sI $u | Select-String '^HTTP/|^location:|^strict-transport'
}
foreach ($u in 'http://ymmv.fyi/bardisty?x=1', 'http://www.ymmv.fyi/') {
  curl.exe -s -o NUL -w "%{http_code} %{redirect_url}\n" $u
}
curl.exe -s -o NUL -w "%{http_code} %{redirect_url}\n" -X POST http://ymmv.fyi/api/v1/profile
```

Expect, in order: `200`; the apex 200 and the www 301 to `https://ymmv.fyi/bardisty`, each
with `strict-transport-security: max-age=31536000; includeSubDomains`;
`301 https://ymmv.fyi/bardisty?x=1`, `301 https://ymmv.fyi/`; `308 https://ymmv.fyi/api/v1/profile`.
An http row answering 200 means the Worker never saw an `http:` scheme in `request.url`, so the
redirect didn't fire: stop and investigate.
