# Changelog

Notable changes to **ymmv** (the `ymmv-cli` package + the ymmv.fyi Worker), newest first.

## [Unreleased]

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
