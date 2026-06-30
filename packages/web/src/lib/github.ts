// GitHub identity verification for the device-flow mint endpoint. The Worker NEVER trusts a
// CLI-supplied id/login — it re-reads /user with the access token the CLI obtained from GitHub, so
// possession of a valid GitHub token for an account is the only way to mint a ymmv token for it.

export type GithubUserResult =
  | { kind: "ok"; id: number; login: string }
  | { kind: "auth_failed" }
  | { kind: "transient" };

/**
 * Resolve { id, login } from a GitHub access token. Distinguishes a bad token (auth_failed → 401)
 * from a GitHub outage / rate-limit (transient → 503), so login doesn't read "your auth failed"
 * during a GitHub incident and send the user into a re-login loop.
 */
export async function fetchGithubUser(accessToken: string): Promise<GithubUserResult> {
  let res: Response;
  try {
    res = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "ymmv-worker", // GitHub 403s a request with no user-agent
      },
    });
  } catch {
    return { kind: "transient" }; // network error reaching GitHub
  }
  if (res.status === 401) return { kind: "auth_failed" }; // the token is bad — re-login
  if (!res.ok) return { kind: "transient" }; // 403 (rate)/429/5xx — GitHub's problem, not the token's
  let user: { id?: unknown; login?: unknown };
  try {
    user = (await res.json()) as { id?: unknown; login?: unknown };
  } catch {
    return { kind: "transient" };
  }
  if (typeof user.id !== "number" || typeof user.login !== "string") return { kind: "transient" };
  return { kind: "ok", id: user.id, login: user.login };
}
