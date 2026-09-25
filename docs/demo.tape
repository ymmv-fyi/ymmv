# Hero gif for the README.
#   pnpm -r build && vhs docs/demo.tape  →  docs/demo.gif   (run from the repo root)
#   Needs: VHS (https://github.com/charmbracelet/vhs; 0.10.0 works, 0.12.0 wrote no gif here),
#   ffmpeg, ttyd, node, a login stored for the built CLI, and NO published profile for that
#   account (the walk below is a first publish's; `ymmv delete -y` resets it, then `ymmv login`).
#   Record on Linux or WSL: VHS on native Windows exits 0 without writing the gif.

Output docs/demo.gif

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
# `ymmv` is the repo's build, not a global install. Detection reads only the environment, so
# every variable it knows is cleared and the demo stack set, the same on any machine: 7 of 13
# fields detected (OS is the recording machine's), and the walk asks for the other 6.
Hide
Type `[ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; YMMV_BIN="$PWD/packages/cli/dist/cli.js"; ymmv() { node "$YMMV_BIN" "$@"; }`
Enter
Type `unset EDITOR NVIM VIM_TERMINAL INSIDE_EMACS CURSOR_TRACE_ID CURSOR_AGENT ZED_TERM TERMINAL_EMULATOR WT_SESSION KONSOLE_VERSION ALACRITTY_WINDOW_ID ALACRITTY_SOCKET KITTY_WINDOW_ID KITTY_PID GNOME_TERMINAL_SERVICE GNOME_TERMINAL_SCREEN TILIX_ID TERMINATOR_UUID ConEmuANSI ConEmuPID XTERM_VERSION TMUX ZELLIJ STY STARSHIP_SHELL STARSHIP_SESSION_KEY POSH_SHELL POSH_SESSION_ID POSH_THEME P9K_TTY _P9K_TTY SPACESHIP_VERSION __MISE_ORIG_PATH ASDF_DIR ASDF_DATA_DIR PROTO_HOME VOLTA_HOME FNM_MULTISHELL_PATH FNM_DIR NVM_DIR PYENV_SHELL PYENV_ROOT RBENV_SHELL RBENV_ROOT HYPRLAND_INSTANCE_SIGNATURE NIRI_SOCKET SWAYSOCK I3SOCK XDG_CURRENT_DESKTOP DESKTOP_SESSION KDE_FULL_SESSION KDE_SESSION_VERSION AGENT CODEX_THREAD_ID GEMINI_CLI OPENCODE COPILOT_CLI`
Enter
Type `export VISUAL=zed SHELL=/bin/bash TERM_PROGRAM=WarpTerminal BROWSER=zen MISE_SHELL=bash CLAUDECODE=1 YMMV_NO_UPDATE_CHECK=1; clear`
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
Enter                       # publish → live at ymmv.fyi/<you>
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
