import { BASE } from "./config.js";
import { safeFetch } from "./http.js";

// The CLI<->Worker auth contract. Kept in its own module (imported by device-flow.ts AND index.ts)
// so api.ts can import login() for 401/409 reauth without a device-flow <-> api import cycle.

export interface MintResult {
  token: string;
  handle: string | null;
}

/** Exchange a GitHub access token for a minted ymmv token (the Worker verifies the token's audience
 *  via GitHub token introspection). */
export async function mintYmmvToken(accessToken: string): Promise<MintResult> {
  // safeFetch: the mint runs right after the user approved on GitHub — a wifi blip here must say
  // "can't reach", not leak a raw fetch TypeError. (revokeYmmvToken stays unwrapped: logout() owns
  // its friendlier retry message for ANY throw.)
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
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (res.status === 503) {
      throw new Error(body.message ?? "GitHub is unavailable. Run `ymmv login` again shortly.");
    }
    if (res.status === 429) {
      // The mint endpoint is rate-limited (per identity + per IP). Surface the server's hint.
      const retry = res.headers.get("retry-after");
      const msg = body.message ?? "too many login attempts. Slow down and try again shortly";
      throw new Error(retry ? `${msg} (retry in ${retry}s)` : msg);
    }
    throw new Error(`login failed: ${res.status} ${body.error ?? ""}`.trim());
  }
  return (await res.json()) as MintResult;
}

/** Revoke a ymmv token server-side. Returns whether a live token was actually revoked. */
export async function revokeYmmvToken(token: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/v1/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    // Never follow a redirect: a 30x→200 must not read as a successful revoke (which would delete the
    // local file while the server token stays live). Same guard as mint + publish/delete.
    redirect: "manual",
  });
  if (!res.ok) throw new Error(`logout failed: ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { revoked?: boolean };
  return body.revoked === true;
}
