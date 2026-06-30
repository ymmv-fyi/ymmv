# Hero gif for the README
#
# Generate:  vhs docs/demo.tape   →   writes docs/demo.gif
# Requires:  VHS (https://github.com/charmbracelet/vhs) and a built/linked `ymmv` on PATH.

Output docs/demo.gif

Set Shell bash
Set FontSize 18
Set Width 1100
Set Height 660
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms

# --- publish: detect, confirm, go live ------------------------------------------------
Type "ymmv"
Enter
Sleep 3s          # env detector runs; the confirm screen appears
Enter             # accept the detected stack
Sleep 3s          # POST → live at ymmv.fyi/<handle>
Sleep 1s

# --- view the live profile you just shared ------------------------------------------
Type "ymmv bardisty"
Enter
Sleep 4s          # the profile prints in the terminal (a diff, when you view someone else)

Sleep 2s
