# ymmv design system

Canonical source for the web UI (`packages/web`) and the conventions the CLI mirrors. The code
cites this file; keep it truthful when tokens or rules change (the e2e spec pins the values below).

## Concept

A dark, product-first site in the register of developer platforms: Geist on near-black, solid
hairlines, one white primary action, and the product shown big. The landing's sky is a live
aurora (the TypeGPU lab's Borealis concept), and the site's one accent comes out of it: mint,
which marks only what changed or differs. Dark only: there is no light theme and no toggle.

## Typography

Two faces, self-hosted via Astro's Fonts API (`astro.config.mjs`):

| var | family | role |
|---|---|---|
| `--font-sans` | Geist (variable wght 400–600) | headings, body, UI |
| `--font-mono` | Geist Mono (variable wght 400–500) | commands, transcripts, code, table column heads, small labels |

Headings are Geist 600 with tight negative tracking (h1 −0.045em, h2 −0.04em) and balanced wraps.
Monospace is for things that are typed or printed by a terminal, never for headings.

### Loading

Fonts are fetched and subset at build time and emitted as hashed immutable same-origin
`/_astro/fonts/*.woff2` assets — no runtime third-party requests. Exactly two preloads (one per
family, latin; latin-ext loads on demand), pinned by the e2e suite as the tripwire for a silent
font-degradation build. Metric-matched fallbacks are generated (optimizedFallbacks). Licenses:
`packages/web/public/fonts/LICENSES.md`.

## Color

Tokens live on `:root` in `packages/web/src/styles/ymmv.css`. `--bg` is mirrored in three
places that must agree: the token, Layout's `theme-color` meta, and the hero palette in
`src/gpu/aurora-hero.ts` (so the canvas meets the page with no seam). The e2e spec pins `--bg` and
`--mint`.

| token | value | note |
|---|---|---|
| `--bg` | `#050607` | page |
| `--bg-2` | `#0a0c0d` | bars, chips |
| `--panel` | `#0c0f10` | windows, panels, the readout card |
| `--term` | `#070909` | terminal panes |
| `--line` / `--line-2` / `--line-3` | `#1c2022` / `#2a3033` / `#3d4549` | solid hairlines (alpha borders glow on near-black) |
| `--fg` | `#ededed` (17.3) | text |
| `--fg-2` | `#a3a9ab` (8.5) | secondary text |
| `--fg-3` | `#858c8e` (5.9) | labels, receding rows; the floor for real content |
| `--mint` | `#3ee6a8` (12.6) | the accent — see the rule below |

Ratios are WCAG contrast against `--bg` (computed 2026-11-11; all clear AA on `--panel` too).

### The accent rule (load-bearing)

Decided 2026-11-12, after the landing run left it open: mint marks differences only, and links stay
ink. Mint marks ONLY what changed or differs: both values of a differing diff row plus its dot, the
update preview's `~ + -` marks and incoming values, and the published link
in the landing's transcript (the CLI prints it in its accent). Links are never mint: a link in
running text is ink with a hairline underline that strengthens on hover. The logo mark carries the
aurora ramp, which includes mint; that is the brand, not the accent. A difference is symmetric:
both differing values go mint plus the row dot; same rows recede to `--fg-3`. A row only one side
filled in is no difference: it recedes too, keeping a grey dot.

CLI parity: the CLI renders the same diff semantics in its own accent, ANSI bright yellow
(`packages/cli/src/render.ts`). The surfaces share the meaning, not the hue — the accent on a
difference and nowhere else in the diff, em-dash for a missing side, "N differ / N shared /
N only <handle>" wording, "how X differs from Y" heading. Change one surface's semantics, mirror
the other. Outside the diff the CLI also puts links in its accent, because a terminal has no
underline to tell a link apart; the web underlines its links instead. The card's
`ymmv.fyi/<handle>` breadcrumb and the diff's page line name the web page each mirrors, and with
color on each is an OSC 8 link to it. The web's breadcrumb links its `ymmv.fyi` home instead,
because there the page is already open. The publish preview's breadcrumb is not a link: before a
first publish there is no page. One deliberate difference: the CLI's `nudge()` is in its accent,
while the web's nudge (`.nudge`) is a neutral callout, since a call to action is not a difference.

Long values part ways, because a terminal can't break a cell between path segments the way the
web's narrow column does. On a terminal the CLI caps both value columns to the width. A cut cell
ends in `…`, and a URL being cut drops `https://` first. Two cut columns get the same width, so an
`=` row never shows two different-looking cuts. Widths are terminal columns: a CJK character or
an emoji takes two, and a cut never splits one. The lines around the table fit where they can.
With color on, the page line's text is cut and its link keeps the whole address (plain, it
prints whole). An extras line cuts its value and never its owner. The count line breaks between
its counts, and the heading breaks before `differs from`. A handle is cut only in a column head,
so a very long one can still wrap a narrow terminal. A piped diff is never cut, and pads by
`.length` (UTF-16 code units) as it always has. With color on, a URL cell is shortened and is an
OSC 8 link to the full address. The link takes the row's color, because in the diff the accent
means "differs". That includes extras, whose links stay faint (the web's extras link is ink, but
the web underlines it). Both surfaces keep one rule for a differing row: its two cells never look
the same because of a shortening or a cut. When they would, the CLI drops the shortening, or
shows both cells from just before the first character that differs. When two cells would still
look the same, both surfaces show each invisible character (a zero-width space, a bidi control)
as `�` in that row, marked before any cut so the cut keeps it in view. Same rows and the card
never mark.

