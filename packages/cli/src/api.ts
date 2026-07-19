import { type Profile, parseProfile } from "@ymmv/shared";
import { BASE } from "./config.js";
import { login } from "./device-flow.js";
import {
  safeFetch,
  serverMessage,
  wireBody,
  wireErrorBody,
  wireText,
  withRetryHint,
} from "./http.js";
import { message, sanitizeValue } from "./render.js";
import { type Credential, deleteToken, loadCredential } from "./token-store.js";

/** A publish the CLI refuses deterministically — identity drifted mid-command or auth failed after
 *  its one retry. Re-running the SAME attempt can never succeed (a fresh run must rebuild the merge
 *  under the current login), so the interactive edit loop rethrows this instead of re-offering a
 *  retry that would fail identically. Transient failures (5xx/429/422/network) stay plain Errors
 *  and keep the loop's answers alive. */
export class PublishRefusal extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PublishRefusal";
  }
}

/** One diagnosis for a dead env token, shared by publish and delete so the copy can't drift;
 *  each caller appends its own next step. */
const ENV_TOKEN_REJECTED = "The server rejected the token in YMMV_TOKEN (revoked or expired).";

/** Friendly message for a 429 (write rate limit). The Worker sets `retry-after` + a JSON `{message}`;
 *  the edge WAF block page is non-JSON, so fall back to a generic line. */
async function rateLimitMessage(res: Response): Promise<string> {
  return withRetryHint((await serverMessage(res)) ?? "rate limited, too many requests", res);
}

/** Ensure a credential exists for the current base (YMMV_TOKEN wins), logging in if needed. */
export async function ensureLogin(): Promise<Credential> {
  const existing = await loadCredential();
  if (existing) return existing;
  await login();
  const fresh = await loadCredential();
  if (!fresh) throw new Error("Login did not persist a token. Run `ymmv login`.");
  return fresh;
}

/** What a successful publish resolved to — the CALLER composes any user-facing message
 *  (IO stays at the command edges; this network layer never prints, with ONE sanctioned
 *  exception: the self-heal context line below, which must immediately precede the interactive
 *  device-flow prompt it explains — login() prints that prompt from this same call site). */
export interface PublishResult {
  handle: string;
  url: string;
}

