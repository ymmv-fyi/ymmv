# ymmv.fyi

**The tools you actually use. Publish from the CLI, diff against anyone's.**

[![npm](https://img.shields.io/npm/v/ymmv-cli)](https://www.npmjs.com/package/ymmv-cli)
[![CI](https://github.com/ymmv-fyi/ymmv/actions/workflows/ci.yml/badge.svg)](https://github.com/ymmv-fyi/ymmv/actions/workflows/ci.yml)

One command puts your editor, OS, shell, terminal, theme and the rest of your
setup on a page at `ymmv.fyi/<handle>`. It takes about 10 seconds. Here's a
live one: [ymmv.fyi/bardisty](https://ymmv.fyi/bardisty).

![Running npx ymmv-cli to detect, confirm, and publish a dev stack to a live ymmv.fyi page](docs/demo.gif)

## Try it

```sh
npx ymmv-cli@latest           # detect your stack, confirm, go live at ymmv.fyi/<you>
npx ymmv-cli@latest bardisty  # view someone's stack in the terminal
```

Works on macOS, Linux, Windows, and WSL, with Node 22 or newer. If you'd
rather type `ymmv`, install it once with `npm i -g ymmv-cli`. The rest of this
page uses the short form.

The first run goes like this:

1. It shows what it detected on your machine.
2. You sign in with GitHub. Your GitHub username becomes your handle.
3. It asks for the fields it could not detect (font, theme and dotfiles always).
4. You confirm, and the page goes live.

## Diff your stack against anyone's

Sign in, then view someone's profile. The CLI lines their stack up against
yours:

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

## Updating your page

Run `ymmv` again. The preview marks what publishing would change on your live
page: `~` changed, `+` new, `-` cleared. If nothing would change, it says so,
and Enter leaves the page alone.

At the `Publish to ymmv.fyi/<you>?` prompt:

- `y` publishes.
- `n` stops without publishing.
- `e` edits one field by name. Press Enter at the field question to go through
  all 13.
- `d` shows up when your machine now detects a different tool than the one
  you saved. Say you switched to Neovim. The Editor row then reads
  `(detected: Neovim)`, and `d` asks about each marked row. `y` takes the
  detected value. `n` keeps yours, and the CLI stops marking that row on this
  machine until either value changes. `ymmv --reset-marks` brings the marks
  back.

## Commands

| Command                            | What it does                                                         |
| ---------------------------------- | -------------------------------------------------------------------- |
| `ymmv`                             | Detect, confirm, publish. `ymmv publish` is the same command.        |
| `ymmv <handle>`                    | View a profile, or diff it against yours when you're signed in.      |
| `ymmv set editor Neovim`           | Change one value.                                                    |
| `ymmv set --extra "Keyboard=HHKB"` | Add a free-form line of your own. `-e` works too.                    |
| `ymmv unset editor`                | Remove one value. `ymmv set editor -` does the same.                 |
| `ymmv unset --extra "Keyboard"`    | Remove an extra.                                                     |
| `ymmv delete`                      | Delete your profile. `-y` skips the confirm, for scripts.            |
| `ymmv login`                       | Sign in with GitHub.                                                 |
| `ymmv logout`                      | Sign out.                                                            |
| `ymmv update`                      | Update the CLI to the latest release, for a global install.          |
| `ymmv version`                     | Print the CLI version.                                               |

A few commands ask before acting:

- `ymmv set dotfiles github.com/you/dotfiles` offers the `https://` form,
  since only a full URL turns into a link on your page. The publish prompts
  offer the same.
- If you're already signed in, `ymmv login` names the account and asks
  before signing in again. `ymmv login -y` skips the question. You need `-y`
  when the output is piped or redirected.

Environment variables and publishing from CI are covered in the
[CLI README](packages/cli/README.md).

## What leaves your machine

- **Auto-detection.** The CLI reads your OS, shell, prompt, terminal, editor,
  multiplexer, version manager, window manager, browser, and AI tool from the
  environment. Those values only fill in the preview.
- **Nothing publishes until you confirm.** Once it's up, `ymmv delete` removes it.
- **Your page is public, and so is its JSON.** `GET https://ymmv.fyi/api/v1/u/<handle>`
  returns the same stack. The shape, statuses, caching and CORS rules are in
  [docs/api.md](docs/api.md).

## Developing

You need Node 22+ and pnpm. The repo has three packages:

- `packages/shared` holds the types, the tool catalog and the diff engine. The
  other two build on it.
- `packages/cli` is the `ymmv-cli` npm package.
- `packages/web` is the site and API, built with Astro on Cloudflare Workers + D1.

```sh
pnpm install
pnpm build     # all packages, @ymmv/shared first
pnpm dev       # hot-reloading site at localhost:4321
```

The full gate, same as CI:

```sh
pnpm lint && pnpm build && pnpm typecheck && pnpm test
pnpm --filter @ymmv/web exec playwright install chromium   # once
pnpm --filter @ymmv/web test:e2e                           # for web changes
```

To try your local CLI without touching production, start a seeded local
Worker (real D1 and bindings), then point the CLI at it from a second terminal.
The same Worker serves the site at `localhost:8788`.

```sh
pnpm --filter @ymmv/web e2e:serve
YMMV_API=http://localhost:8788 node packages/cli/dist/cli.js bardisty
```

Versions come from tags. Every `package.json` stays at `0.0.0`, and CI stamps
the real version from the `vX.Y.Z` tag at publish time. Don't bump anything.

## License

[MIT](LICENSE).