The CLI's publish preview compares the card against the live profile and marks each differing
row in the gutter: `~` changed, `+` new, `-` cleared. That is the no-color vocabulary plus two
glyphs. The glyph prints in both color modes, since three kinds cannot share the accent dot. The
glyph and the incoming value are in the accent, because a change against live is a diff
difference. The outgoing value and its arrow are faint. The web has no publish preview; the
landing's "Update with the same command" tile shows a sample of it.

## Brand

- **Logo mark** (`.logo-mark`, `public/favicon.svg`): a rounded tile of the aurora ramp
  (`--aurora-hi` → `--mint` → `--aurora-deep`) with one diagonal cut in `--bg`. Beside it, the
  wordmark "ymmv" in Geist 600. The favicon, `favicon.ico`, `apple-touch-icon.png` and `og.png` are
  rendered from the same mark; the OG card is the live hero (claim + sky + `ymmv.fyi`), rendered at
  1200×630.
- **The sky**: the landing hero's Borealis canvas (`src/gpu/`), palette deep cyan → mint → near
  white on `--bg`; the shaders are plain WGSL in `src/gpu/aurora.wgsl`. It thins out behind the hero
  copy (`aurora-hero.ts` measures the copy every frame).

## Layout

- **Site nav** (Layout): logo, API docs, Privacy, the GitHub icon. Sticky; clear at the top of the
  page, a blurred backdrop and a hairline once content scrolls under it. On the landing it also
  carries the install command, shown only once the hero's own copy has scrolled away (one primary
  action, always in reach, never shown twice); on a phone it replaces the GitHub icon.
- **Reading pages** (profile, diff, privacy, 404) sit in a 760px column; the landing's sections
  run to 1180px.
- **Site footer** (Layout): one row — the logo, then API docs, Source, Issues, npm, Changelog,
  Privacy.

## Landing

Decided 2026-11-11 from `/proto/site` (five directions, then four rounds on the winner, the aurora-sky
direction). Top to bottom:

- **Hero**: the claim is the h1 (`.claim`, "Your dev setup, published in one command."), the
  sub-line (detects ten values, shows the list, publishes when you say yes), the install command
  as the white primary (`InstallCommand tone="primary"`), "or see a live one → ymmv.fyi/bardisty",
  and the requirements line. Over the sky; on a phone the copy starts below a band of it. The
  detection claim is exact: the CLI detects ten keys (editor, shell, terminal "and seven more");
  font, theme and dotfiles are typed. Never claim more than `detect.ts` sets.
- **The window** (`.shot`): one window overlapping the bottom of the sky, split into the terminal
  pane (`TerminalRun.astro`: the real publish run, copy mirroring the CLI) and the page pane (the
  production `Profile` component in example mode, truncated with an honest `+ N more`). The bar's
  divider runs on into the panes. One depth cue: the border plus one shadow.
