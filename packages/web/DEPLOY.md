# Web Deploy

A web change with no CLI release to tag deploys from `main` by dispatching
`.github/workflows/release.yml`:

```sh
gh workflow run release.yml --ref main -f environment=production -f dry_run=false
gh run watch <id> --exit-status      # <id> is the last part of the URL the first command prints
```

The run uses the release's own `gate` and `deploy-worker` jobs: lint, build, typecheck and tests,
the production build with its baked-config checks, D1 migrations, the deploy, and a smoke of the
live site (the home page, a `whoami` that reads D1, and a junk-token sign-in that answers 401
only when `GITHUB_CLIENT_SECRET` is set and right). Nothing goes to npm and no GitHub Release is cut. It
needs no Cloudflare credentials on your machine.

- It deploys `main`'s HEAD, and only from `main`. From any other ref, a dispatch with
  `dry_run=false` fails in `prep`, for staging as well as production.
- The run deploys the commit it captured. If `main` has moved by the time it deploys, it stops, so
  a re-run of an old run can't put an old build back. Dispatch again.
- The commit needs a green CI run first, because e2e runs only in `ci.yml`. Right after a merge,
  wait for CI on `main`.
- **The WAF rule is still applied by hand.** If `infra/waf-ratelimit.sh` changed since the last
  deploy, do step 4 below before the dispatch.
- Afterwards, run the step 6 checks the workflow leaves out: the redirects and HSTS headers, and
  the workers.dev origins. The Current Version ID that step asks for is in the run's Deploy step
  log.
- A tag release deploys the tagged commit. If you deploy web changes that merged after a cut and
  then tag that cut, the release puts the older build back (its gate prints a warning): dispatch
  the web deploy again after the release.
- The Worker-before-CLI rule below holds for a dispatch too: when a web deploy precedes a CLI
  tag, deploy first, tag second.

## Where the deploy credentials live

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are secrets of the repo's `staging` and
`production` environments, not repo secrets. `production` admits `main` and `v*` tags, and
`staging` admits `main`, so a workflow run from any other ref can't read them. Only the two steps
that talk to Cloudflare read them, `Apply D1 migrations` and `Deploy`, so the install and the build
never run with the token. A dry run needs neither secret and runs outside both environments.

The npm Trusted Publisher for `ymmv-cli` names a third environment, `npm`, which holds no secrets
and admits only `v*` tags. `publish-cli` runs there on a tag push, so no run from a branch, `main`
included, can publish. Both `npm` and `production` admit any `v*` tag, and the gate's tag check
runs from the tagged commit's own workflow, so the "Protect release tags" ruleset, which lets only
admins create, move or delete a `v*` tag, is part of this boundary. So is the "Protect main"
ruleset, because `staging` and `production` admit `main`.

After rotating the Cloudflare token, set it in both environments:

```sh
gh secret set CLOUDFLARE_API_TOKEN --env production
gh secret set CLOUDFLARE_API_TOKEN --env staging
```

## By hand (fallback)

The rest of this file is the manual fallback for the `deploy-worker` job, for when Actions can't
run it. Keep it in sync if that job changes.

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
and query: 301 for GET/HEAD, 308 for other methods. A plain `http://` request with an
`authorization` header or a method other than GET/HEAD/OPTIONS gets `403 https_required`
instead, with no `Location`, so a client that follows redirects can't resend its credential in
cleartext on every call. Page and API responses on `ymmv.fyi` and
`www.ymmv.fyi` over https carry `strict-transport-security: max-age=31536000; includeSubDomains`.
No zone setting is involved ("Always Use HTTPS" stays off).

- **Static assets get none of this.** Workers Static Assets serves `/_astro/*` and `public/*`
  before the Worker runs, so `http://ymmv.fyi/og.png` still answers 200, with no HSTS header, and
  so does that request carrying an `authorization` header (no 403). A few
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

Run the steps in PowerShell 7.1 or later (`pwsh`): step 4's masked prompt needs it, and Windows
PowerShell 5.1 would echo the token. Step 4 also needs Git for Windows (for Git Bash) and `jq` on
`PATH`.

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

### 3. Sanity-check the baked config (mirrors CI's baked-config asserts + confirms the name)

```powershell
Select-String packages/web/dist/server/wrangler.json -Pattern 'ymmv-production|RL_WRITE|RL_AUTH'
$baked = Get-Content packages/web/dist/server/wrangler.json -Raw | ConvertFrom-Json
if ($baked.workers_dev -ne $false -or $baked.preview_urls -ne $false) { throw 'workers_dev and preview_urls must both be false' }
```

The second check throws unless `workers_dev` and `preview_urls` are both `false`, so the custom
domains are the only origins, with no `workers.dev` or
`<version>-ymmv-production.<subdomain>.workers.dev` preview URL.

### 4. Zone WAF rate-limit rule, BEFORE the deploy (only when `infra/waf-ratelimit.sh` changed)

