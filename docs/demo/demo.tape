# Hero gif for the README. Record it with `pnpm demo` (docs/demo/record.sh), which builds the repo,
# starts a local Worker with a demo account that has never published, and writes docs/demo.gif.

Set Shell bash
Set Theme "Dark+"
Set FontSize 19
Set TypingSpeed 55ms
Set Width 960
Set Height 560
Set Padding 24
Set Margin 24
Set MarginFill '#e8a33d'
Set BorderRadius 12
Set WaitTimeout 30s

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