- **"It asks before it publishes."**: a 2×2 hairline grid with crosshair marks at its outer
  corners — ten values detected (chips), review the draft (the `e`/`n`/`y` keys), update with the
  same command (a sample of the publish preview's `~ + -` marks), change or delete (the commands).
- **"See where your setups split."**: text beside a panel rendering the production `Diff`
  component in example mode (octocat against hubot, both fictional mascots, through the real
  `diff()`), so the preview can't drift from a live diff page.
- **"Your page is JSON too."**: a curl and its response, beside a link to the API contract.
- **The last line is the brand's**: "Your mileage may vary." over "Run it and see how your setup
  compares." (so the phrase reads as the diff the visitor just scrolled past, not a disclaimer),
  and the install command again.

The intro — the command types itself and the lines land in order — plays once per session
(`sessionStorage`) and never under reduced motion; the finished run is the server markup. The sky
is the only other motion.

Rejected in the run. Round 1, five directions: "Band" (the previous House landing with the
embers as a hero band — a restyle, not a redesign), "Film" (a serif title card and end credits),
"Room" (the embers fixed behind a one-session transcript column), "Lens" (a camera viewfinder
with a real focus ring, Archivo condensed) and the aurora sky (chosen). Within it: section kickers
above each heading (repeated their headings), Geist Mono headings and the fork logo (both pulled
from the old Divergence system — the fork read as git), a three-column "How it works" without
tiles (the 2×2 tiles read better), an "Open source CLI" eyebrow with a live dot (decoration posing
as status), traffic-light window dots, a mint glow on the window, a status badge on the API panel,
and "Get started" in the nav (replaced by the nav command).

Earlier landings — the Divergence "House" (2026-09-14) and its predecessors — are superseded.

## Pages

- **Profile** (`Profile.astro`; decided 2026-11-11 from `/proto/profile`, direction "Compare"):
  the diff is the page's hero. Top to bottom: `ymmv.fyi/` as a small label over the handle (the
  h1), an absolute "Updated 28 Jun 2026" (edge-cached pages must not serve stale relative times),
  the compare form, the stack, the extras, and a foot with two copy commands ("Publish your own",
  "View in your terminal").
  - **Compare form**: "How does your setup compare with <handle>’s?", a labelled 16px input, the
    white "Compare" button, and Clear once compared. Submitting fetches the visitor's profile from
    `/api/v1/u/<you>` and turns the stack into a side-by-side comparison in place: a column for
    the visitor, mint values and a dot on differing rows, shared rows receding by color only, the
    "N differ / N shared / N only <handle>" counts, and "Open the full diff →" to
    `/<handle>/vs/<you>`. Compared cells are built by `lib/diff-cells.ts`, exactly as the diff
    page builds them (bidi stripped, the `�` marker, shortened URLs with the full address in the
    title, path-segment breaks). The input is prefilled from `ymmv-you`, the handle the visitor
    last compared with; the page never compares on its own. "Comparing…" holds the button's
    width and blocks a second submit. A bad handle gets three signals (a `--danger` border, an
    icon, the message) and clears the moment the value becomes valid. A handle with no profile
    shows the install command right under the message. `Escape` clears a comparison. With no JS,
    the form submits `?you=`, which the page redirects to the full diff (and an invalid one renders
    the error server-side). The handler's normalization and the script's must stay identical.
  - **Stack**: a real `<table>`; on its own, 17px medium values in ink beside 14px labels, so it
    holds up before anyone compares. URL values render with `https://` dropped (`http://` stays)
    and the parsed host, the full URL in `title`, gated through `safeHref`.
  - **Extras**: headed "Extras" with the note "Lines added by hand. A diff doesn’t compare them.",
    on the stack's label edge, so a second "Dotfiles" among them explains itself.
  - Rejected in the run: "Spec" (the stack as tiles beside a sticky action rail; polished but
    passive, and on a phone the compare action lands under thirteen tiles) and "Readme" (a
    sentence generated from the stack and the stack in editorial groups; charming once, but the
    groups are a ranking the person never chose and the sentence goes thin on sparse profiles).
    Before that, the port of the old Divergence transcript ("a restyle, not a redesign").
