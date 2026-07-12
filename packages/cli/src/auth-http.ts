import { BASE } from "./config.js";
import { isTimeoutError, safeFetch, serverMessage, wireText, withRetryHint } from "./http.js";
import { sanitizeValue } from "./render.js";

// The CLI<->Worker auth contract. Kept in its own module (imported by device-flow.ts AND index.ts)
// so api.ts can import login() for 401/409 reauth without a device-flow <-> api import cycle.

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

export interface MintResult {
  token: string;
  handle: string | null;
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
    throw new Error(`login failed: ${res.status} ${wireText(body.error ?? "")}`.trim());
  }
  // Shape-check the mint response BEFORE it can touch the token store: a middlebox 200 with `{}`
  // (or non-JSON) must not overwrite a previously valid token.json with a token-less blob — that
  // silently destroys an existing login. The handle is sanitized at this boundary so every
  // downstream print (prompts, confirms, "Logged in as") gets a clean value.
  const data = (await bodyJson(res)) as Partial<MintResult> | null;
  if (
    !data ||
    typeof data.token !== "string" ||
    data.token.length === 0 ||
    (data.handle !== null && typeof data.handle !== "string")
  ) {
    throw new Error(
      `Unexpected response from ${BASE}. Nothing was saved; run \`ymmv login\` again.`,
    );
  }
  return { token: data.token, handle: data.handle === null ? null : sanitizeValue(data.handle) };
}

/** Revoke a ymmv token server-side. Returns whether a live token was actually revoked.
 *  safeFetch gives the revoke the default timeout; logout() still owns the user-facing copy for
 *  ANY throw, so a hung revoke fails into its retry message instead of hanging logout forever. */
export async function revokeYmmvToken(token: string): Promise<boolean> {
  const res = await safeFetch(
    `${BASE}/api/v1/auth/logout`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
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
