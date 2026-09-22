# Hero gif for the README.
#   vhs docs/demo.tape  →  docs/demo.gif
#   Needs: VHS (https://github.com/charmbracelet/vhs), a built `ymmv` on PATH, already logged in,
#   and no published profile yet (the prompts below are a first publish's).

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
Sleep 2s          # detector runs, then the gap prompts appear (first publish)

# A first publish asks only for what detection left empty: Font, Theme and Dotfiles on a machine
# where the other ten are detected. Detection that misses a key adds its prompt here, in
# CURATED_KEYS order, so check the run by hand before recording.
Type "Lilex"                # Font
Enter
Sleep 500ms
Type "Gruvbox"              # Theme
Enter
Sleep 500ms
Type "https://git.io/etc"   # Dotfiles
Enter
Sleep 2s          # preview card + publish prompt render
Enter             # accept → POST → live at ymmv.fyi/bardisty

Sleep 2s

# --- view the profile you just published --------------------------------------
Type "ymmv bardisty"
Enter

Sleep 4s          # prints your profile (viewing someone else adds a diff vs yours)

# --- view a diff --------------------------------------------------------------
Type "ymmv lottiedottieda"
Enter

Sleep 6s
