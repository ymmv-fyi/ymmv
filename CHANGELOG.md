# Changelog

Notable changes to **ymmv** (the `ymmv-cli` package + the ymmv.fyi Worker), newest first.

## [Unreleased]

### Changed
- **A first `ymmv` shows what it detected before you sign in.** It used to open with a GitHub
  device code. Now the card comes first, then
  `Sign in with GitHub to claim ymmv.fyi/<you>? [Y/n]`, and `n` exits with `Nothing published.`
  A stored login and `ymmv -y` skip the question.
- **`ymmv` and `ymmv delete` need `-y` when their output is piped or redirected.** They used to
  ask anyway, so `ymmv > log.txt` sat at a question you could not see. Both now stop and name
  `-y`. That includes `ymmv | tee log.txt`, which used to ask through `tee`.
- **A first `ymmv` asks only for the fields it could not detect.** It used to ask all 13, with
  the detected values as defaults to Enter through. Now it says how many it found, for example
  `Detected 8 of 13 fields. Enter skips one.`, and asks for the rest: Font, Theme and Dotfiles,
  which are never detected, plus anything your environment does not reveal. The card then shows
  everything, and `e` there changes a detected value.
- **`e` asks which field to edit.** `Which field (Enter for all):` takes a key or a label, and
  a prefix is enough: `font`, `window-manager`, `win`. It asks that one prompt and returns to the
  card. Enter walks all 13 as before.
- **The preview card marks what publishing will change.** Against your live profile, a
  changed row reads `~ Editor    Zed → Neovim`, a new one `+ Font      Lilex`, and a cleared one
  `- Shell     zsh → —`. Unchanged rows look as before, and a first publish has no marks.
- **Running `ymmv` with nothing to change no longer republishes.** The card is followed by
  `Nothing changed. Last published 3d ago.` and the confirm becomes
  `Publish to ymmv.fyi/<you> anyway? [y/N/e=edit]`, so Enter leaves your page and its updated
  date alone. `e` and `d` work from there as before, and `y` publishes anyway.
- **`ymmv -y` and `ymmv set` write nothing when nothing would change.** `ymmv -y` prints the
  card and the same line, with `Nothing to publish.` after it. `ymmv set editor Vim` on a profile
  that already says Vim prints `Editor is already Vim.` Both exit 0, so a scheduled job no longer
  moves your updated date.
- **A prompt with no value to offer shows an example.** The walk asks
  `Prompt (e.g. Starship, Oh My Posh):` and `Dotfiles (a URL):` where it used to ask `Prompt:` and
  `Dotfiles:`. A prompt that already offers a value looks as before.
- **A dotfiles value typed without `https://` is offered as a link.** `github.com/you/dotfiles`
  used to publish as plain text that never links, and so did `you/dotfiles`. The walk and
  `ymmv set dotfiles` now ask `use https://github.com/you/dotfiles? [Y/n]`, and `n` keeps what you
  typed. `you/dotfiles` is read as GitHub only under your own username. Without a terminal, or
  under `YMMV_TOKEN`, `ymmv set` does not ask. It stores the value as typed, and stderr shows the
  command that makes it a link.

### Fixed
- **A detected value is published the way the preview shows it.** Color codes and control
  characters in an environment value such as `$TERM_PROGRAM` or `$EDITOR` are removed before the
  value is offered, where `ymmv -y` and a republish used to store them unseen. A value with
  nothing left is not offered. Values you saved yourself are not touched.

## [0.12.0] - 2026-09-19

### Added
- **`ymmv --reset-marks` forgets the detected values you said no to.** Each one is marked again
  on that run, and the publish goes on as usual.

### Changed
- **`d` asks about each marked value instead of taking them all.** Each marked row gets its own
  question, as `Editor    Zed → Neovim [Y/n]`. `y` takes the detected value and `n` keeps yours.
- **A value you keep with `n` is not marked again.** The CLI remembers the answer on this machine
  until the saved value or the detection changes, and says so after the questions. With no
  marks left, the confirm is `[Y/n/e=edit]` again.
- **The edit walk shows the detection.** A marked row's prompt reads
  `Editor [Zed] (detected: Neovim):`, and Enter keeps your value for that run.

## [0.11.3] - 2026-09-19

### Fixed
- **Running `ymmv` again picks up a value your environment now detects differently.** On a
  republish the preview card marks each such row, as `Editor    Zed  (detected: Neovim)`, and the
  confirm offers `d` to take every marked value before publishing. Saved values still win by
  default, a value you change, clear, or keep in the same run is never marked, and `ymmv -y` is
  unchanged.

