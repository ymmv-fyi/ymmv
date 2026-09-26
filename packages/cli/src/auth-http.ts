import {
  isGithubId,
  isValidHandle,
  type MintRequest,
  type MintResult,
  type WhoamiResult,
} from "@ymmv/shared";
import { BASE, serverOrigin } from "./config.js";
import {
  isTimeoutError,
  REVOKE_CAP_MS,
  redirectError,
  safeFetch,
  serverMessage,
  wireText,
  withRetryHint,
} from "./http.js";
import { sanitizeValue } from "./render.js";

// The CLI<->Worker auth contract. Kept in its own module (imported by device-flow.ts, index.ts,
// and api.ts, which takes only MintRejected) so api.ts can import login() for 401/409 reauth
// without a device-flow <-> api import cycle.

/** Body-read guard for the auth wire: malformed/interrupted bodies become null (callers author
 *  their own copy), but a body-read TIMEOUT is rethrown — a stalled body is a network timeout and
 *  must print as one, never as "unexpected response". */
async function bodyJson(res: Response): Promise<unknown | null> {
  try {
    return await res.json();
  } catch (err) {
    if (isTimeoutError(err)) throw err;
    return null;
  }
}

/** One diagnosis for a dead env token, shared by whoami, publish, and delete so the copy can't
 *  drift; each caller appends its own next step. */
export const ENV_TOKEN_REJECTED =
  "The server rejected the token in YMMV_TOKEN (invalid or revoked).";
/** The rejected-token diagnosis plus the one next step that fixes it (whoami and publish). */
export const ENV_TOKEN_REJECTED_MINT_AGAIN =
  `${ENV_TOKEN_REJECTED} Mint a new one with \`ymmv login\` on an interactive machine ` +
  "and update YMMV_TOKEN.";

/**
 * The one shape-check for an identity off the auth wire (the mint reply and whoami both carry it).
 * A real Worker binds only a valid handle (or null) to a real GitHub id, so anything else, an
 * empty or control-char-only string, a slash-bearing one from a foreign YMMV_API origin, a
 * non-integer id, is a reply this binary refuses. The handle is sanitized HERE so every downstream
 * print (prompts, delete confirms, "Logged in as") gets a clean value. null = refused.
 */
export function parseIdentity(data: unknown): WhoamiResult | null {
  if (typeof data !== "object" || data === null) return null;
  const { handle: rawHandle, github_id: id } = data as { handle?: unknown; github_id?: unknown };
  const handle =
    rawHandle === null
      ? null
      : typeof rawHandle === "string"
        ? sanitizeValue(rawHandle)
        : undefined;
  if (handle === undefined || (handle !== null && !isValidHandle(handle)) || !isGithubId(id)) {
    return null;
  }
  return { github_id: id, handle };
}

/** The next step when the Worker predates something this CLI needs, by who runs that server: a
 *  YMMV_API override points at a staging or self-hosted Worker the user can update; the default
 *  base is ymmv.fyi itself, where the only honest advice is that the server is behind this release. */
function serverBehindHint(): string {
  return process.env.YMMV_API
    ? "Point YMMV_API at an up-to-date server."
    : "The server is behind this CLI release; try again later.";
}

/** A mint reply the CLI refuses: a 200 lacking a usable token, handle, or account id, or a
 *  redirect. Deterministic for this binary against this Worker (an older Worker never grows the
 *  field), so api.ts turns it into a PublishRefusal: the interactive loop must exit, not re-run
 *  the device flow, because every extra pass would mint (and orphan) another token. */
export class MintRejected extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "MintRejected";
  }
}

/** Exchange a GitHub access token for a minted ymmv token (the Worker verifies the token's audience
 *  via GitHub token introspection). `revoke` is the stored token this login replaces: the Worker
 *  retires it in the same D1 batch as the mint; the CLI only checks that the reply acknowledged the
 *  retire (`revoked` present), it never surfaces the flag. */
