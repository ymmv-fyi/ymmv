import { describe, expect, it } from "vitest";
import { help } from "../src/index.js";
import { NO_CODES } from "../src/render.js";

// Pins help's plain (color-off) rendering byte-for-byte. This snapshot is the tripwire — a
// styling change that alters the plain text (a stray space around an interpolation, a reflowed
// line) fails here, not in a user's pipe.
const PLAIN_HELP = `ymmv: terminal-native developer tool-stack profiles (ymmv.fyi)

Usage:
  ymmv                      detect your stack, confirm, and publish your profile
  ymmv -y                   publish without prompts (required when stdin isn't a TTY)
  ymmv <handle>             view a profile; logged in, see the diff vs yours
  ymmv view <handle>        explicit view (same as ymmv <handle>)
  ymmv set <key> <value>    set one curated key
  ymmv set --extra "L=V"    set a free-form extra
  ymmv unset <key>          remove one curated key (ymmv set <key> - works too)
  ymmv unset --extra "L"    remove a free-form extra
  ymmv delete               delete your profile (permanent)
  ymmv login | logout       GitHub device-flow auth
  ymmv help | --version

Curated keys: editor, os, shell, prompt, terminal, browser, window-manager,
              font, theme, multiplexer, version-manager, dotfiles, ai-tool`;

describe("help", () => {
  it("plain rendering is byte-identical to the historic unstyled text", () => {
    expect(help(NO_CODES)).toBe(PLAIN_HELP);
  });
});
