import { isGithubId, isValidHandle, type MintResult } from "@ymmv/shared";
import { BASE } from "./config.js";
import {
  isTimeoutError,
  REVOKE_CAP_MS,
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

/** A 200 the CLI refuses to store: the mint reply lacked a usable token, handle, or account id.
 *  Deterministic for this binary against this Worker (an older Worker never grows the field), so
 *  api.ts turns it into a PublishRefusal: the interactive loop must exit, not re-run the device
 *  flow, because every extra pass would mint (and orphan) another token. */
export class MintRejected extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "MintRejected";
  }
}

/** Exchange a GitHub access token for a minted ymmv token (the Worker verifies the token's audience
 *  via GitHub token introspection). */
export async function mintYmmvToken(accessToken: string): Promise<MintResult> {
  // safeFetch: the mint runs right after the user approved on GitHub — a wifi blip here must say
  // "can't reach", not leak a raw fetch TypeError.
  const res = await safeFetch(
    `${BASE}/api/v1/auth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: accessToken }),
      // Never follow a redirect: a 30x must fail (the existing `!res.ok` guard rejects the resulting
      // opaqueredirect), not re-POST the GitHub access_token to the redirect target or read a
      // redirected 200 as a successful mint. Mirrors publish/delete in api.ts.
      redirect: "manual",
    },
    BASE,
  );
  if (!res.ok) {
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
    // 400 slugs (bad_json, missing_access_token) are unreachable from a well-formed CLI, and any
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
  // silently destroys an existing login. The handle is sanitized at this boundary so every
  // downstream print (prompts, confirms, "Logged in as") gets a clean value. github_id is
  // REQUIRED (strict, not optional): a Worker that can't say which account it minted for can't
  // produce a credential the reauth guard in api.ts may trust, so it fails loudly here instead of
  // silently downgrading that guard to the handle-only check — deploy the Worker before the CLI.
  const data = (await bodyJson(res)) as Partial<MintResult> | null;
  const unexpected = `Unexpected response from ${BASE}. Nothing was saved; run \`ymmv login\` again.`;
  // A body that isn't JSON at all is a transport event (mid-body reset, captive portal), not a
  // Worker reply this binary can't use: a plain Error, so the interactive loop keeps its answers.
  if (!data) throw new Error(unexpected);
  const token = typeof data.token === "string" && data.token.length > 0 ? data.token : null;
  // The handle is sanitized, then validated, at this boundary: a real Worker binds only a valid
  // handle (or null), so anything else, an empty or control-char-only string or a slash-bearing
  // one from a foreign YMMV_API origin, is a reply this binary refuses to store.
  const handle =
    data.handle === null
      ? null
      : typeof data.handle === "string"
        ? sanitizeValue(data.handle)
        : undefined;
  if (
    token === null ||
    handle === undefined ||
    (handle !== null && !isValidHandle(handle)) ||
    !isGithubId(data.github_id)
  ) {
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
    throw new MintRejected(
      revokeFailed ? `${unexpected} The login the server minted could not be revoked.` : unexpected,
    );
  }
  return { token, handle, github_id: data.github_id };
}

/** Revoke a ymmv token server-side. Returns whether a live token was actually revoked.
 *  Two callers: logout() (default timeout via safeFetch; it owns the user-facing copy for ANY
 *  throw, so a hung revoke fails into its retry message instead of hanging logout forever) and
 *  the mint refusal above (passes its own short `signal` and folds a failure into its copy). */
export async function revokeYmmvToken(token: string, signal?: AbortSignal): Promise<boolean> {
  const res = await safeFetch(
    `${BASE}/api/v1/auth/logout`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal,
      // Never follow a redirect: a 30x→200 must not read as a successful revoke (which would delete
      // the local file while the server token stays live). Same guard as mint + publish/delete.
      redirect: "manual",
    },
    BASE,
  );
  if (!res.ok) throw new Error(`logout failed: ${res.status}`);
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