export async function mintYmmvToken(
  accessToken: string,
  revoke?: string,
): Promise<Omit<MintResult, "revoked">> {
  // safeFetch: the mint runs right after the user approved on GitHub — a wifi blip here must say
  // "can't reach", not leak a raw fetch TypeError.
  const res = await safeFetch(
    `${BASE}/api/v1/auth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      // JSON.stringify drops an undefined `revoke`: no key on the wire when there is nothing to retire.
      body: JSON.stringify({ access_token: accessToken, revoke } satisfies MintRequest),
      // Never follow a redirect: a 30x must fail (Node hands back the 3xx itself, which the
      // `!res.ok` guard rejects), not re-POST the GitHub access_token to the redirect target or
      // read a redirected 200 as a successful mint. Mirrors publish/delete in api.ts.
      redirect: "manual",
    },
    BASE,
  );
  if (!res.ok) {
    // MintRejected, not Error: a redirect answers every retry the same way, so the interactive
    // loop must not run the device flow again.
    const moved = redirectError(res, BASE);
    if (moved) throw new MintRejected(moved.message);
    // Wire-derived copy goes through serverMessage/wireText — sanitized + capped like every other
    // error surface. The status branches are exclusive, so each reads the body at most once.
    if (res.status === 503) {
      throw new Error(
        (await serverMessage(res)) ?? "GitHub is unavailable. Run `ymmv login` again shortly.",
      );
    }
    if (res.status === 429) {
      // The mint endpoint is rate-limited (per identity + per IP). Surface the server's hint.
      throw new Error(
        withRetryHint(
          (await serverMessage(res)) ?? "Too many login attempts. Slow down and try again shortly",
          res,
        ),
      );
    }
    const body = ((await bodyJson(res)) ?? {}) as { error?: string };
    const slug = typeof body.error === "string" ? body.error : "";
    // Map the two server slugs a real user can hit at this moment — right after approving the
    // device flow, the highest-stakes step of onboarding — to human copy with a next step. The
    // 400 slugs (bad_json, missing_access_token, bad_revoke) are unreachable from a well-formed CLI, and any
    // unknown code keeps the raw form: for those, the slug IS the most useful thing to print.
    if (res.status === 401 && slug === "github_auth_failed") {
      throw new Error("GitHub rejected the authorization. Run `ymmv login` to try again.");
    }
    if (res.status === 500 && slug === "internal_error") {
      throw new Error(
        "The server hit an error minting your login. Run `ymmv login` again shortly.",
      );
    }
    throw new Error(`login failed: ${res.status} ${wireText(slug)}`.trim());
  }
  // Shape-check the mint response BEFORE it can touch the token store: a middlebox 200 with `{}`
  // (or non-JSON) must not overwrite a previously valid token.json with a token-less blob — that
  // silently destroys an existing login. The identity half goes through parseIdentity (shared
  // with whoami). github_id is REQUIRED (strict, not optional): a Worker that can't say which
  // account it minted for can't produce a credential the reauth guard in api.ts may trust, so it
  // fails loudly here instead of silently downgrading that guard to the handle-only check —
  // deploy the Worker before the CLI.
  const data = (await bodyJson(res)) as Partial<MintResult> | null;
  // With a `revoke` in flight the Worker may have committed the rotate before the reply was lost or
  // mangled: the stored login is then already retired even though nothing local changed. Say so,
  // or "nothing was saved" reads as "nothing happened".
  const unexpected =
    `Unexpected response from ${BASE}. Nothing was saved` +
    (revoke === undefined ? "" : " (the previous login on this machine may have been signed out)") +
    "; run `ymmv login` again.";
  // A body that isn't JSON at all is a transport event (mid-body reset, captive portal), not a
  // Worker reply this binary can't use: a plain Error, so the interactive loop keeps its answers.
  if (!data) throw new Error(unexpected);
  const token = typeof data.token === "string" && data.token.length > 0 ? data.token : null;
  const identity = parseIdentity(data);
  const revoked = typeof data.revoked === "boolean" ? data.revoked : undefined;
  // A retire the CLI asked for that an otherwise sound reply doesn't confirm is a Worker that
  // predates the field and silently ignored it: the stored token is still live, and storing this
  // reply would strand it with no local reference left. Same strictness as github_id (deploy the
  // Worker before the CLI); the stored login stays untouched, so "nothing was saved" holds.
  const behind =
    token !== null && identity !== null && revoke !== undefined && revoked === undefined
      ? `${BASE} did not retire the previous login. ${serverBehindHint()} Nothing was saved; ` +
        "to log in anyway, run `ymmv logout` first."
      : null;
  if (token === null || identity === null || behind !== null) {
    // A well-formed token in a reply we refuse is ALREADY live in D1 (the Worker mints before it
    // responds) and nothing local will ever hold it. Revoke it now, best-effort, or it stays an
    // orphaned active session only the server could ever see. Capped at REVOKE_CAP_MS, not
    // REQUEST_TIMEOUT_MS: this origin is already misbehaving, and a hung revoke must not stall
    // the login error for the full request timeout. If even the revoke fails, say so: the copy
    // must not claim a clean slate the server doesn't have.
    let revokeFailed = false;
    if (token !== null) {
      await revokeYmmvToken(token, AbortSignal.timeout(REVOKE_CAP_MS)).catch(() => {
        revokeFailed = true;
      });
    }
    const refusal = behind ?? unexpected;
    throw new MintRejected(
      revokeFailed ? `${refusal} The login the server minted could not be revoked.` : refusal,
    );
  }
  // `revoked` was only needed for the contract check above: login() has nothing to do with it.
  return { token, ...identity };
}

/** A 404 from a route this CLI release requires: a Worker deployed before it existed. `missing`
 *  names the route in the user's terms; the next step comes from `serverBehindHint`. */
export function missingRouteError(missing: string): Error {
  return new Error(`${BASE} has no ${missing}. ${serverBehindHint()}`);
}

/**
 * Look up the identity a ymmv token is bound to (GET /api/v1/auth/whoami): YMMV_TOKEN arrives with
 * no server-proven handle or id, and this is what supplies them. Every failure is a plain Error
 * with finished copy; nothing here prints or echoes the token.
 */
export async function fetchWhoami(token: string): Promise<WhoamiResult> {
  const res = await safeFetch(
    `${BASE}/api/v1/auth/whoami`,
    {
      headers: { authorization: `Bearer ${token}` },
      // Never follow a redirect: the bearer must not travel to a redirect target, and a 30x→200
      // must not read as a verified identity. Same guard as mint, logout, publish, and delete.
      redirect: "manual",
    },
    BASE,
  );
  if (!res.ok) {
    const moved = redirectError(res, BASE);
    if (moved) throw moved;
    if (res.status === 401) throw new Error(ENV_TOKEN_REJECTED_MINT_AGAIN);
    if (res.status === 404) {
      // No fallback to the unverified YMMV_HANDLE: a forced 404 must not downgrade the identity
      // check, so this fails with the real diagnosis.
      throw missingRouteError("identity lookup for YMMV_TOKEN");
    }
    // 429 and everything else (5xx, an edge error page): the server's own {message} when it sent
    // one, plus the retry-after hint. Every env-token command depends on this call, so a
    // transient outage must read as one, not as a bare status number.
    throw new Error(
      withRetryHint(
        (await serverMessage(res)) ??
          (res.status === 429
            ? "rate limited, too many requests"
            : `The server couldn't look up your token (${res.status}). Try again shortly.`),
        res,
      ),
    );
  }
  const identity = parseIdentity(await bodyJson(res));
  if (!identity) {
    throw new Error(`Unexpected response from ${BASE}. Check YMMV_API, or try again shortly.`);
  }
  return identity;
}

