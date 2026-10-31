import { describe, expect, it } from "vitest";
import { help } from "../src/index.js";
import { NO_CODES } from "../src/render.js";

// Pins help's plain (color-off) rendering byte-for-byte. This snapshot is the tripwire — a
// styling change that alters the plain text (a stray space around an interpolation, a reflowed
// line) fails here, not in a user's pipe.
const PLAIN_HELP = `ymmv: terminal-native developer tool-stack profiles (ymmv.fyi)

Usage:
  ymmv                      detect your stack, confirm, and publish your profile
  ymmv -y                   skip the prompts (required when piped or redirected)
  ymmv --reset-marks        forget dismissed detection marks, then publish
  ymmv <handle>             view a profile; logged in, see the diff vs yours
  ymmv view <handle>        explicit view (same as ymmv <handle>)
  ymmv <a> vs <b>           how a's stack differs from b's (no login needed)
  ymmv set <key> <value>    set one curated key
  ymmv set --extra "L=V"    set a free-form extra (-e works too)
  ymmv unset <key>          remove one curated key (ymmv set <key> - works too)
  ymmv unset --extra "L"    remove a free-form extra
  ymmv delete [-y]          delete your profile for good (-y skips the confirm)
  ymmv login [-y]           log in, or see who you are (-y logs in again)
  ymmv logout               log out
  ymmv update               update ymmv-cli to the latest release
  ymmv help | version

Curated keys: editor, os, shell, prompt, terminal, browser, window-manager,
              font, theme, multiplexer, version-manager, dotfiles, ai-tool

Environment:
  YMMV_TOKEN                sign in without a browser, for CI and scripts
  YMMV_HANDLE               the GitHub username the token belongs to (optional)
  YMMV_API                  point the CLI at a different Worker
  NO_COLOR                  turn color off (FORCE_COLOR=0 works too)
  YMMV_NO_UPDATE_CHECK      turn off the startup check for newer releases

Docs: https://github.com/ymmv-fyi/ymmv/blob/main/packages/cli/README.md`;

describe("help", () => {
  it("plain rendering is byte-identical to the historic unstyled text", () => {
    expect(help(NO_CODES)).toBe(PLAIN_HELP);
  });

  // An 80-column terminal shows every line whole, whatever the styling.
  it("fits 80 columns, line by line", () => {
    const wide = help(NO_CODES)
      .split("\n")
      .filter((line) => line.length > 80);
    expect(wide).toEqual([]);
  });
});