## [0.11.2] - 2026-09-19

### Fixed
- **`ymmv set` and the publish prompts refuse a value made only of invisible characters before
  sending it.** A zero-width-only value or extra label is refused locally, the interactive
  publish asks again in place instead of failing after the walk, and `ymmv -y` refuses a
  detected value with no visible text before sending, naming the key to set. `ymmv set` and
  `ymmv unset` name a saved value that no longer passes instead of sending it. A value made
  only of control characters counts as invisible too, on the server as well as in the CLI, and
  a refused extra is named by its position.

## [0.11.1] - 2026-09-18

### Changed
- **Logging in again retires the previous token in the same server step that mints the new one.**
  A login interrupted after the mint can no longer leave the replaced token active, and revoking
  it no longer depends on a second request reaching the server.
- **Link text on the profile card shows the real host.** A user name before the host
  (`user@host`) is dropped from the shown text, the host is shown lowercased, and an
  internationalized host appears in punycode form; the link target is unchanged. The web profile
  and diff pages apply the same rule.

### Fixed
- **`ymmv`, `ymmv set`, and `ymmv unset` no longer overwrite a change made from another
  terminal or device in between.** The server refuses a write when the profile changed after the
  command read it; the interactive publish reloads the profile, keeps your answers, and asks again.
  A first-ever publish is not guarded.
- **`ymmv logout` clears a token file it cannot fully read.** A stored login with a damaged
  handle or account id is still revoked on the server and removed, instead of answering
  "Not logged in" and leaving the token active.
- **`ymmv unset --extra` can remove a label that contains `=`.** When nothing matches, the
  command stays a no-op; if the part before the `=` names a stored extra, it points at that label.

## [0.11.0] - 2026-09-18

### Changed
- **`YMMV_TOKEN` no longer needs `YMMV_HANDLE`.** The CLI asks the server which account the token
  belongs to (`GET /api/v1/auth/whoami`) and runs every command as that account. Under an env
  token, `ymmv <handle>` now diffs against your profile, and `ymmv delete` names your page when
  it asks for confirmation. `YMMV_HANDLE` stays as an optional check: when it names a different
  account than the token, `ymmv -y`, `ymmv set`/`unset`, and `ymmv delete` refuse before sending
  anything, and `ymmv <handle>` shows the profile without a diff.

## [0.10.0] - 2026-09-16

### Fixed
- **A publish retry under a login made with this version cannot land on a different GitHub
  account.** `ymmv login` now records the account id next to the token. When publish re-logs-in
  after a session expiry or a handle change, it compares that id against the new login and refuses
  the retry if the account changed, even when the handle string is the same. The same check runs
  before the first send, so a login that switched accounts while the command was running is
  refused too. A token file written by an older CLI has no id, so its first automatic re-login
  still uses the handle-only check; the re-login records the id. A later `ymmv login` from an
  older CLI drops the id again.

## [0.9.0] - 2026-07-22

### Added
- **The CLI mentions when a newer release exists.** After a command finishes in an interactive
  terminal, a one-line notice on stderr names the newer version, links the release notes, and
  shows the upgrade command (an exact `npx ymmv-cli@<version>` for npx-style runs, since npx
  can keep serving a stale cached copy even for `@latest`). The check asks the npm registry
  about once a day (a failed check retries after six hours), adds at most half a second after
  a command, is silent on every failure, and
  is off in pipes, under `CI`, in dev builds, and with `YMMV_NO_UPDATE_CHECK` or the standard
  `NO_UPDATE_NOTIFIER` set.
- **`ymmv update` updates the CLI.** It runs the matching upgrade for npm, pnpm, and bun global
  installs, prints the invocation to re-run for npx-style runs, and prints all three commands
  when the install method is unclear rather than guessing. `update` joins the reserved handles
  like every other command word.
- **`ymmv version` notes a newer release.** A recent check adds a `latest:` line pointing at
  `ymmv update`, on stderr in interactive terminals only; the stdout version line is unchanged
  for scripts.

