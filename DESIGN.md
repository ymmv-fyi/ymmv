# ymmv design system — "Divergence"

Canonical source for the web UI (`packages/web`) and the conventions the CLI mirrors. The code
cites this file; keep it truthful when tokens or rules change (the e2e spec pins the values below).

## Concept

The brand is the fork. YMMV: two people share most of the road and split at specific tools. Every
signature element derives from that one idea — a field of parallel roads where one forks and the
diverging branch turns amber. The aesthetic is a technical document meets a terminal: an engineered
spec sheet (hairlines, registration ticks, caps ledger labels) with one editorial serif voice
inside an otherwise all-mono machine. Dark is primary (warm ink); light is a printed spec sheet on
warm paper.

## Typography

Three voices, all self-hosted via Astro's Fonts API (`astro.config.mjs`):

| var | family | role |
|---|---|---|
| `--font-display` | Martian Mono (variable wght 400–800) | the loud machine voice: wordmark, handles |
| `--font-mono` | IBM Plex Mono (400/500/600) | the quiet machine voice: body, data, UI, code |
| `--font-serif` | Instrument Serif (400 italic ONLY) | the human voice: "Your mileage may vary." and at most one aside per page |

Rules: `--font-serif` ships italic-only — always pair it with `font-style: italic` or browsers
synthesize a roman. Do not request Martian Mono's wdth axis (unifont drops the `font-stretch`
descriptor from Google css2 responses; the axis silently clamps to 100%).

### Loading

Fonts are fetched and subset at build time and emitted as hashed immutable same-origin
`/_astro/fonts/*.woff2` assets — no runtime third-party requests. Exactly three preloads (one per
family; IBM Plex Mono filters to 400@latin, its body face), pinned by the e2e suite as the tripwire
for a silent font-degradation build. Metric-matched fallbacks are generated (optimizedFallbacks).
Licenses: `packages/web/public/fonts/LICENSES.md`.

## Color tokens

Both themes swap the same names on `html[data-theme]`. `--bg` must stay a plain hex — the theme
toggle syncs `meta[name=theme-color]` from the raw token, and the no-FOUC script keeps char-for-char
hex literals (four places must agree: Layout meta, no-FOUC literals, these tokens, the e2e spec).

| token | dark (warm ink) | light (warm paper) | note |
|---|---|---|---|
| `--bg` | `#0e0c09` | `#f6f3ea` | |
| `--surface` | `#16130e` | `#fffdf8` | cards, raised controls |
| `--text` | `#ece7dc` (15.8:1) | `#1a1712` (16.1:1) | |
| `--mid` | `#c4bdae` (10.5) | `#454035` (9.3) | hero secondary tier |
| `--muted` | `#9a927f` (6.3) | `#5c564a` (6.6) | labels, notes |
| `--faint` | `#8a8272` (5.1) | `#6e6759` (5.1) | real content (shared diff rows) — must clear AA 4.5:1 on bg AND surface |
| `--hairline` | `#272219` | `#e4decd` | rules, table rows |
| `--border-raised` | `#352e22` | = hairline | control borders |
| `--accent` | `#ffab2e` (10.3) | `#8e5d0b` (5.1) | amber — see scarcity rule |

Ratios are WCAG contrast against `--bg` (verified 2026-07-07, also checked against `--surface`).

### The amber scarcity rule (load-bearing)

Amber marks ONLY links and diff differences. Never spend it on emphasis, CTAs, prompts, or
decoration — with two deliberate exceptions: the fork motif itself (hero field branch, the fork
glyph on the diff heading, favicon/OG mark), because the fork IS the diff; and the one amber
nudge (`.nudge`, see Components & States), because it mirrors the CLI's `nudge()`. A difference is
symmetric: both differing values go amber plus the row dot; same rows recede to `--faint`.

CLI parity: the CLI renders the same semantics with ANSI bright yellow (`packages/cli/src/render.ts`)
— amber-only-on-difference, em-dash for a missing side, "N differ / N shared" wording, "how X
differs from Y" heading. Change one surface, mirror the other.

## The divergence motif

- **Hero field** (landing): thin horizontal roads; occasionally one forks and the branch flashes
  amber. Static SVG in the server markup (currentColor) is the no-JS / reduced-motion /
  forced-colors render; `src/scripts/divergence.ts` swaps in a canvas only when motion is allowed,
  pauses off-screen and on hidden tabs, and pulls toward the install CTA on hover.
- **Fork glyph** (`.fork`): the inline brand mark — a road and a branch. Amber on the diff
  heading; muted elsewhere. Also the favicon mark. The junction dot appears ONLY in field renders
  (canvas, hero SVG, OG card) where it reads as a spark at the split; at glyph/icon sizes it
  fattens the junction into a blob, so the small marks go without it.
- **Ratio bar** (`.diff-foot .ratio`): a minimap of the diff table — one segment per row, in row
  order, amber where the stacks split. Decorative (aria-hidden), no anchors, no text.

## Landing layout

