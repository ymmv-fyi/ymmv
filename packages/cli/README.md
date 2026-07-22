# ymmv-cli

**The tools you actually use. Publish from the CLI, diff against anyone's.**

Editor, OS, shell, terminal, theme (and more), published to a
clean page at `ymmv.fyi/<handle>` in about 10 seconds. See a live one:
[ymmv.fyi/bardisty](https://ymmv.fyi/bardisty).

![Running npx ymmv-cli to detect, confirm, and publish a dev stack to a live ymmv.fyi page](https://raw.githubusercontent.com/ymmv-fyi/ymmv/main/docs/demo.gif)

```sh
npx ymmv-cli@latest            # detect your stack, confirm, go live at ymmv.fyi/<you>
npx ymmv-cli@latest bardisty   # view someone's stack in the terminal
```

(`@latest` keeps npx from reusing an old cached copy; without a version spec, npx can pin you
to whatever it downloaded first.)

Viewing someone while you're logged in diffs their stack against yours:

```
  how bardisty differs from you

          BARDISTY  YOU
~ Editor  Zed       VS Code
= Shell   bash      bash
~ Theme   Gruvbox   Catppuccin
~ Font    Lilex     JetBrains Mono

  3 differ   1 shared
```

Install once for the short `ymmv` command:

```sh
npm i -g ymmv-cli
```

When a newer release exists, the CLI mentions it after a command (interactive terminals only)
and `ymmv update` upgrades a global install in place.

First run includes a one-time GitHub sign-in. Works on macOS, Linux, Windows,
and WSL. Nothing is published until you confirm (detection only pre-fills), and
`ymmv delete` removes everything. Releases are published from GitHub Actions
via npm Trusted Publishing, with provenance.

## Commands

- `ymmv` detects, confirms, and publishes (re-run any time to update; `ymmv publish` is the same command)
- `ymmv <handle>` views a profile, or diffs it against yours when you're logged in
- `ymmv set editor Neovim` changes one value
- `ymmv set --extra "Keyboard=HHKB"` adds a free-form line of your own (`-e` works too)
- `ymmv unset editor` removes one value (`ymmv set editor -` works too); `ymmv unset --extra "Keyboard"` removes an extra
- `ymmv delete` removes your profile (`ymmv delete -y` skips the confirm, for scripts)
- `ymmv login` / `ymmv logout` sign in / out
- `ymmv update` updates the CLI to the latest release (runs the right package manager for a
  global install; via npx it prints the invocation to use instead)
- `ymmv version` prints the CLI version (and notes a newer release when one is known)

Values are capped at 256 characters and extra labels at 64; a profile holds up
to 32 extras.

Every profile is open JSON too: `GET https://ymmv.fyi/api/v1/u/<handle>`. Full contract
(shape, statuses, caching, CORS):
<https://github.com/ymmv-fyi/ymmv/blob/main/docs/api.md>.

## Environment variables

- `NO_COLOR` disables color output (and `FORCE_COLOR=0`/`false` force-disables it).
- `YMMV_API` points the CLI at a different Worker (development/staging). Bare origin only.
- `YMMV_TOKEN` authenticates without a browser (CI and scripts, below). Takes precedence over
  the stored login and is read-only: the CLI never writes, revokes, or deletes it, and
  `ymmv login` / `ymmv logout` keep acting on the stored login. Viewing (`ymmv <handle>`) also
  keeps using the stored login for the you-side of a diff. The token is sent to the server
  `YMMV_API` selects, so set the two together.
- `YMMV_HANDLE` names the GitHub username `YMMV_TOKEN` belongs to. Required for `ymmv -y` and
  `ymmv set`/`unset` under an env token (there is no server lookup for it); ignored without
  `YMMV_TOKEN`.
- `YMMV_NO_UPDATE_CHECK` disables the startup check for newer releases (the ecosystem-standard
  `NO_UPDATE_NOTIFIER` works too). The check is also off automatically under `CI`, in pipes,
  and in dev builds; it never blocks or fails a command.

## Publishing from CI

`ymmv login` needs a browser, so mint the token on your machine and hand it to CI:

1. Run `ymmv login` locally.
2. Copy the `token` value from the token file:
   `~/.config/ymmv/token.json` (Linux), `~/Library/Preferences/ymmv/token.json` (macOS),
   `%APPDATA%\ymmv\Config\token.json` (Windows).
3. Set it as a CI secret named `YMMV_TOKEN`, and set `YMMV_HANDLE` to your GitHub username.
4. Run `npx ymmv-cli@latest -y` in the job.

Two things to know:

- `ymmv -y` publishes the merge of your existing profile with what it detects on the machine it
  runs on. Values you already published always win, but curated keys you have never set get the
  CI runner's detected values (its OS, shell, and so on). For targeted updates from CI, prefer
  `ymmv set <key> <value>`.
- A rejected or revoked `YMMV_TOKEN` fails with an error naming the variable; nothing falls back
  to an interactive login, and the stored login file on the runner (if any) is left untouched.
  `ymmv delete` acts on the account the token is bound to, regardless of `YMMV_HANDLE`.

## License

MIT. Source + issues: <https://github.com/ymmv-fyi/ymmv>.