The rule in `infra/waf-ratelimit.sh` is the source of truth for the edge rate limit, and it is the
only limiter in front of the bearer GETs, `/api/v1/auth/whoami` and `/api/v1/profile` (no Workers
binding). When the script changed since the last deploy, apply it first, so the Worker never serves
a new endpoint the rule does not yet cover; then verify. To tell, diff it against the commit the
live Worker was built from:

```powershell
git diff --stat '<last deployed commit>' HEAD -- infra/waf-ratelimit.sh
```

Any output means run this step. An edit that leaves the rule as it is costs one `apply`, which is
idempotent. If you don't know the last deployed commit, run the step anyway.

The script reads the zone WAF-edit token from `CLOUDFLARE_WAF_TOKEN`, so the `CLOUDFLARE_API_TOKEN`
step 5 deploys with is never touched. Run it with Git Bash: in PowerShell a bare `bash` can be WSL's,
which never sees the PowerShell environment. From the repo root, paste exactly this block (the
prompt masks the token and keeps it out of the command line):

```powershell
try {
  if ($PSVersionTable.PSVersion -lt [version]'7.1') { throw 'run this in pwsh 7.1+: this shell would echo the token' }
  $env:CLOUDFLARE_WAF_TOKEN = Read-Host -MaskInput 'zone WAF-edit token'
  if (-not $env:CLOUDFLARE_WAF_TOKEN) { throw 'no WAF token entered: do not deploy' }
  if (-not $env:CLOUDFLARE_ZONE_ID) { $env:CLOUDFLARE_ZONE_ID = Read-Host 'ymmv.fyi zone id' }
  "zone: $env:CLOUDFLARE_ZONE_ID (must be ymmv.fyi's)"
  $gitBash = Join-Path (Split-Path (Split-Path (Get-Command git).Source)) 'bin\bash.exe'
  if (-not (Test-Path $gitBash)) { throw "Git Bash not found ($gitBash): do not deploy" }
  & $gitBash infra/waf-ratelimit.sh apply;  if ($LASTEXITCODE) { throw 'WAF apply failed: do not deploy' }
  & $gitBash infra/waf-ratelimit.sh verify; if ($LASTEXITCODE) { throw 'WAF verify failed: do not deploy' }
} finally {
  Remove-Item Env:\CLOUDFLARE_WAF_TOKEN -ErrorAction Ignore
}
```

A throw from any line means stop: don't run step 5 until `verify` exits 0 (the live rule matches the
committed one). Its other exits: 1 drift, an ambiguous match or a missing variable; 2 no rule; 3 a
missing tool; 4 an API or transport failure.

### 5. Deploy the baked config (no `--env`)

First confirm the deploy uses the token in your shell. With `CLOUDFLARE_API_TOKEN` unset, wrangler
falls back to a cached `wrangler login`, which can be a different Cloudflare account:

```powershell
if (-not $env:CLOUDFLARE_API_TOKEN -or -not $env:CLOUDFLARE_ACCOUNT_ID) {
  throw 'set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (Prereqs)'
} else {
  "deploying to account $env:CLOUDFLARE_ACCOUNT_ID"
  pnpm --filter @ymmv/web exec wrangler whoami
}
```

Stop if that throws, or if the account table `whoami` prints has no row with the account ID printed
above. Then deploy:

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
`301 https://ymmv.fyi/bardisty?x=1`, `301 https://ymmv.fyi/`; `403` with an empty redirect URL
(the http POST is refused, not redirected).
An http GET row answering 200, or the POST answering anything but 403 (the route's own 401, say),
means the Worker never saw an `http:` scheme in `request.url`, so the redirect or refusal didn't
fire: stop and investigate.

Then confirm the Worker answers only on its custom domains. `<subdomain>` is the account's
workers.dev subdomain (staging is served on it), `<ver8>` the first 8 characters of the Current
Version ID from step 5:

```powershell
curl.exe -sS -o NUL -w "%{http_code} staging control\n" 'https://ymmv-staging.<subdomain>.workers.dev/'
foreach ($u in 'https://ymmv-production.<subdomain>.workers.dev/', 'https://<ver8>-ymmv-production.<subdomain>.workers.dev/') {
  curl.exe -sS -w " %{http_code} $u\n" $u
}
```

Expect `200` for the staging control, which proves `<subdomain>` is right. Each production row must
show the body `error code: 1042` with status `404`: Cloudflare's own reply for a workers.dev host it
doesn't serve. A 200 means workers.dev or Preview URLs are on for `ymmv-production`: turn them off
in the dashboard and deploy again. Any other reply (a 3xx, 403 or 5xx) means stop and investigate,
and `000` means curl got no answer (a placeholder left in): fill it in and rerun. The staging row
proves only `<subdomain>`, and a mistyped `<ver8>` also gets the 1042 reply, so copy it from this
deploy's Current Version ID, not the Deployment ID.
