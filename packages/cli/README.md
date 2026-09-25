# ymmv-cli

**The tools you actually use. Publish from the CLI, diff against anyone's.**

One command puts your editor, OS, shell, terminal, theme and the rest of your
setup on a page at `ymmv.fyi/<handle>`. It takes about 10 seconds. Here's a
live one: [ymmv.fyi/bardisty](https://ymmv.fyi/bardisty).

![Running npx ymmv-cli to detect, confirm, and publish a dev stack to a live ymmv.fyi page](https://raw.githubusercontent.com/ymmv-fyi/ymmv/main/docs/demo.gif)

## Try it

```sh
npx ymmv-cli@latest            # detect your stack, confirm, go live at ymmv.fyi/<you>
npx ymmv-cli@latest bardisty   # view someone's stack in the terminal
```

Keep the `@latest`. Without a version, npx can keep running whichever release
it downloaded first.

Works on macOS, Linux, Windows, and WSL, with Node 22 or newer. If you'd
rather type `ymmv`, install it once:

```sh
npm i -g ymmv-cli
```

The rest of this page uses the short form.

When a newer release exists, the CLI mentions it after a command (in
interactive terminals only), and `ymmv update` upgrades a global install in
place.

The first run goes like this:

1. It shows what it detected on your machine.
2. You sign in with GitHub, once per machine. On a local terminal, Enter
   copies the code and opens the sign-in page in your browser. Your GitHub
   username becomes your handle.
3. It asks for the fields it could not detect (font, theme and dotfiles always).
4. You confirm, and the page goes live.

Nothing publishes until you confirm, and `ymmv delete` removes everything.
GitHub Actions publishes each release through npm Trusted Publishing, with
provenance.

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

## Updating your page

Run `ymmv` again. The preview marks what publishing would change on your live
page: `~` changed, `+` new, `-` cleared. If nothing would change, it says so
and Enter leaves the page alone. `y` still publishes, if you want to move your
updated date.

At the `Publish to ymmv.fyi/<you>?` prompt:

- `y` publishes.
- `n` stops without publishing.
- `e` asks `Which field (Enter for all):`. Type a key or a label, or just
  enough of one to pick a single field. `font` edits the font, `win` the
  window manager. Enter goes through all 13.
- `d` shows up when your machine now detects a different tool than the one
  you saved. Say you switched to Neovim. The Editor row then reads
  `(detected: Neovim)`, and `d` asks about each marked row. `y` takes the
  detected value. `n` keeps yours, and the CLI stops marking that row on this
  machine until either value changes.

## Commands

| Command                            | What it does                                                            |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `ymmv`                             | Detect, confirm, publish. `ymmv publish` is the same command.           |
| `ymmv -y`                          | Publish without prompts. See [Publishing from CI](#publishing-from-ci). |
| `ymmv --reset-marks`               | Forget your `n` answers to `d`, so every differing row is marked again. |
| `ymmv <handle>`                    | View a profile, or diff it against yours when you're signed in.         |
| `ymmv set editor Neovim`           | Change one value.                                                       |
| `ymmv set --extra "Keyboard=HHKB"` | Add a free-form line of your own. `-e` works too.                       |
| `ymmv unset editor`                | Remove one value. `ymmv set editor -` does the same.                    |
| `ymmv unset --extra "Keyboard"`    | Remove an extra.                                                        |
| `ymmv delete`                      | Delete your profile. `-y` skips the confirm, for scripts.               |
| `ymmv login`                       | Sign in with GitHub.                                                    |
| `ymmv logout`                      | Sign out.                                                               |
| `ymmv update`                      | Update the CLI to the latest release.                                   |
| `ymmv version`                     | Print the CLI version. It also notes a newer release when one is known. |

Some of these have more to them:

- `ymmv set dotfiles github.com/you/dotfiles` offers the `https://` form,
  since only a full URL turns into a link on your page. The publish prompts
  offer the same. Without a terminal, or under `YMMV_TOKEN`, it stores the
  value as typed and never asks.
- If you're already signed in, `ymmv login` names the account and asks
  before signing in again. `ymmv login -y` skips the question. You need `-y`
  when the output is piped or redirected.
- `ymmv update` runs the matching upgrade for npm, pnpm and bun global
  installs. Under npx it prints the command to use instead. Anything else gets
  the commands to run by hand.

## Limits

- A value can be up to 256 characters, and an extra's label up to 64.
- Values and labels each need at least one visible character.
- A profile holds up to 32 extras.

## Profiles as JSON

Every profile is public JSON too: `GET https://ymmv.fyi/api/v1/u/<handle>`.
The shape, statuses, caching and CORS rules are in the
[API docs](https://github.com/ymmv-fyi/ymmv/blob/main/docs/api.md).

## Environment variables

- `NO_COLOR` turns color off. So does `FORCE_COLOR=0` or `FORCE_COLOR=false`.
- `YMMV_API` points the CLI at a different Worker, for development or
  staging. Give it a bare origin, like `http://localhost:8788`. That Worker
  must be at least as new as this CLI release, or these break:
  - `ymmv login` requires every field the login response carries: the
    account id, and on a re-login, the server's answer to retiring the
    previous token. When one is missing, it revokes the token it just minted
    and refuses.
  - `YMMV_TOKEN` needs the server's account lookup.
  - `ymmv`, `ymmv set` and `ymmv unset` need the profile lookup they read
    before writing.
- `YMMV_TOKEN` signs you in without a browser, for CI and scripts (see below).
  - It takes precedence over the stored login.
  - The CLI only reads it. It never writes, revokes or deletes it, and
    `ymmv login` and `ymmv logout` keep acting on the stored login.
  - The CLI asks the server which account the token belongs to, and every
    command runs as that account. That includes your side of a
    `ymmv <handle>` diff.
  - The token goes to whichever server `YMMV_API` selects, so set the two
    together.
- `YMMV_HANDLE` is optional, and ignored without `YMMV_TOKEN`. Set it to the
  GitHub username the token belongs to. If the server reports a different
  account, `ymmv -y`, `ymmv set`, `ymmv unset` and `ymmv delete` refuse before
  sending anything, and `ymmv <handle>` shows the profile without a diff.
- `YMMV_NO_UPDATE_CHECK` turns off the startup check for newer releases.
  `NO_UPDATE_NOTIFIER` works too. The check is already off under `CI`, in
  pipes and in dev builds, and it never blocks or fails a command.

## Publishing from CI

`ymmv login` needs a browser, so sign in on your machine and hand the token to
CI:

1. Run `ymmv login` locally.
2. Copy the `token` value from the token file:
   - Linux: `~/.config/ymmv/token.json`
   - macOS: `~/Library/Preferences/ymmv/token.json`
   - Windows: `%APPDATA%\ymmv\Config\token.json`
3. Save it as a CI secret named `YMMV_TOKEN`. Setting `YMMV_HANDLE` to your
   GitHub username is optional. It makes the job fail if the secret ever holds
   another account's token.
4. Run `npx ymmv-cli@latest -y` in the job.

What to expect:

- `ymmv -y` merges your existing profile with what it detects on the machine
  it runs on. Values you already published always win, but keys you've never
  set get the CI runner's detected values, like its OS and shell. For targeted
  updates from CI, use `ymmv set <key> <value>` instead.
- When the merge matches what's live, `ymmv -y` prints `Nothing to publish.`
  and exits 0 without writing, so a scheduled job doesn't move your updated
  date. `ymmv set` does the same for a value the profile already holds.
- A rejected or revoked `YMMV_TOKEN` fails `ymmv -y`, `ymmv set`,
  `ymmv unset` and `ymmv delete` with an error naming the variable. Nothing
  falls back to an interactive login, and any stored login file on the runner
  stays as it was. `ymmv <handle>` still shows the profile, prints why there's
  no diff on stderr, and exits 0.
- `ymmv delete` acts on the account the token belongs to, and names that
  account's page when it asks you to confirm.

## License

MIT. Source and issues: <https://github.com/ymmv-fyi/ymmv>.