/** Revoke a ymmv token server-side. Returns whether a live token was actually revoked.
 *  Callers: logout() (default timeout via safeFetch; it owns the user-facing copy for ANY
 *  throw, so a hung revoke fails into its retry message instead of hanging logout forever), the
 *  mint refusal above (passes its own short `signal` and folds a failure into its copy), and
 *  login()'s failed-save and racing-leftover revokes (device-flow.ts, best effort).
 *  Sent to serverOrigin(), so a token stored under a ymmv.fyi alias is revoked over https at
 *  ymmv.fyi itself; every caller but logout runs past the gate, where that is BASE. */
export async function revokeYmmvToken(token: string, signal?: AbortSignal): Promise<boolean> {
  const origin = serverOrigin();
  const res = await safeFetch(
    `${origin}/api/v1/auth/logout`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal,
      // Never follow a redirect: a 30x→200 must not read as a successful revoke (which would delete
      // the local file while the server token stays live). Same guard as mint + publish/delete.
      redirect: "manual",
    },
    origin,
  );
  if (!res.ok) throw redirectError(res, origin) ?? new Error(`logout failed: ${res.status}`);
  // A 200 whose body can't be read or lacks the {revoked} shape is NOT a confirmed revoke: a
  // middlebox-minted 200 (or a body-read timeout) must never read as success — logout() would
  // delete the local file while the server token stays live, stranding the only credential that
  // can revoke it. Throwing lands in logout()'s catch-all, which keeps the token and says retry.
  // Same trust model as the mint shape-check above.
  const body = (await bodyJson(res)) as { revoked?: unknown } | null;
  if (!body || typeof body.revoked !== "boolean") {
    throw new Error("logout failed: unexpected response");
  }
  return body.revoked;
}