### Changed
- **Install instructions pin `npx ymmv-cli@latest`.** Every copyable invocation (READMEs, the
  site's install commands, profile pages) now carries `@latest`, since a bare `npx ymmv-cli`
  can keep running an old cached copy indefinitely.

## [0.8.0] - 2026-07-19

### Added
- **`YMMV_TOKEN` authenticates without a browser.** Setting `YMMV_TOKEN` (plus `YMMV_HANDLE`
  for publish and set/unset) lets CI and scripts run `ymmv -y` with a token minted by a local
  `ymmv login`. The env token takes precedence over the stored login, is never written or
  deleted by the CLI, and a rejected value fails with the variable named; `ymmv login` and
  `ymmv logout` keep acting on the stored login. The README documents the recipe and the token
  file location.
- **`ymmv version` and `ymmv publish` work as commands.** The bare words now dispatch like
  their flag and default forms, and both names are reserved handles so the words can never
  collide with a profile.
- **Value caps are enforced before the network.** `ymmv set` rejects values over 256 characters
  and extra labels over 64 locally, a 33rd extra is refused with the cap named, and an over-long
  answer in the interactive publish re-asks that one field instead of failing after all the
  prompts. The caps are documented in the README.
- **Logging in again revokes the replaced token.** A repeat `ymmv login` retires the previous
  session's token on the server when it is reachable, and a login against a different `YMMV_API`
  base warns before the stored token is overwritten.

### Fixed
- **Stray arguments error instead of being silently ignored.** `ymmv -y delete` errors with an
  ordering hint instead of publishing, `ymmv delete <handle> -y` errors instead of deleting the
  caller's profile unprompted, and login/logout/version/view/bare-handle forms error instead of
  dropping extra arguments. `ymmv help` still accepts anything after it, and `set`/`unset`
  still join multi-word values.
- **Capitalized verbs point at the command.** `ymmv Set` now suggests `ymmv set` instead of
  only reporting a reserved name.
- **A failed publish no longer discards your interactive answers.** The edit loop prints the
  error and returns to the confirm step with everything you typed intact; deterministic
  refusals (an account switch mid-command) still exit.
- **Server rejections explain themselves.** Publish and delete failures show the server's
  message instead of a raw status and body dump, every server-side validation error now
  carries one, login failures name the cause instead of an internal code, and a stale CLI
  reading a newer profile says to upgrade.
- **`ymmv logout` reports the right failure.** A revoke the server refused says so instead of
  claiming the server was unreachable.
- **The automatic re-login during publish says why.** A session expiry or handle change prints
  one line of context before the device-flow prompt appears.
- **A repeated handle conflict stops advising a re-login.** When publish has already re-logged
  in and retried, the CLI says the conflict persists instead of repeating the server's
  "run `ymmv login` and retry".
- **`FORCE_COLOR=false` disables color.** It previously force-enabled ANSI output, inverting the
  supports-color convention the CLI follows; `false` now behaves like `0`.
- **A misconfigured `YMMV_API` reports itself.** A scheme-less, path-mounted, or otherwise
  invalid value errors up front naming the variable, instead of surfacing later as a
  connectivity failure.
- **A corrupt token file reads as logged out.** A hand-edited or truncated token.json triggers a
  clean re-login instead of a wrong "reserved word" message or a crash, and the token inside is
  still revoked on the next login.
- **Viewing a profile no longer suggests publishing when your own profile merely failed to
  load.** The diff is skipped with a note; the publish nudge stays for accounts that have never
  published.

### Changed
- **Help documents `ymmv delete -y` and the `-e` shorthand for `--extra`.** The README command
  list gains the same forms.

## [0.7.0] - 2026-07-11

### Added
- **Reserved names fail fast.** `ymmv 404` (or `ymmv view api`) reports the name is reserved
  locally instead of asking the server and answering with a missing profile.
- **Requests time out after 30 seconds.** A stalled connection reads as a clear
  "Can't reach ... (request timed out)" line instead of hanging, and a hung login poll retries
  instead of stalling forever.

### Fixed
- **Publish conflicts show the server's explanation.** A publish refused because the handle is
  bound to another account prints the server's message instead of a generic handle-taken line.

## [0.6.2] - 2026-07-09

### Fixed
- **`404` is now a reserved handle.** The site serves its own page at `/404`, so the handle could
  be published but never viewed.
- **Extras labels and values are trimmed, and blank ones are rejected.** Padded labels no longer
  render padded. A label or value with nothing visible in it, whether empty, whitespace, or
  zero-width characters, is refused instead of stored as an empty row.

## [0.6.1] - 2026-07-02

### Changed
- **Every CLI message shares the card's spacing.** Confirmations (`Published`, `Set`, `Removed`,
  `Deleted`), aborts, login/logout lines, notes, and errors print indented two spaces with one
  blank line of separation, and every run ends with a single blank line. `ymmv help` and
  `ymmv --version` keep their flush-left layout.
