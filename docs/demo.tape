# Hero gif for the README.
#   vhs docs/demo.tape  →  docs/demo.gif
#   Needs: VHS (https://github.com/charmbracelet/vhs), a built `ymmv` on PATH, already logged in.

Output docs/demo.gif

Set Shell bash
Set Theme "Dark+"
Set FontSize 19
Set TypingSpeed 55ms
Set Width 840
Set Height 560
Set Padding 24
Set Margin 24
Set MarginFill '#e8a33d'
Set BorderRadius 12

# --- publish: detect, confirm, go live ----------------------------------------
Type "ymmv"
Enter
Sleep 2s          # detector runs, then the confirm screen appears

# Enter keeps the detected value; typing overrides it. Fields in CURATED_KEYS order.
Enter             # Editor
Sleep 1s
Enter             # OS
Sleep 1s
Enter             # Shell
Sleep 1s
Enter             # Terminal
Sleep 1s
Type "Zen"        # Browser
Enter
Sleep 1s
Enter             # Window manager
Sleep 1s
Type "Lilex"      # Font
Enter
Sleep 1s
Enter             # Multiplexer
Sleep 1s
Type "github.com/bardisty/dotfiles"   # Dotfiles
Enter
Sleep 1s
Type "Claude Code, Codex"             # AI tools
Enter
Sleep 2s          # POST → live at ymmv.fyi/bardisty
Enter

Sleep 4s

# --- view the profile you just published --------------------------------------
Type "ymmv bardisty"
Enter
Sleep 4s          # prints your profile (viewing someone else adds a diff vs yours)

Sleep 2s