The landing is a display surface, not a document: it earns the wide grid (`--content-wide`,
1080px, via `body.wide`, engaging at ≥1080px viewports — the same gate as the artifact pair, so
narrower screens keep the 680px column) while the reading pages (profile/diff) stay on the
canonical 680px document column. Two-zone hero on wide screens: the pitch holds a readable left column
(`.hero-copy`, max 620px); the right zone belongs to the divergence field, whose mask re-centers
there (and always fades out under the fixed theme toggle).

The narrative is three numbered artifacts, not prose-then-pictures — `// 01 run it` (the CLI
transcript), `// 02 your stack becomes a page` (profile preview), `// 03 diff against anyone`
(the diff). Each label carries a short hairline lead-in between index and title, then the
trailing rule runs to the container edge. Each fact appears once, as the real thing. On the wide
grid 02 and 03 pair up asymmetrically (profile narrow-left, diff wide-right) with a COMMITTED
stagger: the 03 label drops ~120px, level with the profile card's handle, so the page reads on a
01 → 02 → 03 diagonal. Magnitude is load-bearing — a 56px offset was tried and read as
misalignment; go big or go aligned. Below 1080px they stack in narrative order.

Sample truncation rule: a preview earns rows only until the shape is clear, then declares the rest
with an honest `+ N more` marker (`.spec-more`). The diff shows in full — it is the product.

**CLI transcript sample** (`.term`): a static illustration of the real publish flow. Its copy
mirrors actual CLI output (`packages/cli/src/render.ts` + `commands.ts` — CLI parity: change the
CLI's wording, update the transcript). Amber marks exactly what the CLI renders amber (the
published link); scaffolding sits in `--faint`, typed input and values in ink.

## Ornament budget

Grain (one small feTurbulence tile at 4%, fixed overlay, never above the theme toggle), hairline
rules, two registration ticks per `.sample` card (top-left + bottom-right), `//` section-mark
prefixes (CSS `::before` — never in textContent), caps ledger labels. Nothing else; restraint is
the identity.

## Components & States

- **Spec sheet** (`table.spec`): caps 11px labels at `--label-col`, 15px mono values on shared tab
  stops, hairline rows. Group headers (`.group-h`) carry a trailing hairline rule to the column
  edge — the same section-label dress as the landing's `.example-label`. URL values render
  scheme-stripped with the full URL in `title`, gated through `safeHref`. The live profile
  document is plated in a `.sheet` card (same frame + registration ticks as the landing's
  `.sample`); the interactive foot (install pill, make-yours, diff-vs) sits OUTSIDE the plate —
  raised controls on a raised surface would lose their lift.
- **Diff** (`table.diff`): 30/35/35 fixed layout set on the thead; both differing values amber +
  label dot (presence, not just hue — WCAG 1.4.1) + sr-only "differs:/same:" prefixes; missing
  side is an em-dash glyph; extras render dimmed below, uncompared and never amber. Like the
  profile, the live diff document (heading, table, foot, extras) is plated in a `.sheet` card —
  the swap link is a text link, so it stays inside the plate.
- **Install command** (`.install`): click-to-copy prompt pill. Exactly two glyphs earn their
  place: the `$` (says "terminal") and the copy icon (says "clickable") — no decorative caret;
  three ornaments on one command is one too many. Never a dead control — the copy affordance
  appears only when the Clipboard API is wired.
- **Diff-vs form** (`.diff-cta`): raised panel with the fork glyph; input is a hairline-underlined
  slot, accent underline on focus.
- **Empty / 404** (`.empty`): the road forks into nothing — faint fork mark, plain-ink message
  ("no ymmv profile for <handle>"), install CTA. No accent spend.
- **Nudge** (`.nudge`): the ONE amber call-to-action, mirroring the CLI's `nudge()` ("the one
  amber nudge", `packages/cli/src/render.ts`) — the deliberate exception to empty-state
  accent-scarcity on both surfaces.
- **Revision stamp** (`.rev`): profiles date themselves — "updated YYYY-MM-DD" under the handle.

## Motion

One strong ease-out (`--ease-out`) for entering/press motion; hover color changes keep plain
`ease`. Reduced-motion: fewer and gentler, not zero — kill the page fade, press scales, and the
canvas (static SVG stays); keep opacity/color feedback.

## Copy

No em dashes in user-facing prose (the missing-value `—` glyph is exempt). Never the `·`
separator anywhere user-facing — whitespace does the separating. Web UI copy draws its arrows:
the inline SVG glyph (`Arrow.astro`, same stroke family as the fork), never the `→` character —
which belongs to CLI output, and to the landing transcript that mirrors it byte-for-byte.
Sentences open with a capital; fragments stay lowercase. Counts read "N differ" and "N shared"
as words set apart by whitespace, never punctuation soup. The serif voice gets complete
sentences only. Page titles are URL-shaped — the title IS the address (`ymmv.fyi/<handle>`,
`ymmv.fyi/<handle>/vs/<you>`), the same identity line the profile breadcrumb and the CLI print;
the landing alone carries a subtitle (`ymmv.fyi: your stack, in the terminal`).
