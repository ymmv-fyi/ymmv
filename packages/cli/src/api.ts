import { type Profile, parseProfile } from "@ymmv/shared";
import {
  ENV_TOKEN_REJECTED,
  ENV_TOKEN_REJECTED_MINT_AGAIN,
  fetchWhoami,
  MintRejected,
} from "./auth-http.js";
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

/** A login() that returned without a credential on disk. Thrown as a plain Error from ensureLogin
 *  (outside any retry loop) and as a PublishRefusal from the publish paths (inside one). */
const NOT_PERSISTED = "Login did not persist a token. Run `ymmv login`.";

/**
 * Only verifyEnvCredential() ever sets an env credential's github_id, so `null` on one means a
 * call site skipped ensureLogin() and is about to act on the unverified YMMV_HANDLE. A CLI bug,
 * never a user error, so the copy says so.
 */
function assertVerified(cred: Credential): void {
  if (cred.source === "env" && cred.github_id === null) {
    throw new PublishRefusal(
      "Internal error: the YMMV_TOKEN credential was not verified. This is a ymmv-cli bug; " +
        "please report it at https://github.com/ymmv-fyi/ymmv/issues.",
    );
  }
}

/** Friendly message for a 429 (write rate limit). The Worker sets `retry-after` + a JSON `{message}`;
 *  the edge WAF block page is non-JSON, so fall back to a generic line. */
async function rateLimitMessage(res: Response): Promise<string> {
  return withRetryHint((await serverMessage(res)) ?? "rate limited, too many requests", res);
}

/** login() from INSIDE publishProfile, i.e. inside the interactive retry loop, returning the
 *  credential it persisted. Two deterministic failures are translated for that loop: a MintRejected
 *  (a Worker reply this binary refuses to store) and a login that persisted nothing can never
 *  succeed on a retry, so they exit the loop as PublishRefusals instead of re-offering a `y` that
 *  would run another device flow and orphan another minted token. Everything else (network,
 *  GitHub outage) propagates as-is: transient. ensureLogin runs OUTSIDE any loop (the commands'
 *  own first login: publish, set, unset, delete), so a raw MintRejected there is just an error. */
async function loginOrRefuse(): Promise<Credential> {
  try {
    await login();
  } catch (e) {
    if (e instanceof MintRejected) throw new PublishRefusal(e.message);
    throw e;
  }
  const fresh = await loadCredential();
  if (!fresh) throw new PublishRefusal(NOT_PERSISTED);
  return fresh;
}

/**
 * Give an env credential its identity. YMMV_TOKEN arrives with no server-proven handle or id, so
 * the raw credential from loadCredential() carries `github_id: null` and whatever YMMV_HANDLE
 * claims; whoami replaces both with what the token is actually bound to. YMMV_HANDLE is optional,
 * and when set it is a cross-check, not an input: if it names a different account than the token
 * (or the token's account has no handle at all), the secret pair is misconfigured, and acting on
 * the token's account anyway would publish to, or delete, a profile the config never named.
 * Refuse instead. Throws plain Errors with finished copy (fetchWhoami's, or the mismatch below).
 */
export async function verifyEnvCredential(cred: Credential): Promise<Credential> {
  const identity = await fetchWhoami(cred.token);
  const claimed = cred.handle;
  if (claimed !== null && claimed.toLowerCase() !== identity.handle?.toLowerCase()) {
    const shown = `YMMV_HANDLE is "${sanitizeValue(claimed)}"`;
    throw new Error(
      identity.handle === null
        ? `${shown} but the YMMV_TOKEN account has no handle bound.`
        : `${shown} but YMMV_TOKEN belongs to "${identity.handle}". Fix or unset YMMV_HANDLE.`,
    );
  }
  return { ...cred, handle: identity.handle, github_id: identity.github_id };
}

/** Ensure a credential exists for the current base (YMMV_TOKEN wins), logging in if needed. An env
 *  credential is returned VERIFIED (see verifyEnvCredential); a file credential never triggers a
 *  lookup, its identity was server-minted at login. */
