# Security policy

## Reporting a vulnerability

Report it privately by
[opening a security advisory](https://github.com/ymmv-fyi/ymmv/security/advisories/new) on
GitHub. Please don't put it in a public issue or pull request.

Say what you found, how to reproduce it, and what someone could do with it. A proof of concept
helps. Test against your own account and profile, never someone else's.

ymmv has one maintainer, so expect a first reply within 7 days. Updates come in the advisory
thread until the fix ships. When it's live, the advisory goes public and credits you, unless you'd
rather not be named.

## What's in scope

- The ymmv.fyi site and its API under `https://ymmv.fyi/api/v1/`, served by the Worker in
  `packages/web`.
- The `ymmv-cli` npm package, from `packages/cli`.
- The release workflow in `.github/workflows/release.yml`, which deploys the Worker and publishes
  the package.

The reports that matter most: signing in as someone else, changing or deleting another person's
profile, getting hold of a token that isn't yours, publishing to npm or deploying the Worker
without access, and profile values that reach another person's terminal as escape sequences.

## What's out of scope

- Denial of service. Please don't load-test ymmv.fyi or send it heavy traffic.
- What people write on their own profiles. How the site or the CLI displays it is in scope.
- Scanner output that doesn't show a real problem.
- Bugs in GitHub, npm or Cloudflare themselves. Report those to them.

## Supported versions

Fixes land in the newest `ymmv-cli` release and on the live site. Older CLI releases don't get
patches. Run `ymmv update`, or `npx ymmv-cli@latest`, to get the fix.
