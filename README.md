# ymmv.fyi

**Share your dev tool-stack from the terminal.**

Editor, OS, shell, terminal, browser, font (and more) — published to a clean
page at `ymmv.fyi/<handle>` in about 10 seconds.

![Running npx ymmv-cli to detect, confirm, and publish a dev stack to a live ymmv.fyi page](docs/demo.gif)

## Try it

```sh
npx ymmv-cli           # detect your stack, confirm, go live at ymmv.fyi/<you>
npx ymmv-cli bardisty  # view someone's stack in the terminal
```

First run includes a one-time GitHub sign-in (the device flow you know from `gh`
/ `npm login`, ~10s). Every update after that is instant.

## What you get

- **A clean, shareable page** at `ymmv.fyi/<handle>`.
- **Auto-detected** — it reads your shell, OS, terminal, and editor, then pre-fills; you just confirm.
- **Instant updates** — re-run any time; your page refreshes in seconds.
- **Diffs** — view someone's profile while you're logged in, and you'll see how your stack compares:

  ```
              theirs         yours
  editor      Neovim         VS Code
  shell       fish           zsh
  font        Berkeley Mono  JetBrains Mono
  wm          AeroSpace      —
  ```

  Also on the web: type a handle into the `diff vs` box on any profile page, or
  go straight to `https://ymmv.fyi/<them>/vs/<you>`.

- **Open data** — every profile is JSON too: `GET https://ymmv.fyi/api/v1/u/<handle>`.

## Commands

Run with `npx ymmv-cli` (no install), or `npm i -g ymmv-cli` once for the short `ymmv`:

- `ymmv` — detect, confirm, and publish (re-run any time to update)
- `ymmv <handle>` — view a profile, or diff it against yours when you're logged in
- `ymmv set editor Neovim` — change one value
- `ymmv set --extra "Keyboard=HHKB"` — add a free-form line of your own
- `ymmv delete` — remove your profile
- `ymmv login` / `ymmv logout` — sign in / out

## License

[MIT](LICENSE).