- **Diff** (`Diff.astro`; decided 2026-11-12 from `/proto/diff`, direction "Ledger"): the
  profile's compared table, grown into its own page, so the inline compare and the full diff are
  one shape. Most visitors arrive from a shared link or the URL the CLI prints, and see the same
  table every profile uses. Top to bottom: the h1 "how X differs from Y" in the CLI's words (the
  connectives in `--fg-3`, the handles in ink, each linking its profile), the copy command
  `npx ymmv-cli@latest <theirs> vs <mine>` right under it, the counts with "Swap sides →" on the
  right, the table, then the extras. Rows keep the taxonomy order, the profile's and the CLI's.
  - **Table** (`table.diff`): the profile stack's type (17px medium values, 14px labels, Geist
    Mono 13px handle heads that ellipsize, the full handle in the h1 and the `title`), a 30% label
    column (`--diff-label`; 112px under 400px so "Multiplexer" stays on one line), a hairline per
    row, named by the h1 (`aria-labelledby`). Row semantics: both differing values mint + the label
    dot (presence, not just hue: WCAG 1.4.1) + sr-only "differs:/same:" prefixes. A row only one
    side filled in (`tr.o`) recedes like a shared row, keeps a grey dot, carries "only <handle>:",
    and counts apart as `N only <handle>` after `N shared`, left out at 0. A missing side is an
    em-dash glyph hidden from screen readers, which hear "not set". With no rows at all (neither
    side has a stack) one line says so in place of the table.
  - **Extras**: below, headed "Extras" with the profile's note, grouped by owner under each
    handle, values on the table's value edge, `--fg-2` and a step smaller than compared values,
    never mint. A self-diff lists them once.
  - **Landing example**: the same component with `example`: the h1 becomes a `<p>`, the handles
    are plain text, and the command, swap link and extras drop out.
  - Rejected in the run: "Sorted" (rows grouped by verdict with the counts as section headings and
    a shared value said once; it answers "where do we differ?" first, but reorders rows per pair
    so no two diffs line up with each other, the profile or the CLI, and adds four headings to a
    13-row table that the dots already scan well) and "Mirror" (labels down a center spine with
    values facing outward; the most distinctive, but on a phone the values lose their column edge,
    long left values jam the spine, and it needs CSS grid on table rows). Also dropped: the old
    session layout and its one-glyph-per-row minimap, a Divergence holdover.
- **Privacy** (`/privacy`): what the server, the browser and the CLI keep, written from the code.
  A reading page: the `ymmv.fyi/privacy` address as the title like a profile, prose in `--fg-2`,
  sentence-case h2s, identifiers (`code`, `b`) in ink, links ink over an underline. Plain
  statements only: each one names code that does it, so a change to that code re-reads the page.
- **Empty and 404** (`NotFound.astro`): the handle (or "404") as the h1, "no ymmv profile for
  <handle> yet." with the URL-derived handle isolated against bidi controls, and the install
  command. No accent.
- **Nudge** (`.nudge`): on `/<handle>/vs/<you>` when `<you>` hasn't published. The visitor came
  for a diff, so the reason there isn't one comes first: a neutral callout ABOVE the viewed profile,
  "No ymmv profile for <you> yet." over "If that’s you, publish yours and this page becomes the
  diff." and the install command. The command is the call to action, so the old arrow that
  pointed at nothing is gone. No accent: a call to action is not a difference.

## Components & States

- **Install command** (`InstallCommand.astro`, `.install`): a plain `<span>` that Layout's script
  promotes to an ARIA button once the Clipboard API is wired (`data-copy-ready`), so it is never a
  dead control. Two glyphs earn their place: the `$` (says "terminal", unselectable) and the copy
  glyph in a concentric box (says "clickable"), which morphs to a check on success while a live
  region announces it. Tones: default (dark, for the commands on profile and diff pages) and
  `primary` (the white button, the landing only); sizes default (40px to the eye, a 44px hit area),
  `sm` (the nav, 34px with a 44px hit area) and `lg` (the closing CTA).
- **Focus**: one neutral 2px outline for every link, control and text input.
- **Press**: controls scale to 0.96 on press; never under reduced motion.

## Motion

Strong ease-out (`--ease`) for entering and press motion; hover color changes keep plain `ease`
at 150ms. The sky renders only while the hero is on screen and the tab is visible; under reduced
motion it holds a still frame. Reduced motion also drops the intro and the press scales; color
feedback stays. No scroll-triggered animation anywhere.

## Copy

No em dashes in user-facing prose (the missing-value `—` glyph is exempt). Never the `·`
separator anywhere user-facing — whitespace does the separating. Web UI copy draws its arrows:
the inline SVG glyph (`Arrow.astro`), never the `→` character — which belongs to CLI output, and to
the landing transcript and preview sample that mirror it byte-for-byte. Sentences open with a
capital; fragments stay lowercase. Counts read "N differ", "N shared" and "N only <handle>" as
words set apart by whitespace, never punctuation soup. "differ" counts only fields both sides
filled in, with different values. Page titles are URL-shaped — the title IS the address
(`ymmv.fyi/<handle>`, `ymmv.fyi/<handle>/vs/<you>`), the same identity line the profile title and
the CLI print; the landing alone carries a subtitle (`ymmv.fyi: your stack, in the terminal`).
