# Contributing

Bug reports, fixes and small improvements are welcome. For a new feature, or anything that
changes how publishing works, open an issue first, so we can agree on the approach before you put
time into it.

## Setting up

The README's [Developing](README.md#developing) section covers setup, the local Worker and the
demo. You need Node 22 or newer and pnpm. The gate CI runs, in order:

```sh
pnpm lint && pnpm build && pnpm typecheck && pnpm test
pnpm --filter @ymmv/web exec playwright install chromium   # once
pnpm --filter @ymmv/web test:e2e   # when you touch packages/web
```

CI runs it on Node 22 and 26, plus the e2e suite, and a pull request merges only when all three
are green.

Biome formats the code. Run it on the files you changed, `pnpm exec biome check --write <files>`.
Skip `pnpm format`, which rewrites the whole tree.

## Things that trip people up

- **`@ymmv/shared` reaches both the CLI and the site.** The types, the tool catalog and the diff
  engine live there. Update both sides in the same pull request and run the whole gate, not one
  package's tests.
- **The public JSON API is a contract.** Changing the shape of `GET /api/v1/u/<handle>` breaks
  everyone who reads it, so open an issue first. [docs/api.md](docs/api.md) has the current shape.
- **A new D1 column touches three files.** The migration in `packages/web/migrations`, the e2e
  seed in `packages/web/test/e2e/seed.sql`, and the demo seed in `docs/demo/seed.sql`.
- **Leave versions and the demo gif alone.** Every `package.json` stays at `0.0.0`, and the
  release tag sets the real version. `docs/demo.gif` is re-recorded when a release is cut. If you
  change the questions the first publish asks, or what it detects, update the `Wait` lines in
  `docs/demo/demo.tape` or the environment in `docs/demo/shell.sh`;
  `packages/cli/test/demo-tape.test.ts` fails until they match.
- **User-facing text has a house style.** No em dashes and no `·` separators in CLI output or on
  the site, except the `—` that marks a missing value. A message with two sentences opens with a
  capital letter, and a lone fragment stays lowercase (`publish failed: 500`).
  [DESIGN.md](DESIGN.md) has the rest of the rules for the web.

## Changelog

`CHANGELOG.md` is the release log for the `ymmv-cli` package. If a CLI user would notice your
change, add an entry under `## [Unreleased]` at the top (create the heading if it isn't there),
in an `Added`, `Changed`, `Fixed` or `Removed` group. Lead with a bold one-line statement of what
changed for the user, then add a sentence or two of detail.

Changes to the website alone get no entry, because the site deploys on its own schedule. Neither
do tests, refactors or CI changes.

## Commits and pull requests

Pull requests are usually rebase-merged, so each commit lands on `main` as you wrote it. Keep a
commit to one change that builds and passes the tests, and fold fix-ups into the commit they fix
before review. Subjects follow `type(scope): summary`, such as `fix(cli): ...` or
`feat(web): ...`. The scope is optional, as in `docs: ...`. The body says what changed and why.

In the pull request, say what changed, how you tested it, and what you couldn't test: an OS, a
terminal, a package manager.

## Bugs and security issues

File bugs with the
[bug report form](https://github.com/ymmv-fyi/ymmv/issues/new?template=bug_report.yml). Security
problems go through [SECURITY.md](SECURITY.md) instead, privately.

## License

Contributions are released under the [MIT License](LICENSE).
