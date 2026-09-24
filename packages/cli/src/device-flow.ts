import { GITHUB_CLIENT_ID } from "@ymmv/shared";
import { mintYmmvToken, revokeYmmvToken } from "./auth-http.js";
import { findLauncher, type Launcher } from "./browser.js";
import { BASE } from "./config.js";
import { causeText, isTimeoutError, REQUEST_TIMEOUT_MS, safeFetch, wireText } from "./http.js";
import type { Prompter } from "./prompt.js";
import { type Codes, colorEnabled, link, message, palette, sanitizeValue } from "./render.js";
import { peekCredential, saveToken } from "./token-store.js";

// GitHub device flow. The CLI talks to github.com directly; the resulting access token is handed to
// the Worker, which verifies the token's audience (introspection) and mints the ymmv token (the CLI
// never calls /user itself). GITHUB_CLIENT_ID (public, no secret in device flow) is the single source
// of truth in @ymmv/shared — the Worker introspects against the SAME id, so the two must never drift.

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
}

// RFC 8628's default poll interval; also GitHub's mandated slow_down increment (they share the
// value by protocol coincidence — keep the two uses honest if either ever diverges).
const DEFAULT_POLL_INTERVAL_S = 5;

/** A usable wire poll interval: finite, at least 1s, at most the device-code lifetime. Everything
 *  else reaches setTimeout as a hot-poll: NaN/strings as a 0ms timer, sub-second fractions as
 *  near-continuous polling, and anything past ~2^31-1 ms via Node's overflow clamp to 1ms. */
function usableInterval(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 900;
}

// Injectable for deterministic tests of the poll state machine (no real timers/clock/network).
export interface PollDeps {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Request a device + user code from GitHub. */
export async function requestDeviceCode(deps: PollDeps = {}): Promise<DeviceCode> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const res = await safeFetch(
    DEVICE_CODE_URL,
    {
      method: "POST",
      headers: { accept: "application/json" },
      body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID }),
    },
    "github.com",
    doFetch,
  );
  if (!res.ok) {
    throw new Error(`device code request failed: ${res.status} ${wireText(await res.text())}`);
  }
  // Shape-check before use: a captive-portal/proxy 200 with the wrong body must read as a clear
  // error, not crash link() on undefined or turn a missing expires_in into a NaN deadline. A
  // body-read TIMEOUT is rethrown instead — it must print as a timeout, not "unexpected response".
  const data = (await res.json().catch((err: unknown) => {
    if (isTimeoutError(err)) throw err;
    return null;
  })) as Partial<DeviceCode> | null;
  if (
    !data ||
    typeof data.device_code !== "string" ||
    typeof data.user_code !== "string" ||
    typeof data.verification_uri !== "string" ||
    // expires_in gets the same rigor as interval: NaN makes the deadline NaN (instant false
    // "expired"), Infinity/1e300 make it unreachable (a middlebox feeding parseable
    // authorization_pending bodies would hold the login forever - the deadline is the only exit).
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    data.expires_in > 86_400 ||
    (data.interval !== undefined && !usableInterval(data.interval))
  ) {
    throw new Error("GitHub sent an unexpected device-code response. Run `ymmv login` again.");
  }
  return data as DeviceCode;
}

/**
 * Poll GitHub until the user authorizes (→ GitHub access token), denies, or the code expires.
 * Honors slow_down backoff: GitHub mandates +5s and may send a larger `interval`.
 */
