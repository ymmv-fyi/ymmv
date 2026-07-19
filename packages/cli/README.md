# ymmv-cli

**The tools you actually use. Publish from the CLI, diff against anyone's.**

Editor, OS, shell, terminal, theme (and more), published to a
clean page at `ymmv.fyi/<handle>` in about 10 seconds. See a live one:
[ymmv.fyi/bardisty](https://ymmv.fyi/bardisty).

![Running npx ymmv-cli to detect, confirm, and publish a dev stack to a live ymmv.fyi page](https://raw.githubusercontent.com/ymmv-fyi/ymmv/main/docs/demo.gif)

```sh
npx ymmv-cli            # detect your stack, confirm, go live at ymmv.fyi/<you>
npx ymmv-cli bardisty   # view someone's stack in the terminal
```

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
- `ymmv version` prints the CLI version

Every profile is open JSON too: `GET https://ymmv.fyi/api/v1/u/<handle>`.

Color output respects `NO_COLOR`; set `YMMV_API` to point the CLI at a different Worker
(development).

## License

MIT. Source + issues: <https://github.com/ymmv-fyi/ymmv>.
