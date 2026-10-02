<!-- Title: type(scope): summary, such as "fix(cli): ...". It becomes the commit subject on main. -->

## What changed

<!-- What this changes and why. Link the issue it fixes, if there is one: Fixes #123 -->

## How you tested it

<!-- And anything you couldn't test: an OS, a terminal, a package manager. -->

<!--
Before you open it (CONTRIBUTING.md has the details):
- pnpm lint && pnpm build && pnpm typecheck && pnpm test pass, plus
  pnpm --filter @ymmv/web test:e2e if you touched packages/web.
- A change a CLI user would notice has an entry under ## [Unreleased] in CHANGELOG.md.
- No package.json version and no docs/demo.gif in the diff.
-->