export async function pollForToken(dc: DeviceCode, deps: PollDeps = {}): Promise<string> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;

  // Self-defending even though requestDeviceCode is the only in-repo producer: pollForToken is
  // exported, and a foreign caller's 0/garbage interval must not become a hot loop.
  let interval = usableInterval(dc.interval) ? dc.interval : DEFAULT_POLL_INTERVAL_S;
  const deadline = now() + dc.expires_in * 1000;
  // GitHub returns EVERY device-flow protocol outcome (authorization_pending / slow_down /
  // access_denied / expired_token) as HTTP 200 + JSON, so a non-ok status or a non-JSON body is a
  // transient infra blip (a proxy 5xx, an HTML error page), never an auth verdict. Keep polling
  // through it instead of aborting the whole login — but give up after a run of them so a PERSISTENT
  // failure (a corporate proxy 403/407, a GitHub outage) fails fast with a clear message instead of
  // hanging silently until the code expires. The real OAuth errors below stay fatal.
  let transientFailures = 0;
  let lastCause = "";
  const MAX_TRANSIENT_FAILURES = 5;
  while (now() < deadline) {
    await sleep(interval * 1000);
    // Re-check AFTER the sleep too: with moments left on the code, sleeping a full (possibly
    // slow_down-grown) interval and then holding a request up to REQUEST_TIMEOUT_MS would overrun
    // the deadline by half a minute — report expired instead of polling a dead code.
    if (now() >= deadline) break;
    // A THROWN fetch (wifi blip, DNS hiccup mid-poll) is the same class of transient as a proxy
    // 5xx — flow it into the counter instead of crashing a login the user already approved.
    let res: Response | undefined;
    try {
      res = await doFetch(TOKEN_URL, {
        method: "POST",
        headers: { accept: "application/json" },
        body: new URLSearchParams({
          client_id: GITHUB_CLIENT_ID,
          device_code: dc.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        // GitHub answers this endpoint immediately — slow_down pacing lives in the sleep above,
        // never inside a held request — so the per-request timeout can't cut pacing short. It only
        // turns a HUNG poll into a TimeoutError feeding the transient counter (previously a hang
        // here stalled the login forever: the deadline is only checked between iterations).
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastCause = causeText(err);
    }
    let tok: { access_token?: string; error?: string; interval?: number } | undefined;
    if (res?.ok) {
      try {
        tok = (await res.json()) as { access_token?: string; error?: string; interval?: number };
      } catch (err) {
        tok = undefined;
        // A body-read timeout is still transient here (the counter owns give-up), but label it
        // truthfully — causeText maps the TimeoutError; anything else is a malformed body.
        lastCause = isTimeoutError(err) ? causeText(err) : "unexpected response body";
      }
    } else if (res) {
      lastCause = `HTTP ${res.status}`;
    }
    if (tok === undefined) {
      if (++transientFailures >= MAX_TRANSIENT_FAILURES) {
        throw new Error(
          "GitHub isn't responding to the login poll. Check your connection and run " +
            `\`ymmv login\` again.${lastCause ? ` (last error: ${lastCause})` : ""}`,
        );
      }
      continue;
    }
    transientFailures = 0;
    if (tok.access_token) return tok.access_token;
    switch (tok.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        // The wire interval is typed number but arrives untrusted: a mangled string would turn
        // Math.max into NaN, and a huge value overflows setTimeout into a 1ms clamp — either way
        // a 0ms hot-poll with no recovery. Unusable values are ignored; the mandated +5s applies.
        interval = usableInterval(tok.interval)
          ? Math.max(tok.interval, interval + DEFAULT_POLL_INTERVAL_S)
          : interval + DEFAULT_POLL_INTERVAL_S;
        break;
      case "access_denied":
        throw new Error("Authorization denied. Run `ymmv login` to try again.");
      case "expired_token":
        throw new Error("Device code expired. Run `ymmv login` again.");
      default:
        throw new Error(`device flow failed: ${wireText(tok.error ?? "unknown error")}`);
    }
  }
  throw new Error("Device code expired. Run `ymmv login` again.");
}

/** The one page the browser offer ever opens, and only when GitHub's reply names exactly it (it
 *  always does). No wire bytes reach an opener: some re-parse their argument (wslview hands it to
 *  PowerShell inside double quotes, where `$(...)` runs), and a forged reply must not be able to
 *  aim Enter at another github.com page, such as an OAuth authorize page for someone's app. */
const DEVICE_PAGE = "https://github.com/login/device";

/** What the offer puts on the clipboard: GitHub's user codes look like WXYZ-1234. Anything else
 *  off the wire is not copied, and the offer then does not promise a copy. */
const COPYABLE_CODE = /^[A-Za-z0-9-]{4,16}$/;

function launchNote(copied: boolean, opened: boolean): string | undefined {
  if (!copied && !opened) return "couldn't copy the code or open a browser; use the link above";
  if (!copied) return "couldn't copy the code; type it in";
  if (!opened) return "couldn't open a browser; use the link above";
  return undefined;
}

/**
 * Poll with the browser offer up (#78). The poll does not wait for the offer, so approving through
 * the printed link needs no Enter, and GitHub's answer, whatever it is, withdraws the offer. The
 * work Enter starts is never awaited. Once the offer is withdrawn no further step starts (a copy
 * or open already running finishes on its own), and no note prints after "Logged in".
 *
 *   offer ─┬─ Enter ─► copy (if copyable) ─► open ─► faint note on a failure (each: if still up)
 *          ├─ ^C ────► the prompter's idle exit (130), as in the wait itself
 *          └─ ^D / withdrawn ─► false
 *   poll ──► settles ─► withdraw the offer ─► await the question only
 */
async function pollWithOffer(
  dc: DeviceCode,
  deps: PollDeps,
  prompter: Prompter,
  launcher: Launcher,
  code: string,
  c: Codes,
): Promise<string> {
  const copy = COPYABLE_CODE.test(code) ? launcher.copy : null;
  const line = copy
    ? "Press Enter to copy the code and open github.com in your browser."
    : "Press Enter to open github.com in your browser.";
  // The code request was a wait: a key pressed during it must not answer the offer.
  prompter.discardTypeahead();
  const withdraw = new AbortController();
  // A failed input (a stdin error) only loses the offer, never the login. A misuse bug (another
  // question pending) throws from offer() itself, before the poll starts.
  const asked = prompter.offer(line, withdraw.signal).catch(() => false);
  void asked
    .then(async (pressed) => {
      const { signal } = withdraw;
      if (!pressed || signal.aborted) return;
      // Copy first: the code must be on the clipboard before the browser takes focus.
      const copied = copy ? await copy(code) : true;
      if (signal.aborted) return; // GitHub answered during the copy: no stale tab
      const opened = await launcher.open(DEVICE_PAGE);
      const note = launchNote(copied, opened);
      // Tight under the offer line: readline's Enter already ended it.
      if (note && !signal.aborted) console.log(`  ${c.faint}${note}${c.reset}`);
    })
    .catch(() => {}); // an optional side task: nothing here may crash the login it rides on
  try {
    return await pollForToken(dc, deps);
  } finally {
    withdraw.abort();
    await asked;
  }
}

/** A stored credential login and logout can retire on THIS server: same base, and a token that is
 *  more than whitespace (a hand-edited file). Sent as `revoke`, a blank token would draw a 400
 *  from the Worker and wedge every login; sent to logout, it parses as no bearer at all. Shared
 *  with `ymmv logout` so the two commands agree on what counts as a stored login. */
export function retirable(
  cred: { base: string; token: string } | null | undefined,
): cred is { base: string; token: string } {
  return cred != null && cred.base === BASE && cred.token.trim() !== "";
}

export interface LoginDeps extends PollDeps {
  /** The command's prompter, given only with a terminal on both ends. The browser offer asks
   *  through it: publish keeps its readline open through the sign-in, and a second readline on
   *  the same stdin would fight it for every key. */
  prompter?: Prompter;
}

/**
 * Full login: device flow → mint a ymmv token → store it (0600, scoped to the API base).
 * `deps` is for tests (inject sleep/now/fetch); production passes only the prompter.
 *
 * With a prompter and a browser on this machine (not over SSH, an opener found), the device flow
 * offers to open github.com under the waiting line (see pollWithOffer). Without either, it prints
 * exactly the two lines it always has.
 *
 * A previously stored token is handled around the overwrite (server mint is multi-token, so an
 * unrevoked predecessor stays live with no local reference left to revoke it by):
 *
 *   peek ── other base? ─► warn (stderr): the file will be replaced, log out there first
 *   device flow ─► peek R (the flow took minutes; a concurrent login may have written a fresh
 *   token) ─► mint, revoke: R (the Worker retires R in the SAME D1 batch that inserts the new
 *   token N: no window where both are live) ─► RE-peek R2 ─► saveToken
 *     ├─ ok ───► R2 is a same-base token other than R or N (a login raced us between the two
 *     │          peeks)? revoke R2 client-side, best effort (fail: faint note)
 *     └─ fail ─► revoke NEW; the file is left as it was (R is already retired, so its next 401
 *                heals it; a racer's R2 stays live on purpose)
 *
 * The client-side revoke is the leftover for racing logins only; the normal path is atomic on the
 * server. It runs AFTER the save so a failed save adds no second orphan, and a failed revoke never
 * blocks the login. A login that writes between the RE-peek and the rename is still overwritten
 * live: that residual window (two logins racing AND a kill in it) is what issue #58 leaves open,
 * closable only by a lock file around peek → mint → save. peekCredential (not loadToken) on
 * purpose: a corrupt handle in the file reads as logged-out everywhere else, but the token inside
 * may still be live.
 */
export async function login(deps: LoginDeps = {}): Promise<void> {
  // The device flow needs a human to read a code and visit a URL, so it cannot complete without a
  // terminal. Refuse fast in a piped/CI/non-TTY context instead of printing a code nobody reads and
  // blocking on the ~15-minute GitHub poll. (publish/set/delete reach here via ensureLogin.)
  if (!process.stdin.isTTY) {
    throw new Error(
      "Device login needs an interactive terminal. Run `ymmv login` in a real terminal " +
        "(a piped or CI shell can't complete the GitHub device flow).",
    );
  }
  // Warn BEFORE the device flow burns a round trip: the saved login stays shadowed while the env
  // token wins every credential read. Diagnostic, so stderr; the user can Ctrl+C here.
  if (process.env.YMMV_TOKEN) {
    console.error(
      message(
        "YMMV_TOKEN is set and takes precedence over stored logins. This login will be saved " +
          "but not used until you unset it.",
      ),
    );
  }
  const prior = await peekCredential();
  const color = colorEnabled();
  const c = palette(color);
  if (prior && prior.base !== BASE) {
    // Warn-only (revoking against a foreign base is out of scope): the user can Ctrl+C here,
    // log out of the other base, and come back. The stored base is untrusted file content —
    // sanitize like every other echo. Diagnostic, so stderr: stdout keeps only the flow itself.
    // Prose, never a runnable command: an inline `YMMV_API=... ymmv logout` is POSIX-only syntax
    // (dead on PowerShell/cmd) and would paste untrusted file content into the user's shell.
    console.error(
      message(
        `You're logged in to ${sanitizeValue(prior.base)}. Logging in here replaces that ` +
          "stored token. To revoke it first, set YMMV_API to that server and run `ymmv logout`.",
      ),
    );
  }
  const { prompter } = deps;
  // Before anything waits, offer or not: from here on keys reach readline, which drops a whole
  // line typed with no question pending and holds a partial one for the discards below. Left to
  // the terminal they would queue for the first question to come: an offer nobody has seen yet,
  // or `ymmv delete`'s confirm. The idle prompt is empty, so the output stays the same.
  prompter?.open();
  // Looked up while GitHub is asked for the code: a PATH walk can be slow (WSL's /mnt/c entries),
  // and only the offer needs its answer. findLauncher never rejects.
  const finding = prompter ? findLauncher() : null;
  const dc = await requestDeviceCode(deps);
  // user_code/verification_uri come off the wire — sanitize/link like every other print surface.
  // Linkify ONLY a github.com https URI: a middlebox-minted 200 must not turn this line into a
  // first-party-looking clickable target (file://, lookalike host); anything else prints inert.
  const verifyUri = /^https:\/\/github\.com\//.test(dc.verification_uri)
    ? link(dc.verification_uri, color)
    : sanitizeValue(dc.verification_uri);
  const code = sanitizeValue(dc.user_code);
  console.log(
    message(
      `Open ${verifyUri} and enter code: ${c.bold}${code}${c.reset}\n` +
        `${c.faint}waiting for GitHub approval… (Ctrl+C to cancel)${c.reset}`,
    ),
  );
  const launcher = await finding;
  const accessToken =
    prompter && launcher && dc.verification_uri === DEVICE_PAGE
      ? await pollWithOffer(dc, deps, prompter, launcher, code, c)
      : await pollForToken(dc, deps);
  // The device flow takes minutes: a concurrent login may have replaced the stored token since
  // the pre-flow peek. Re-read right before the mint so the server retires what the file ACTUALLY
  // holds (the pre-flow `prior` still owns the cross-base warn; `retirable` owns what counts).
  const before = await peekCredential();
  const revoke = retirable(before) ? before.token : undefined;
  const minted = await mintYmmvToken(accessToken, revoke);
  // Between that peek and the mint reply another login may have written its own fresh token; the
  // server never saw it, so it is this process's leftover to retire (below, after the save).
  const after = await peekCredential();
  try {
    await saveToken(minted);
  } catch (e) {
    // Don't strand a minted token we couldn't persist — the user would have no way to revoke it.
    // The file is left as it was (the token the server just retired: the next command's 401 clears
    // it). If even the revoke fails, say so: the fs error alone would claim a clean slate the
    // server doesn't have.
    await revokeYmmvToken(minted.token).catch(() => {
      console.error(
        message(`${c.faint}(the login the server minted could not be revoked)${c.reset}`),
      );
    });
    throw e;
  }
  if (retirable(after) && after.token !== revoke && after.token !== minted.token) {
    // Racing logins only: the normal replacement was retired in the mint batch. Best effort — a
    // failed revoke must never block a login that already succeeded, but say so (that token stays
    // live and this CLI no longer holds a reference to it). The !== minted guard is defensive: if a
    // server ever echoed the stored token back, revoking it would kill the login just saved.
    try {
      await revokeYmmvToken(after.token);
    } catch {
      console.error(message(`${c.faint}(couldn't revoke the previous session's token)${c.reset}`));
    }
  }
  console.log(
    message(
      minted.handle
        ? `Logged in as ${minted.handle}.`
        : "Logged in. No handle bound (your GitHub username is a reserved word).",
    ),
  );
  // Everything since the input opened was a wait. A key typed there (an unfinished `y`) would
  // otherwise sit in readline's line and pre-fill the caller's next question: for `ymmv delete`,
  // a default-No confirm that Enter would then answer yes.
  prompter?.discardTypeahead();
}
