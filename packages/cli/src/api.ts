import { type Profile, parseProfile } from "@ymmv/shared";
import { BASE } from "./config.js";
import { login } from "./device-flow.js";
import { safeFetch } from "./http.js";
import { sanitizeValue } from "./render.js";
import { deleteToken, loadToken, type StoredToken } from "./token-store.js";

/** Friendly message for a 429 (write rate limit). The Worker sets `retry-after` + a JSON `{message}`;
 *  the edge WAF block page is non-JSON, so fall back to a generic line. */
async function rateLimitMessage(res: Response): Promise<string> {
  const retry = res.headers.get("retry-after");
  let msg = "rate limited — too many requests";
  try {
    const body = (await res.json()) as { message?: string };
    if (typeof body?.message === "string" && body.message) msg = body.message;
  } catch {
    // non-JSON body (e.g. the edge WAF block page) — keep the generic message
  }
  return retry ? `${msg} (retry in ${retry}s)` : msg;
}

/** Ensure a token exists for the current base, logging in if needed. */
export async function ensureLogin(): Promise<StoredToken> {
  const existing = await loadToken();
  if (existing) return existing;
  await login();
  const fresh = await loadToken();
  if (!fresh) throw new Error("login did not persist a token — run `ymmv login`.");
  return fresh;
}

export async function publishProfile(profile: Profile): Promise<void> {
  const send = (c: StoredToken) =>
    safeFetch(
      `${BASE}/api/v1/profile`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` },
        // Send the login-bound handle, never a caller-guessed one — the official client never claims
        // a handle it doesn't own.
        body: JSON.stringify({ ...profile, handle: c.handle ?? profile.handle }),
        redirect: "manual", // a mutation must never follow a redirect into a false success
      },
      BASE,
    );

  let cred = await ensureLogin();
  // The caller merged `profile` for the handle ITS login resolved moments ago. If the token store
  // now resolves to a different account (a concurrent `ymmv login`), sending would publish that
  // merge onto the wrong profile — refuse instead of silently substituting the new handle. The
  // 401/409 retry below is exempt: re-login there is a fresh, user-interactive proof of identity.
  if ((cred.handle ?? "").toLowerCase() !== profile.handle.toLowerCase()) {
    throw new Error(
      "the stored login changed while this command was running — re-run it under the current account.",
    );
  }
  let res = await send(cred);
  if (res.status === 401 || res.status === 409) {
    // 401: token revoked/expired. 409: the local handle went stale after a GitHub rename. Both heal
    // by re-logging-in (re-mint + refresh the bound handle), then retry once.
    if (res.status === 401) await deleteToken();
    await login();
    cred = await ensureLogin();
    res = await send(cred);
    if (res.status === 401) throw new Error("authentication failed — run `ymmv login`.");
    if (res.status === 409) {
      throw new Error(
        "that handle is taken by another account (your GitHub handle may have been reused).",
      );
    }
  }
  if (res.status === 429) throw new Error(await rateLimitMessage(res));
  if (!res.ok) {
    throw new Error(`publish failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { handle?: unknown };
  // The confirmation echoes wire data: shape-check + sanitize the server-returned handle before
  // printing (a non-first-party origin could inject terminal escapes here).
  const shown = typeof data.handle === "string" ? sanitizeValue(data.handle) : profile.handle;
  console.log(`Published ${shown} -> ${BASE}/${shown}`);
}

/** Fetch a public profile as JSON. Returns null on 404 (no profile / reserved); throws on real
 *  errors. The Worker 301s a renamed handle to its current one — Node's fetch follows it by default,
 *  so callers always see the live profile or a clean miss.
 *
 *  INVARIANT: read-modify-write callers (publish/set/unset) require an UNCACHED read. The response
 *  declares `s-maxage=30, stale-while-revalidate=86400` (web: profile-read.ts readCacheControl);
 *  nothing edge-caches Worker responses today, but if a cache rule ever fronts /api/v1/u/*, a stale
 *  read here would make the full-replace publish silently drop writes made moments earlier. */
export async function fetchProfileJson(handle: string): Promise<Profile | null> {
  const res = await safeFetch(`${BASE}/api/v1/u/${encodeURIComponent(handle)}`, undefined, BASE);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
  }
  // Validate at the boundary instead of a bare `as Profile` cast: a non-conforming origin (YMMV_API
  // override / MITM) returning e.g. `entries:null` must surface as a typed ProfileParseError, not a
  // TypeError crash deep in diff()/buildDefaults.
  return parseProfile(await res.json());
}

/**
 * Hard-delete the logged-in user's profile (the server revokes ALL the account's tokens).
 * Deliberately NO auto-reauth: a 401 here means the stored token is already dead, and silently
 * re-logging-in could delete a DIFFERENT account than the one the user just confirmed (a device-flow
 * account switch). Make the user re-login + re-run `delete`, which re-confirms the current handle.
 * `redirect: "manual"` so a proxy redirect to a 200 can't masquerade as a successful delete.
 */
export async function deleteProfile(): Promise<void> {
  const cred = await ensureLogin();
  const res = await safeFetch(
    `${BASE}/api/v1/profile`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${cred.token}` },
      redirect: "manual",
    },
    BASE,
  );
  if (res.status === 401) {
    throw new Error("session expired — run `ymmv login`, then `ymmv delete` again.");
  }
  if (res.status === 429) throw new Error(await rateLimitMessage(res));
  if (!res.ok) {
    throw new Error(`delete failed: ${res.status} ${await res.text()}`);
  }
}
