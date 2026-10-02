# Hero gif for the README. Record it with `pnpm demo` (docs/demo/record.sh), which builds the repo,
# starts a local Worker with a demo account that has never published, and writes docs/demo.gif.

Set Shell bash
# The site's terminal window (the --term-* colors in packages/web/src/styles/ymmv.css): its ink, its
# faint for the CLI's faint (bright black) and its amber for the CLI's amber (bright yellow). The
# other colors are warm neighbors the demo never prints.
Set Theme {"name":"ymmv","background":"#16130e","foreground":"#ece7dc","cursor":"#c4bdae","selection":"#352e22","black":"#272219","red":"#e0735f","green":"#a3b86c","yellow":"#d9a441","blue":"#7f9fc2","magenta":"#c492b8","cyan":"#82b5a9","white":"#c4bdae","brightBlack":"#8a8272","brightRed":"#ef8a76","brightGreen":"#b7cc80","brightYellow":"#ffab2e","brightBlue":"#97b4d4","brightMagenta":"#d6a8ca","brightCyan":"#99c9bd","brightWhite":"#ece7dc"}
# The site's body face, from docs/demo/fonts: record.sh checks the browser can find it.
Set FontFamily "IBM Plex Mono"
Set FontSize 19
Set TypingSpeed 55ms
Set Width 960
# Tall enough that the last frame shows the whole diff, its command included.
Set Height 640
Set Padding 24
Set Margin 24
# The page's ground: amber marks only links and differences (DESIGN.md).
Set MarginFill "#0e0c09"
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
