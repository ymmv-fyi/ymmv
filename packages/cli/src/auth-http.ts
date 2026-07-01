import { BASE } from "./config.js";

// The CLI<->Worker auth contract. Kept in its own module (imported by device-flow.ts AND index.ts)
// so api.ts can import login() for 401/409 reauth without a device-flow <-> api import cycle.

export interface MintResult {
  token: string;
  handle: string | null;
}

/** Exchange a GitHub access token for a minted ymmv token (the Worker verifies the token's audience
 *  via GitHub token introspection). */
export async function mintYmmvToken(accessToken: string): Promise<MintResult> {
  const res = await fetch(`${BASE}/api/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (res.status === 503) {
      throw new Error(body.message ?? "GitHub is unavailable — run `ymmv login` again shortly.");
    }
    if (res.status === 429) {
      // The mint endpoint is rate-limited (per identity + per IP). Surface the server's hint.
      const retry = res.headers.get("retry-after");
      const msg = body.message ?? "too many login attempts — slow down and try again shortly";
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
  });
  if (!res.ok) throw new Error(`logout failed: ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { revoked?: boolean };
  return body.revoked === true;
}
