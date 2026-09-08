# ymmv.fyi

**The tools you actually use. Publish from the CLI, diff against anyone's.**

[![npm](https://img.shields.io/npm/v/ymmv-cli)](https://www.npmjs.com/package/ymmv-cli)
[![CI](https://github.com/ymmv-fyi/ymmv/actions/workflows/ci.yml/badge.svg)](https://github.com/ymmv-fyi/ymmv/actions/workflows/ci.yml)

Editor, OS, shell, terminal, theme and more, published to a page at
`ymmv.fyi/<handle>` in about 10 seconds. See a live one:
[ymmv.fyi/bardisty](https://ymmv.fyi/bardisty).

![Running npx ymmv-cli to detect, confirm, and publish a dev stack to a live ymmv.fyi page](docs/demo.gif)

## Try it

```sh
npx ymmv-cli@latest           # detect your stack, confirm, go live at ymmv.fyi/<you>
npx ymmv-cli@latest bardisty  # view someone's stack in the terminal
```

The first run asks you to sign in with GitHub. Every run after that goes
straight to detect, confirm, publish, so updating your page is the same
command again. Works on macOS, Linux, Windows, and WSL.

## What you get

- **Auto-detection.** It reads your OS, shell, prompt, terminal, editor, multiplexer,
  version manager, window manager, browser, and AI tool from the environment and
  pre-fills the form. You confirm or edit.
- **Nothing publishes until you confirm.** Detection only pre-fills, and `ymmv delete`
  removes everything.
- **Diffs.** View someone's profile while you're logged in and you'll see how your
  stack compares:

  ```
    how bardisty differs from you

            BARDISTY  YOU
  ~ Editor  Zed       VS Code
  = Shell   bash      bash
  ~ Theme   Gruvbox   Catppuccin
  ~ Font    Lilex     JetBrains Mono

    3 differ   1 shared
  ```

  On the web, type a handle into the `diff vs` box on any profile page, or go
  straight to `ymmv.fyi/<them>/vs/<you>`.

- **Open data.** Every profile is JSON too: `GET https://ymmv.fyi/api/v1/u/<handle>`.
  Full contract (shape, statuses, caching, CORS): [docs/api.md](docs/api.md).

## Commands

Run with `npx ymmv-cli@latest`, or install once with `npm i -g ymmv-cli` for
the short `ymmv` used below:

- `ymmv` detects, confirms, and publishes. `ymmv publish` is the same command.
- `ymmv <handle>` views a profile, or diffs it against yours when you're logged in.
- `ymmv set editor Neovim` changes one value.
- `ymmv set --extra "Keyboard=HHKB"` adds a free-form line of your own. `-e` works too.
- `ymmv unset editor` removes one value, as does `ymmv set editor -`.
- `ymmv unset --extra "Keyboard"` removes an extra.
- `ymmv delete` removes your profile. `ymmv delete -y` skips the confirm, for scripts.
- `ymmv login` / `ymmv logout` sign in and out.
- `ymmv update` updates the CLI to the latest release. Use it to keep a global install current.
- `ymmv version` prints the CLI version.

## Developing

Node 22+ and pnpm. Three packages: `shared` (types, tool catalog, diff engine),
`cli` (the `ymmv-cli` npm package), and `web` (Astro on Cloudflare Workers + D1).

```sh
pnpm install
pnpm build     # all packages; @ymmv/shared first, cli and web depend on it
pnpm dev       # hot-reloading site at localhost:4321
```

The full gate, same as CI:

```sh
pnpm lint && pnpm build && pnpm typecheck && pnpm test
pnpm --filter @ymmv/web exec playwright install chromium   # once
pnpm --filter @ymmv/web test:e2e                           # for web changes
```

To try your local CLI, run `node packages/cli/dist/cli.js` after a build, with
`YMMV_API` pointed at a local Worker so writes stay off production. To browse
the site with real data, `pnpm --filter @ymmv/web e2e:serve` starts a seeded
local Worker (real D1 and bindings) at `localhost:8788`.

Versions are tag-driven: every `package.json` stays at `0.0.0` and CI stamps the
real version from the `vX.Y.Z` tag at publish time. Don't bump anything.

## License

[MIT](LICENSE).
