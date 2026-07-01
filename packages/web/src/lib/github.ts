// GitHub token introspection for the device-flow mint endpoint. The Worker verifies that the
// CLI-supplied access token was issued to ymmv's OWN OAuth app (audience binding) AND resolves its
// owner in ONE call, via GitHub's "check a token" endpoint. It never trusts a client-supplied
// id/login. Unlike a bare api.github.com/user read (which resolves ANY valid token — a leaked PAT or a
// token phished for a different OAuth app — to its owner), a token not issued to ymmv's app fails here
// (404), closing the confused-deputy account-takeover. Never log the token or the secret.

export type GithubUserResult =
  | { kind: "ok"; id: number; login: string }
  | { kind: "auth_failed" }
  | { kind: "transient" };

// Pin the REST API version so the introspection response shape can't shift under us.
const GITHUB_API_VERSION = "2022-11-28";

/**
 * The Worker's GitHub app client secret from the environment, or null when unset/blank. The mint
 * handler fails CLOSED (500) on null — it must never fall back to an unauthenticated identity read.
 * Kept as a tiny pure function so the fail-closed decision is unit-testable without mutating live env.
 */
export function githubClientSecret(env: unknown): string | null {
  // The secret is a Worker secret, absent from the generated Env type; read it defensively (the
  // rate-limit.ts inline-cast idiom) rather than widening the typed env.
  const secret = (env as { GITHUB_CLIENT_SECRET?: unknown }).GITHUB_CLIENT_SECRET;
  return typeof secret === "string" && secret.trim() !== "" ? secret : null;
}

/**
 * Verify a GitHub access token against ymmv's OAuth app and return its owner:
 *
 *   POST https://api.github.com/applications/{clientId}/token   (HTTP Basic clientId:clientSecret)
 *
 * Three outcomes, so login copy is honest (a GitHub incident must not read "your auth failed"):
 *   • 404          → auth_failed: token is invalid, revoked, or was issued to a DIFFERENT app. This
 *                    is GitHub's documented "not valid for this app" status — the audience check.
 *   • 200 + {user} → ok.
 *   • anything else → transient (GitHub 5xx/429, a 422 spam-throttle, OR our Basic app creds are
 *                     wrong): surfaced to the caller as 503 "try again", and the status is logged so an
 *                     operator can spot a misconfigured GITHUB_CLIENT_SECRET. Token/secret never logged.
 */
export async function verifyGithubToken(
  accessToken: string,
  clientId: string,
  clientSecret: string,
): Promise<GithubUserResult> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/applications/${clientId}/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        "content-type": "application/json",
        "user-agent": "ymmv-worker", // GitHub 403s a request with no user-agent
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
  } catch {
    return { kind: "transient" }; // network error reaching GitHub
  }
  // 404 = token not valid for THIS app (invalid / revoked / foreign audience) → re-login.
  if (res.status === 404) return { kind: "auth_failed" };
  if (!res.ok) {
    // 401/403 (our app creds bad), 422 (validation/spam-throttle), 429/5xx (GitHub). All opaque to the
    // user; log the status so a misconfigured GITHUB_CLIENT_SECRET is operator-visible (no secrets).
    console.error("github introspection non-ok:", res.status);
    return { kind: "transient" };
  }
  let data: { user?: { id?: unknown; login?: unknown } };
  try {
    data = (await res.json()) as { user?: { id?: unknown; login?: unknown } };
  } catch {
    return { kind: "transient" };
  }
  const user = data.user;
  if (!user || typeof user.id !== "number" || typeof user.login !== "string") {
    return { kind: "transient" };
  }
  return { kind: "ok", id: user.id, login: user.login };
}