- **Failed runs keep stdout clean.** Errors and their closing blank line go to stderr, so
  piping or capturing a failed command's stdout doesn't pick up a stray blank line.

### Fixed
- **Rate-limit messages no longer echo a malformed `retry-after` header:** the retry hint prints
  only for the standard seconds form.

## [0.6.0] - 2026-07-02

### Added
- **Republishing is one keypress.** `ymmv` shows your merged profile card first; Enter
  publishes, `e` edits the fields, `n` aborts. First-time publish keeps the guided prompts,
  now with a hint: Enter to keep the shown value, `-` to clear it.
- **Links are clickable.** URLs render amber as terminal hyperlinks, shortened like the web
  (`git.io/etc`). Piped and NO_COLOR output keeps full plain URLs.
- **Ctrl+C cleanly aborts any prompt** (exit 130) instead of hanging, and login now says it's
  waiting for your GitHub approval.

### Changed
- **The card and diff match the web page:** `ymmv.fyi/<handle>` header, `updated 3h ago`, a
  title line over the diff, uppercase column headers. With `YMMV_API` set, every printed URL
  shows that Worker's host.
- **`ymmv -y` skips the prompts entirely**, as help always said: card, then publish. Detection
  can re-fill a field you previously cleared; run `ymmv` interactively when that matters.
- **`set`/`unset` reply with one line** ending in a pointer at your live page (the extra
  `Published` echo is gone).

### Fixed
- **Offline errors are readable:** `Can't reach ymmv.fyi. Check your connection (…)` instead
  of a raw `fetch failed`, and a network blip no longer kills a login you already approved.
- **A 401-retry publish can no longer land on a different GitHub account** when the re-login
  binds one; it refuses instead of silently overwriting.

## [0.5.0] - 2026-07-02

### Added
- **Three new curated keys: `prompt`, `theme`, `version-manager`.** Prompt renderer (Starship,
  Oh My Posh, …), colorscheme (Catppuccin, Gruvbox, …), and version manager (mise, nvm, …) are
  first-class, diffable fields now. API consumers: `entries[].key` gains the three new values —
  additive, same response shape.
- **Detection covers much more of the stack:**
  - Window manager on Linux: Hyprland, Sway, i3, niri via their sockets; GNOME, KDE Plasma,
    COSMIC, Cinnamon, MATE, XFCE, LXQt, Budgie, Pantheon, Unity via XDG session vars.
  - AI tool, when publishing from inside one: Claude Code, Cursor, Codex, Gemini CLI, opencode,
    Amp, GitHub Copilot.
  - Prompt renderer: Starship, Oh My Posh, Powerlevel10k, Spaceship, Tide.
  - Version manager: mise, asdf, nvm, fnm, Volta, proto, pyenv, rbenv.
  - Browser from `$BROWSER`; dispatchers (`xdg-open` and friends) are ignored, not published.
  - More terminals: kitty, GNOME Terminal, GNOME Console, Tilix, Terminator, ConEmu, mintty,
    xterm, foot, JetBrains, and Cursor (distinguished from VS Code). Exact self-identifying
    `$TERM` values (`xterm-kitty`, `foot`, `alacritty`, `xterm-ghostty`) count as a last resort;
    generic terminfo names still never do.
  - Editor, inferred from the surrounding host when `$VISUAL`/`$EDITOR` are unset: Neovim/Vim
    terminals, Emacs, VS Code, Cursor, Zed.
  - Linux distro names: `os` reads `/etc/os-release`, so a profile says "Arch Linux" instead of
    "Linux". WSL labeling is unchanged.

### Changed
- **Non-interactive `ymmv` now requires `-y`.** Without a terminal there is no confirm step, so
  the explicit flag is the consent — `ymmv delete` already worked this way. Interactive publishes
  are unchanged.
- **Publish flags duplicate extras.** When a free-form extra (`Theme=…`) duplicates a curated
  field, publish prints the `ymmv unset --extra` cleanup hint.

### Fixed
- **Top-level cmd.exe sessions no longer detect as "PowerShell".** `PSModulePath` is machine-wide
  on Windows; the detector now reads its first segment (PowerShell prepends the user's Documents
  module dir) and recognizes cmd by its own `PROMPT`. Nested sessions still inherit the parent's
  markers (a cmd started from PowerShell reads as PowerShell) — confirm-prompt correctable.
