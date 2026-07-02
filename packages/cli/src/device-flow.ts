import { GITHUB_CLIENT_ID } from "@ymmv/shared";
import { mintYmmvToken, revokeYmmvToken } from "./auth-http.js";
import { causeText, safeFetch } from "./http.js";
import { colorEnabled, link, palette, sanitizeValue } from "./render.js";
import { saveToken } from "./token-store.js";

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
  interval: number;
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
    throw new Error(`device code request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DeviceCode;
}

/**
 * Poll GitHub until the user authorizes (→ GitHub access token), denies, or the code expires.
 * Honors slow_down backoff: GitHub mandates +5s and may send a larger `interval`.
 */
export async function pollForToken(dc: DeviceCode, deps: PollDeps = {}): Promise<string> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;

  let interval = dc.interval || 5;
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
      });
    } catch (err) {
      lastCause = causeText(err);
    }
    let tok: { access_token?: string; error?: string; interval?: number } | undefined;
    if (res?.ok) {
      try {
        tok = (await res.json()) as { access_token?: string; error?: string; interval?: number };
      } catch {
        tok = undefined;
        lastCause = "unexpected response body";
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
        interval = Math.max(tok.interval ?? 0, interval + 5);
        break;
      case "access_denied":
        throw new Error("Authorization denied. Run `ymmv login` to try again.");
      case "expired_token":
        throw new Error("Device code expired. Run `ymmv login` again.");
      default:
        throw new Error(`device flow failed: ${tok.error ?? "unknown error"}`);
    }
  }
  throw new Error("Device code expired. Run `ymmv login` again.");
}

/** Full login: device flow → mint a ymmv token → store it (0600, scoped to the API base).
 *  `deps` is for tests (inject sleep/now/fetch); production calls login() with real timers. */
export async function login(deps: PollDeps = {}): Promise<void> {
  // The device flow needs a human to read a code and visit a URL, so it cannot complete without a
  // terminal. Refuse fast in a piped/CI/non-TTY context instead of printing a code nobody reads and
  // blocking on the ~15-minute GitHub poll. (publish/set/delete reach here via ensureLogin.)
  if (!process.stdin.isTTY) {
    throw new Error(
      "Device login needs an interactive terminal. Run `ymmv login` in a real terminal " +
        "(a piped or CI shell can't complete the GitHub device flow).",
    );
  }
  const dc = await requestDeviceCode(deps);
  const color = colorEnabled();
  const c = palette(color);
  // user_code/verification_uri come off the wire — sanitize/link like every other print surface.
  console.log(
    `\n  Open ${link(dc.verification_uri, color)} and enter code: ` +
      `${c.bold}${sanitizeValue(dc.user_code)}${c.reset}`,
  );
  console.log(`  ${c.faint}waiting for GitHub approval… (Ctrl+C to cancel)${c.reset}\n`);
  const accessToken = await pollForToken(dc, deps);
  const { token, handle } = await mintYmmvToken(accessToken);
  try {
    await saveToken({ token, handle });
  } catch (e) {
    // Don't strand a minted token we couldn't persist — the user would have no way to revoke it.
    await revokeYmmvToken(token).catch(() => {});
    throw e;
  }
  console.log(
    handle
      ? `  Logged in as ${handle}.\n`
      : "  Logged in. No handle bound (your GitHub username is a reserved word).\n",
  );
}