export async function publishProfile(profile: Profile): Promise<PublishResult> {
  const send = (c: Credential) =>
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
  // merge onto the wrong profile — refuse instead of silently substituting the new handle. Both
  // auth-retry paths below re-check the bound handle after their re-login.
  if ((cred.handle ?? "").toLowerCase() !== profile.handle.toLowerCase()) {
    throw new PublishRefusal(
      "The stored login changed while this command was running. Re-run it under the current account.",
    );
  }
  let res = await send(cred);
  if (res.status === 401 || res.status === 409) {
    // An env credential must NEVER enter the heal below: deleteToken() would destroy an unrelated
    // file login, and a device flow can't fix an env var. Deterministic for this process (no edit
    // changes the environment), so PublishRefusal — the interactive loop exits instead of
    // re-offering a retry that fails identically.
    if (cred.source === "env") {
      throw new PublishRefusal(
        res.status === 401
          ? `${ENV_TOKEN_REJECTED} Mint a new one with \`ymmv login\` on an interactive ` +
              "machine and update YMMV_TOKEN."
          : "The server no longer accepts this handle for the YMMV_TOKEN account. Update " +
              "YMMV_HANDLE, or mint a fresh token with `ymmv login`.",
      );
    }
    // 401: token revoked/expired. 409: the local handle went stale after a GitHub rename. Both heal
    // by re-logging-in (re-mint + refresh the bound handle), then retry once. One line of context
    // first: login()'s device prompt would otherwise appear out of nowhere mid-publish — an
    // unexplained GitHub auth challenge is indistinguishable from a phishing surprise.
    const was401 = res.status === 401;
    console.log(
      message(
        was401
          ? "Session expired. Logging in again to retry the publish."
          : "The server no longer recognizes your handle. Logging in again to retry the publish.",
      ),
    );
    if (was401) await deleteToken();
    await login();
    cred = await ensureLogin();
    // NEVER retry a pre-reauth merge under a different identity. 401: the server never disputed
    // the handle, so a re-mint bound to a different one means a different GitHub account
    // authorized in the browser tab. 409: the merge was built from a read of the OLD handle —
    // which after a rename may be a squatter's profile — so retrying under the newly bound
    // handle would publish that stale (possibly stranger-seeded) merge onto it. In both cases:
    // refuse; a fresh run re-reads under the current handle and rebuilds the merge correctly.
    if ((cred.handle ?? "").toLowerCase() !== profile.handle.toLowerCase()) {
      const bound = sanitizeValue(cred.handle ?? "");
      throw new PublishRefusal(
        was401
          ? `The re-login bound a different account ("${bound}", not ` +
              `"${sanitizeValue(profile.handle)}"). Nothing was published. Re-run under the account you meant.`
          : `Your login now binds "${bound}". Nothing was published. Re-run the command to publish under it.`,
      );
    }
    res = await send(cred);
    if (res.status === 401) throw new PublishRefusal("Authentication failed. Run `ymmv login`.");
    if (res.status === 409) {
      // The dominant body here since the bound-handle guard is handle_not_bound — but the CLI has
      // ALREADY re-logged-in and retried, so surfacing the server's "Run `ymmv login` and retry."
      // would instruct the user to repeat what just failed. Say what's true instead. Any OTHER
      // slug keeps its server message (e.g. a true handle-reuse explanation); the hardcoded line
      // stays for a non-JSON body. Body read ONCE — a drained Response must never hit
      // serverMessage(res) again.
      const { slug, message: srvMsg } = wireErrorBody(await wireBody(res));
      if (slug === "handle_not_bound") {
        // PublishRefusal, not Error: the copy says re-run, so the interactive loop must EXIT —
        // re-offering `y` would replay the whole heal (another device-flow login + POST) against
        // a deterministic 409, burning auth and write budgets on a loop that can't succeed.
        throw new PublishRefusal(
          "The server still refuses this handle after a fresh login. Wait a moment and re-run the command.",
        );
      }
      throw new Error(
        srvMsg ??
          "that handle is taken by another account (your GitHub handle may have been reused).",
      );
    }
  }
  if (res.status === 429) throw new Error(await rateLimitMessage(res));
  if (!res.ok) {
    // Server copy first: the Worker's 4xx bodies carry a human {message} (422 caps, 400 schema
    // upgrade). The status + capped raw dump remains only for bodies without one (plain-text
    // 500s, proxy pages).
    const raw = await wireBody(res);
    const parsed = wireErrorBody(raw);
    if (res.status === 400 && parsed.slug === "unsupported_schema_version") {
      // Deterministic for this binary: no edit can change the compiled SCHEMA_VERSION, so the
      // interactive loop must exit with the upgrade copy, not re-offer a retry that 400s forever.
      throw new PublishRefusal(parsed.message ?? `publish failed: ${res.status} ${wireText(raw)}`);
    }
    throw new Error(parsed.message ?? `publish failed: ${res.status} ${wireText(raw)}`);
  }
  // A 200 status already proves the server committed the write — a truncated, stalled, or
  // malformed success BODY must not resurface as a failed publish (the interactive loop would
  // then falsely print "Nothing was published" for a profile that is live). Unlike the error
  // paths, even a body-read timeout is swallowed here: the commit happened; the body only
  // supplies the echo handle, and the login-bound one is a correct fallback.
  let data: { handle?: unknown } = {};
  try {
    data = (await res.json()) as { handle?: unknown };
  } catch {
    // fall through to the profile.handle fallback below
  }
  // The confirmation echoes wire data: shape-check + sanitize the server-returned handle before
  // it can reach a terminal (a non-first-party origin could inject terminal escapes here).
  const shown = typeof data.handle === "string" ? sanitizeValue(data.handle) : profile.handle;
  return { handle: shown, url: `${BASE}/${shown}` };
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
    throw new Error(`fetch failed: ${res.status} ${wireText(await res.text())}`);
  }
  // Validate at the boundary instead of a bare `as Profile` cast: a non-conforming origin (YMMV_API
  // override / MITM) returning e.g. `entries:null` must surface as a typed ProfileParseError, not a
  // TypeError crash deep in diff()/buildDefaults.
  return parseProfile(await res.json());
}

/**
 * Hard-delete the logged-in user's profile (the server revokes ALL the account's tokens).
 * The CALLER passes the credential it just confirmed against — re-reading the store here would
 * open a confirm-to-send window where a concurrent `ymmv login` swaps accounts and the DELETE
 * lands on an identity the user never confirmed (publish's drift guard, applied to delete).
 * Deliberately NO auto-reauth: a 401 here means the token is already dead, and silently
 * re-logging-in could delete a DIFFERENT account than the one the user just confirmed (a device-flow
 * account switch). Make the user re-login + re-run `delete`, which re-confirms the current handle.
 * `redirect: "manual"` so a proxy redirect to a 200 can't masquerade as a successful delete.
 */
export async function deleteProfile(cred: Credential): Promise<void> {
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
    // Same env split as publish: a dead env token is not healable by `ymmv login` HERE (the env
    // var keeps winning), so the copy must name the variable instead.
    throw new Error(
      cred.source === "env"
        ? `${ENV_TOKEN_REJECTED} Update YMMV_TOKEN and run \`ymmv delete\` again.`
        : "Session expired. Run `ymmv login`, then `ymmv delete` again.",
    );
  }
  if (res.status === 429) throw new Error(await rateLimitMessage(res));
  if (!res.ok) {
    // Same message-first rule as publish: show the server's human copy when the body carries one.
    const raw = await wireBody(res);
    throw new Error(wireErrorBody(raw).message ?? `delete failed: ${res.status} ${wireText(raw)}`);
  }
}