export async function ensureLogin(): Promise<Credential> {
  const existing = await loadCredential();
  if (existing) return existing.source === "env" ? verifyEnvCredential(existing) : existing;
  await login();
  const fresh = await loadCredential();
  if (!fresh) throw new Error(NOT_PERSISTED);
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

/** `expected`: the credential the CALLER resolved `profile.handle` under. Required, so a new call
 *  site can't silently downgrade the first send to the handle-only check (see the drift guard). */
export async function publishProfile(
  profile: Profile,
  expected: Credential,
): Promise<PublishResult> {
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

  // An env credential is reused as the caller verified it, never re-read: loadCredential() returns
  // the RAW env credential (YMMV_HANDLE or null, no id), which would fail the guard below for every
  // publish that leaves YMMV_HANDLE unset, and process.env cannot drift inside one process anyway.
  assertVerified(expected);
  let cred = expected.source === "env" ? expected : await loadCredential();
  if (!cred) {
    // Not logged in any more (token.json vanished, or a heal deleted it and its retry then failed
    // transiently): the device flow about to start needs one line of context, or an unexplained
    // GitHub auth challenge mid-publish reads as a phishing surprise. Same sanctioned print as
    // the heal below.
    console.log(message("Not logged in. Logging in to publish."));
    cred = await loginOrRefuse();
  }
  // The credential actually SENT, not just the one the caller merged under: a re-read that came
  // back env-sourced (YMMV_TOKEN set while `expected` was a file login) is raw and must not go out.
  assertVerified(cred);
  // The caller merged `profile` for the handle ITS login resolved moments ago. If the token store
  // now resolves to a different account (a concurrent `ymmv login`, or the device flow just run
  // above, which ANY GitHub account can approve), sending would publish that merge onto the wrong
  // profile — refuse instead of silently substituting the new identity. The handle string can't
  // see a same-name reclaim, so the account id decides too: a FILE credential that carried no id
  // (a pre-#57 token.json) but now resolves WITH one was rewritten by a login this run never
  // verified, so that is unproven and refused as well. An env credential is `expected` itself (see
  // above), so it passes by construction. Both auth-retry paths below re-check identity after
  // their re-login.
  const idDrifted =
    expected.source === "file" &&
    (expected.github_id === null ? cred.github_id !== null : cred.github_id !== expected.github_id);
  if ((cred.handle ?? "").toLowerCase() !== profile.handle.toLowerCase() || idDrifted) {
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
          ? ENV_TOKEN_REJECTED_MINT_AGAIN
          : // The handle came from whoami moments ago, so a 409 means the bind changed in between
            // (a re-login on another machine after a GitHub rename). A fresh run looks it up again.
            "The server no longer accepts this handle for the YMMV_TOKEN account. " +
              "Re-run the command.",
      );
    }
    // 401: token revoked/expired. 409: the local handle went stale after a GitHub rename. Both heal
    // by re-logging-in (re-mint + refresh the bound handle), then retry once. One line of context
    // first: login()'s device prompt would otherwise appear out of nowhere mid-publish — an
    // unexplained GitHub auth challenge is indistinguishable from a phishing surprise.
    const was401 = res.status === 401;
    // The credential whose token just got the 401/409 — the identity the merge was built under.
    // Captured before deleteToken() below: on 401 the file is gone, so this in-memory snapshot is
    // the only pre-reauth reference the retry can be checked against.
    const before = cred;
    console.log(
      message(
        was401
          ? "Session expired. Logging in again to retry the publish."
          : "The server no longer recognizes your handle. Logging in again to retry the publish.",
      ),
    );
    if (was401) await deleteToken();
    cred = await loginOrRefuse(); // never ensureLogin(): no second, unexplained device flow
    // NEVER retry a pre-reauth merge under a different identity. The merge was built from a read
    // of the OLD handle, which after a rename may be a squatter's profile, and a re-login is a
    // device flow that ANY GitHub account can approve in the browser tab. The handle string
    // alone can't see a rename + reclaim (same name, new owner), so the account id decides.
    // What the re-login proves, and what each row prints:
    //
    //   known     = before.github_id !== null   (false only for a token.json from a pre-#57 CLI)
    //   idChanged = known && cred.github_id !== before.github_id
    //               (a re-minted credential with NO id counts as changed: fail closed)
    //   sameHdl   = re-minted handle == profile.handle (the handle the merge was built under)
    //
    //   known | idChanged | sameHdl | bound handle | outcome
    //   ------+-----------+---------+--------------+------------------------------------------
    //    yes  |   no      |  yes    | string       | RETRY: same account, same handle
    //    yes  |   yes     |  yes    | string       | refuse: SQUAT, same name now owned elsewhere
    //    yes  |   yes     |  no     | string       | refuse: different account ("new", not "old")
    //    yes  |   yes     |  no     | null         | refuse: different account, no handle to name
    //    yes  |   no      |  no     | null         | refuse: "no longer binds a handle" (reserved)
    //    yes  |   no      |  no     | string       | refuse: proven rename, "now binds X, re-run"
    //    no   |   -       |  yes    | string       | RETRY: legacy file, handle-only (one heal)
    //    no   |   -       |  no     | null         | refuse: "no longer binds a handle" (reserved)
    //    no   |   -       |  no     | string       | refuse: legacy, status-based copy (as before)
    //
    // Order matters: a PROVEN different account is diagnosed first, so a stranger whose GitHub
    // username is a reserved word is never told "your username is a reserved word". The friendly
    // "re-run to publish under it" line is offered only when the account is proven unchanged (or
    // unknowable); under a proven squat it would walk the user's merge onto the stranger's
    // profile. Ids never print. A refusal is final for this run: a fresh run re-reads under the
    // current login and rebuilds the merge correctly.
    const known = before.github_id !== null;
    const idChanged = known && cred.github_id !== before.github_id;
    const sameHandle = (cred.handle ?? "").toLowerCase() === profile.handle.toLowerCase();
    if (!sameHandle || idChanged) {
      const mine = sanitizeValue(profile.handle);
      const bound = cred.handle === null ? null : sanitizeValue(cred.handle);
      const reRun = "Nothing was published. Re-run under the account you meant.";
      const otherAccount = `The re-login bound a different account ("${bound}", not "${mine}"). ${reRun}`;
      if (idChanged) {
        throw new PublishRefusal(
          sameHandle
            ? `The handle "${mine}" now belongs to a different GitHub account. ${reRun}`
            : bound === null
              ? `The re-login bound a different GitHub account. ${reRun}`
              : otherAccount,
        );
      }
      if (bound === null) {
        throw new PublishRefusal(
          "Your login no longer binds a handle (your GitHub username is a reserved word). " +
            "Nothing was published.",
        );
      }
      const rebound =
        `Your login now binds "${bound}". Nothing was published. ` +
        "Re-run the command to publish under it.";
      if (known) throw new PublishRefusal(rebound); // proven rename, either status
      // Legacy file: no id to consult, so the pre-#57 status-based diagnosis stands.
      throw new PublishRefusal(was401 ? otherAccount : rebound);
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
  assertVerified(cred);
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