- **A bare `ymmv` republish no longer drops fields published by a newer CLI.** Unknown keys ride
  through the full-replace publish verbatim and are listed under the preview. CLIs 0.4.0 and older
  still rebuild from their own key list — update before republishing, or a bare `ymmv` from an old
  install drops the new fields (`set`/`unset` were never affected).

## [0.4.0] - 2026-07-02

### Added
- **`ymmv unset <key>` removes a curated field from your profile.** `ymmv unset --extra "Keyboard"`
  removes a free-form extra.

### Changed
- **`ymmv set <key> -` now clears the field.** Extras too: `ymmv set --extra "Keyboard=-"`.

### Fixed
- **Publishing from a stale or switched login now refuses instead of writing to the wrong
  profile.** Covers a second device still bound to an old handle after a GitHub rename, and a
  login change mid-command; the CLI points to `ymmv login`.

## [0.3.0] - 2026-07-01

### Fixed
- **Light theme no longer shows a dark band past the bottom of short pages on mobile.** The page
  canvas and the browser UI (`theme-color`) now follow the active theme.
- **The landing example now matches real profiles:** Dotfiles renders under Stack (it's a curated
  field), not Extras.
- **Publishing right after seeing "no ymmv profile for you yet" now shows your diff.** That nudge
  page was cached with the long-lived policy, so a freshly published viewer could be served the
  stale nudge; it now stays short-cached like a 404.
- **A malformed stored extra can no longer break a profile page.** Bad rows are dropped on read
  instead of erroring the whole page.

### Changed
- **Diffs now mark both differing values in amber** — on the web and in the CLI — not just your
  column. A difference is symmetric; neither side is the "wrong" one.
- **Diff pages navigate:** both handles in the header link to their profiles, and the summary line
  gains a `swap →` link to flip the comparison.
- **Extras now appear under a web diff** in a dimmed "not compared" list, matching the CLI (they
  were silently omitted before).
- **Profile pages gained a click-to-copy command and an inline `diff vs <you>` box** — type any
  handle to jump straight to the diff; the handle is remembered for next time, invalid handles
  are rejected before navigating, and the form still works when scripts are blocked.
- **`https://` URLs display without the scheme** (`github.com/you/dotfiles`), so they wrap cleanly
  on phones; links keep the full URL, `http://` stays visible (a cleartext target is worth seeing),
  and a diff never renders two different values as the same string. Long handles in diff column
  headers ellipsize instead of wrapping letter-by-letter.
- **Dimmed text is brighter in both themes** to clear WCAG AA contrast — section labels, shared
  diff rows, and footers were below 4.5:1.
- **Keyboard focus is clearly visible on every control** — focus rings that survive Windows
  forced-colors mode (the `diff vs` text box signals focus with its caret and accent underline,
  and gains a ring in forced-colors) — and the theme toggle's touch target now meets the 44px
  guideline.
- Diff pages ship a diff-specific share description instead of the generic site blurb.

## [0.2.0] - 2026-07-01

### Changed
- **Stack diffs now compare by tool identity, not exact text.** Two profiles that list the same tool
  with different casing, spacing, or a common synonym now count as a match instead of a difference —
  `Firefox` = `firefox`, `VS Code` = `vscode`, `JetBrains Mono` = `JetBrainsMono`, `nvim` = `Neovim`.
  Genuinely different tools still differ (Vim ≠ Neovim, Chrome ≠ Chromium, macOS 15.2 ≠ 15.4), and a
  `dotfiles` URL is still compared exactly (case and path matter). Values are shown exactly as you
  typed them; only the match logic changed.

## [0.1.5] - 2026-06-30

### Security
- **The `ymmv` credential directory is now created private (0700).** The saved token file was already
  owner-only (0600), but the enclosing `~/.config/ymmv` directory was world-traversable, so another
  local user could see that a ymmv credential existed. It's now locked to your user, and an older
  directory left more open is tightened on the next save. POSIX only — Windows relies on your per-user
  profile permissions.
- **External links on a profile page no longer leak the referring URL.** Links to your published
  dotfiles/other URLs now carry `rel="noreferrer"`, so the destination site no longer receives which
  ymmv.fyi page the visitor came from. (Reverse-tabnabbing was already blocked by `noopener`.)
- **Sign-in and sign-out no longer follow HTTP redirects.** A redirect can't trick the CLI into
  re-sending your GitHub token to another location or reading a redirect as a successful sign-out.
  Hardening only — the production service doesn't redirect these requests.

