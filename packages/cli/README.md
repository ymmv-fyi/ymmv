# ymmv-cli

**Share your dev tool-stack from the terminal.**

Editor, OS, shell, terminal, fonts, AI tools — published to a clean page at `ymmv.fyi/<your-handle>`
in about 10 seconds.

```sh
npx ymmv-cli            # detect your stack, confirm, go live at ymmv.fyi/<you>
npx ymmv-cli bardisty   # view someone's stack in the terminal
```

Install once for the short `ymmv` command:

```sh
npm i -g ymmv-cli
```

First run includes a one-time GitHub sign-in (the device flow you know from `gh` / `npm login`, ~10s).

## Commands

- `ymmv` — detect, confirm, and publish (re-run any time to update)
- `ymmv <handle>` — view a profile, or diff it against yours when you're logged in
- `ymmv set editor Neovim` — change one value
- `ymmv set --extra "Keyboard=HHKB"` — add a free-form line of your own
- `ymmv delete` — remove your profile
- `ymmv login` / `ymmv logout` — sign in / out

Every profile is open JSON too — `GET https://ymmv.fyi/api/v1/u/<handle>`.

## License

MIT. Source + issues: <https://github.com/ymmv-fyi/ymmv>.
