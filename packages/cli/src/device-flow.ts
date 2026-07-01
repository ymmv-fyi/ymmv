import { GITHUB_CLIENT_ID } from "@ymmv/shared";
import { mintYmmvToken, revokeYmmvToken } from "./auth-http.js";
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
  const res = await doFetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID }),
  });
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
  while (now() < deadline) {
    await sleep(interval * 1000);
    const res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json" },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        device_code: dc.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const tok = (await res.json()) as { access_token?: string; error?: string; interval?: number };
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
        throw new Error("Device code expired — run `ymmv login` again.");
      default:
        throw new Error(`device flow failed: ${tok.error ?? "unknown error"}`);
    }
  }
  throw new Error("Device code expired — run `ymmv login` again.");
}

/** Full login: device flow → mint a ymmv token → store it (0600, scoped to the API base).
 *  `deps` is for tests (inject sleep/now/fetch); production calls login() with real timers. */
export async function login(deps: PollDeps = {}): Promise<void> {
  // The device flow needs a human to read a code and visit a URL, so it cannot complete without a
  // terminal. Refuse fast in a piped/CI/non-TTY context instead of printing a code nobody reads and
  // blocking on the ~15-minute GitHub poll. (publish/set/delete reach here via ensureLogin.)
  if (!process.stdin.isTTY) {
    throw new Error(
      "Device login needs an interactive terminal — run `ymmv login` in a real terminal " +
        "(a piped or CI shell can't complete the GitHub device flow).",
    );
  }
  const dc = await requestDeviceCode(deps);
  console.log(`\n  Open ${dc.verification_uri} and enter code: ${dc.user_code}\n`);
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
      : "  Logged in — no handle bound (your GitHub username is a reserved word).\n",
  );
}