### Fixed
- **A brief GitHub hiccup during sign-in no longer aborts the whole login.** If GitHub returned a
  transient error while the CLI was waiting for you to authorize the device code, login used to fail
  outright; it now keeps polling through the blip. A sustained outage or a blocking proxy fails fast
  with a clear message instead of hanging until the code expires.
- **The CLI validates profile data it fetches.** A malformed response (e.g. from a custom `YMMV_API`
  endpoint) now fails with a clear error instead of crashing partway through a diff.

## [0.1.4] - 2026-06-30

### Security
- **Sign-in now verifies your GitHub token was actually issued to ymmv.** The device-flow sign-in
  endpoint used to trust any valid GitHub access token's identity — so a token leaked, or phished for a
  *different* OAuth app, could be used to mint a ymmv session for that account. Sign-in now verifies each
  token belongs to ymmv's own GitHub app (token introspection) and rejects foreign or invalid tokens.
  Signing in through the `ymmv` CLI is unchanged.
- **Sign-in is rate-limited.** The mint endpoint now caps requests per identity and per client IP, so it
  can't be hammered to inflate the database or amplify calls to GitHub. The CLI shows a clear "too many
  login attempts — try again shortly."

### Notes
- Residual (unchanged): a token obtained by phishing a victim into authorizing ymmv's *own* app still
  validates — this is inherent to the GitHub device flow and out of scope for this change.

## [0.1.3] - 2026-06-30

### Fixed
- **Reclaiming a recycled GitHub username locked the new owner out of publishing.** After GitHub
  freed a username a prior ymmv user had renamed away from, the new owner could sign in but every
  `ymmv set` returned "handle taken" and `ymmv.fyi/<handle>` kept redirecting to the previous owner.
  A GitHub-proven sign-in now clears the stale ownership record, so the rightful owner publishes
  immediately.

## [0.1.2] - 2026-06-29

### Fixed
- **`ymmv delete` and `ymmv logout` 403'd.** The Worker's CSRF check blocked the CLI; disabled it
  (bearer-token API, no CSRF surface). Publish and sign-in were unaffected.

## [0.1.1] - 2026-06-29

### Fixed
- **`ymmv` did nothing on Linux, macOS, and WSL.** A global install (`npm i -g ymmv-cli`) and
  `npx ymmv-cli` install the binary as a symlink, which tripped a faulty "am I being run directly?"
  check and made the command exit silently. It now runs no matter how it's installed or invoked.
  Windows was unaffected.

## [0.1.0] - 2026-06-29

### Added
- **`ymmv-cli`** — the command-line tool. `ymmv` detects and publishes your stack; `ymmv <handle>`
  views anyone's, and diffs it against yours when you're logged in; plus `set`, `delete`, `view`,
  `login`, and `logout`. Honors `NO_COLOR`. Published to npm with build provenance and bundled
  self-contained, so `npx ymmv-cli` needs nothing installed.
- **Profile page** — a typography-led page at `ymmv.fyi/<handle>` in light and dark, with a
  side-by-side diff at `ymmv.fyi/<handle>/vs/<viewer>`.
- **Open JSON API** — every profile is data too: `GET /api/v1/u/<handle>`, versioned (each payload
  carries a `schema_version`) so integrations don't break.
- **GitHub sign-in** — passwordless device flow. Tokens are revocable and tied to your GitHub
  account; `logout` revokes them server-side.
- **Rate limiting** — a per-identity cap on writes, plus an edge rule that sheds high-volume traffic
  before it reaches the Worker.
- **CI/CD** — every PR is linted, type-checked, and tested (unit + browser e2e); tagging a release
  publishes the CLI with provenance and deploys the site per environment, after a staging dry-run.

[0.12.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.12.0
[0.11.3]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.11.3
[0.11.2]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.11.2
[0.11.1]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.11.1
[0.11.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.11.0
[0.10.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.10.0
[0.9.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.9.0
[0.8.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.8.0
[0.7.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.7.0
[0.6.2]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.6.2
[0.6.1]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.6.1
[0.6.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.6.0
[0.5.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.5.0
[0.4.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.4.0
[0.3.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.3.0
[0.2.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.2.0
[0.1.5]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.5
[0.1.4]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.4
[0.1.3]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.3
[0.1.2]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.2
[0.1.1]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.1
[0.1.0]: https://github.com/ymmv-fyi/ymmv/releases/tag/v0.1.0
