import { readFileSync } from "node:fs";
import { revokeYmmvToken } from "./auth-http.js";
import { type InteractiveIO, publish, runDelete, runSet, runUnset, view } from "./commands.js";
import { BASE, baseProblem, credentialEnvProblem } from "./config.js";
import { login } from "./device-flow.js";
import { isTimeoutError, NetworkError } from "./http.js";
import { makePrompter } from "./prompt.js";
import { type Codes, colorEnabled, message, palette, sanitizeValue } from "./render.js";
import { resolveArg } from "./resolve.js";
import { deleteToken, loadToken, peekBase } from "./token-store.js";

// Styled at print time; with color off the output is byte-identical to the historic plain text
// (pinned by the help snapshot test). The curated key names must stay LITERAL in this source —
// help.test.ts greps this file to keep the list in sync with CURATED_KEYS.
export const help = (
  c: Codes,
): string => `${c.bold}ymmv${c.reset}: terminal-native developer tool-stack profiles (ymmv.fyi)

${c.faint}Usage:${c.reset}
  ymmv                      detect your stack, confirm, and publish your profile
  ymmv -y                   publish without prompts (required when stdin isn't a TTY)
  ymmv <handle>             view a profile; logged in, see the diff vs yours
  ymmv view <handle>        explicit view (same as ymmv <handle>)
  ymmv set <key> <value>    set one curated key
  ymmv set --extra "L=V"    set a free-form extra (-e works too)
  ymmv unset <key>          remove one curated key (ymmv set <key> - works too)
  ymmv unset --extra "L"    remove a free-form extra
  ymmv delete [-y]          delete your profile (permanent; -y skips the confirm)
  ymmv login | logout       GitHub device-flow auth
  ymmv help | version

${c.faint}Curated keys:${c.reset} editor, os, shell, prompt, terminal, browser, window-manager,
              font, theme, multiplexer, version-manager, dotfiles, ai-tool`;

// `ymmv logout` — revoke server-side, THEN delete the local file. If the revoke fails, KEEP the
// local token (deleting it would orphan a still-active token; revoke-all is post-v1) and tell the
// user to retry — but tell the TRUTH about why: a connectivity failure (NetworkError / a body-read
// timeout) gets "couldn't reach", while a server-reached failure (revokeYmmvToken's own
// `logout failed: <status>` / bad-200-body throws) must not blame the user's connection.
// A token for a different base is left untouched (base-scoping).
async function logout(): Promise<void> {
  const stored = await loadToken();
  if (!stored) {
    const otherBase = await peekBase();
    console.log(
      message(
        otherBase && otherBase !== BASE
          ? `Not logged in to ${BASE} (a token for ${sanitizeValue(otherBase)} exists; set YMMV_API to that to log out of it).`
          : "Not logged in.",
      ),
    );
    return;
  }
  let revoked: boolean;
  try {
    revoked = await revokeYmmvToken(stored.token);
  } catch (e) {
    console.error(
      message(
        e instanceof NetworkError || isTimeoutError(e)
          ? "Couldn't reach the server to revoke. Your token is still active. Run `ymmv logout` again when connected."
          : "The server didn't confirm the revoke. Your token is still active. Run `ymmv logout` again shortly.",
      ),
    );
    process.exitCode = 1;
    return;
  }
  await deleteToken();
  console.log(message(revoked ? "Logged out." : "Logged out (no active session on this server)."));
}

function printVersion(): void {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    console.log(`ymmv-cli ${pkg.version ?? "unknown"}`);
  } catch {
    console.log("ymmv-cli (version unknown)");
  }
}

// Run an interactive command, wiring a real prompter only on a TTY (pipes/CI publish non-interactively).
async function interactive(run: (io: InteractiveIO) => Promise<void>, yes: boolean): Promise<void> {
  const isTTY = Boolean(process.stdin.isTTY);
  const prompter = isTTY ? makePrompter() : undefined;
  try {
    await run({ interactive: isTTY, prompter, yes });
  } finally {
    prompter?.close();
  }
}

export async function main(argv: string[]): Promise<void> {
  const cmd = resolveArg(argv);
  // Config gate before dispatch (help/version included): a broken YMMV_API or YMMV_TOKEN should
  // fail with its real diagnosis at the first opportunity, not lie dormant until a network verb
  // wraps the failure in "Check your connection". EXCEPT logout: it only needs BASE to hit the
  // revoke URL that worked when the token was minted, gating it would permanently strand tokens
  // stored under bases the gate now rejects (older CLIs accepted them) — and logout is env-blind
  // (file token only), so a malformed env credential must not strand it either.
  if (cmd.kind !== "logout") {
    const problem = baseProblem() ?? credentialEnvProblem();
    if (problem) {
      console.error(message(problem));
      process.exitCode = 1;
      return;
    }
  }
  switch (cmd.kind) {
    case "publish":
      await interactive(publish, cmd.yes);
      break;
    case "view":
      await view(cmd.handle);
      break;
    case "set":
      await runSet(cmd.target);
      break;
    case "unset":
      await runUnset(cmd.target);
      break;
    case "delete":
      await interactive(runDelete, cmd.yes);
      break;
    case "login": {
      await login();
      // Standalone login only — an ensureLogin() mid-publish must not say "run ymmv" while it runs.
      const c = palette(colorEnabled());
      console.log(message(`${c.faint}next: run ymmv to publish your stack${c.reset}`));
      break;
    }
    case "logout":
      await logout();
      // True on every branch above (revoked, nothing stored, or a failed revoke): the env token
      // is not the CLI's to revoke or unset, so "logged out" must not read as "unauthenticated".
      if (process.env.YMMV_TOKEN) {
        console.error(
          message(
            "Note: YMMV_TOKEN is set and still authenticates API calls. Unset it to stop using that token.",
          ),
        );
      }
      break;
    case "help":
      console.log(help(palette(colorEnabled())));
      break;
    case "version":
      printVersion();
      break;
    case "error":
      console.error(message(cmd.message));
      process.exitCode = 1;
      break;
  }
}
