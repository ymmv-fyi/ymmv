# Hero gif for the README. Record it with `pnpm demo` (docs/demo/record.sh), which builds the repo,
# starts a local Worker with a demo account that has never published, and writes docs/demo.gif.

Set Shell bash
# The landing's terminal window (packages/web/src/styles/ymmv.css): --term behind --fg ink, --fg-3
# for the CLI's faint (bright black), and mint for the CLI's accent (bright yellow), as the landing's
# transcript draws it. The other colors are cool neighbors the demo never prints.
Set Theme {"name":"ymmv","background":"#070909","foreground":"#ededed","cursor":"#a3a9ab","selection":"#2a3033","black":"#1c2022","red":"#ff8a80","green":"#6fd3a6","yellow":"#d6c27a","blue":"#7fb0d6","magenta":"#c79bd6","cyan":"#6fd0d0","white":"#a3a9ab","brightBlack":"#858c8e","brightRed":"#ffaaa2","brightGreen":"#8fe8c0","brightYellow":"#3ee6a8","brightBlue":"#9cc6e6","brightMagenta":"#dab4e6","brightCyan":"#8fe2e2","brightWhite":"#ededed"}
# The site's mono face, from docs/demo/fonts: record.sh checks the browser can find it.
Set FontFamily "Geist Mono"
Set FontSize 19
Set TypingSpeed 55ms
Set Width 960
# Tall enough that the last frame shows the whole diff, its command included.
Set Height 694
Set Padding 24
Set Margin 24
# The page's ground (--bg): the accent marks only what changed or differs (DESIGN.md).
Set MarginFill "#050607"
Set BorderRadius 8
Set CursorBlink false
Set WaitTimeout 30s
# shell.sh sets the landing's faint `$` prompt, so a bare Wait looks for `$`, not VHS's `>`.
Set WaitPattern /\$$/

# --- setup (not recorded) ---------------------------------------------------------------------
# shell.sh defines `ymmv`: the repo's build, with the demo stack as its only environment. If it
# fails, `exit` ends the shell and the tape's first Wait fails, so no `ymmv` reaches a global install.
Hide
Type "source docs/demo/shell.sh || exit; clear"
Enter
Sleep 1s
Show

# --- publish: detect, fill the gaps, go live --------------------------------------------------
Type "ymmv"
Enter

# The walk asks only for what detection left empty, in CURATED_KEYS order. Each answer waits for
# its own prompt: a key typed before a question appears is dropped by design.
Wait /Prompt \(e\.g\./
Sleep 1s
Enter                       # Prompt: skip
Wait /Window Manager \(e\.g\./
Sleep 600ms
Enter                       # Window Manager: skip
Wait /Font \(e\.g\./
Sleep 400ms
Type "Lilex"
Enter
Wait /Theme \(e\.g\./
Sleep 400ms
Type "Zedokai Darker (FS)"
Enter
Wait /Multiplexer \(e\.g\./
Sleep 600ms
Enter                       # Multiplexer: skip
Wait /Dotfiles \(a URL\)/
Sleep 400ms
Type "https://git.io/etc"
Enter

Wait /Publish to /
Sleep 2.5s                  # the card: everything detected and typed
Enter                       # publish: the demo account's first profile, on the local Worker
Wait                        # the shell prompt: Wait+Screen reads the buffer's top, not the view
Sleep 2s

# --- view the profile you just published ------------------------------------------------------
Type "ymmv bardisty"
Enter
Wait
Sleep 3s

# --- view a diff against someone else ---------------------------------------------------------
Type "ymmv lottiedottieda"
Enter
Wait
Sleep 5s
