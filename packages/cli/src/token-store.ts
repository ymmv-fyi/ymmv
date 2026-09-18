import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isGithubId, type MintResult } from "@ymmv/shared";
import envPaths from "env-paths";
import { BASE } from "./config.js";

// Local credential store. Scoped to the API base so a prod token and a `wrangler dev` token can't be
// confused — logging out against the wrong base would otherwise hit the server's idempotent path,
// delete the local file, and orphan a still-active token. 0600 on POSIX; on Windows `mode` is a
// no-op so we rely on the per-user %APPDATA% ACL.

export interface StoredToken {
  base: string;
  token: string;
  handle: string | null;
  /** The GitHub account id the token was minted for. Nullable on READ only: a token.json written
   *  by a CLI that predates the field has none, and must keep loading. Every WRITE carries one
   *  (saveToken takes a MintResult), so for a FILE credential `null` means exactly "legacy file".
   *  A RAW env Credential (loadCredential below) is also null: YMMV_TOKEN arrives with no trusted
   *  identity until api.ts verifyEnvCredential() fills it in from whoami. */
  github_id: number | null;
}

export function tokenFilePath(): string {
  // `suffix: ""` drops env-paths' default "-nodejs" suffix → a clean ~/.config/ymmv dir.
  return join(envPaths("ymmv", { suffix: "" }).config, "token.json");
}

/** Persist the token for the CURRENT base — 0600, via a temp file + atomic rename. Takes the mint
 *  result as-is: the wire shape IS the stored shape (minus base), and its github_id is non-null. */
export async function saveToken(data: MintResult): Promise<void> {
  const path = tokenFilePath();
  const dir = dirname(path);
  // 0o700 the credential dir, not just the 0o600 token file. `mode` on mkdir only applies to dirs it
  // CREATES (and is umask-masked), so also chmod on POSIX to tighten a pre-existing world-traversable
  // 0o755 dir left by an older CLI. Best-effort: on a foreign-owned or network-mounted dir (NFS
  // root_squash, CIFS, WSL /mnt) chmod can EPERM/ENOSYS, and this is pure defense-in-depth — the token
  // file is still written 0o600, so a dir-chmod failure must never break login. Windows is a no-op.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dir, 0o700).catch(() => {});
  // Unique temp name so we never reuse crash residue or collide with a concurrent save, and an
  // explicit chmod because writeFile's `mode` only applies when it CREATES the file.
  const tmp = `${path}.${randomUUID()}.tmp`;
  const stored: StoredToken = {
    base: BASE,
    token: data.token,
    handle: data.handle,
    github_id: data.github_id,
  };
  try {
    await writeFile(tmp, JSON.stringify(stored), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** The one raw read of token.json: file content parsed, or null on any failure (ENOENT, malformed
 *  JSON, a non-object root such as a file holding literal `null`). Every reader below applies its
 *  own field predicates on this — three hand-rolled read/parse copies drifted before. */
async function readTokenFile(): Promise<Partial<StoredToken> | null> {
  try {
    const parsed = JSON.parse(await readFile(tokenFilePath(), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<StoredToken>) : null;
  } catch {
    return null;
  }
}

/** Load the stored token IFF it was minted for the current base; otherwise null (forces re-login). */
export async function loadToken(): Promise<StoredToken | null> {
  const parsed = await readTokenFile();
  // `handle` must be string-or-null — a missing handle would make requireHandle print the wrong
  // "reserved word" diagnosis, and a non-string truthy one would crash later on .toLowerCase().
  // A present-but-empty token is corruption too (`Bearer ` requests). Any corruption reads as
  // logged-out (clean re-login); login() still revokes the old token via peekCredential, which
  // ignores the handle. `github_id`: ABSENT (or null) is the legacy pre-field file and reads as
  // null — it must not log the user out, and it must not leak through as `undefined`, which the
  // reauth guard's `!== null` test would read as a known id. PRESENT but not a GitHub id is
  // corruption like any other field.
  const rawId: unknown = parsed?.github_id;
  const idOk = rawId === undefined || rawId === null || isGithubId(rawId);
  if (
    !parsed ||
    parsed.base !== BASE ||
    typeof parsed.token !== "string" ||
    parsed.token === "" ||
    (parsed.handle !== null && typeof parsed.handle !== "string") ||
    !idOk
  ) {
    return null;
  }
  // Explicit fields, not a cast: stray keys in the file never ride along. A hand-edited "" handle
  // reads as null, the same normalization the mint boundary applies, so no `=== null` no-handle
  // check downstream ever meets a falsy-but-not-null value.
  return {
    base: parsed.base,
    token: parsed.token,
    handle: parsed.handle === "" ? null : parsed.handle,
    github_id: isGithubId(rawId) ? rawId : null,
  };
}

/**
 * Lenient read for the login revoke path: base + token only, ANY base, handle ignored. NOT a
 * `Credential` (file-only, no source tag) — despite the name, this reader predates the env-aware
 * loadCredential below and must stay env-blind (revoke targets the FILE token). loadToken's
 * strictness is what makes a corrupt file read as logged-out — but the token inside may still be
 * live server-side, and re-login is about to overwrite the only copy of it. This reader lets
 * login() revoke (same base) or warn (other base) before the overwrite orphans it.
 */
export async function peekCredential(): Promise<{ base: string; token: string } | null> {
  const parsed = await readTokenFile();
  return parsed &&
    typeof parsed.base === "string" &&
    typeof parsed.token === "string" &&
    parsed.token !== ""
    ? { base: parsed.base, token: parsed.token }
    : null;
}

export type CredentialSource = "env" | "file";

export interface Credential extends StoredToken {
  source: CredentialSource;
}

/**
 * The credential API calls run under: `YMMV_TOKEN` (with optional `YMMV_HANDLE`) when set, else
 * the stored file token. An env credential comes back UNVERIFIED (api.ts verifyEnvCredential()
 * fills in its identity). Env values are read at call time; empty string means unset (the
 * YMMV_API convention). The file readers above stay env-blind ON PURPOSE: login's revoke/warn
 * flow and logout must act on the FILE token only — an env token is read-only config the CLI
 * must never revoke, overwrite, or delete. Shapes are vetted by credentialEnvProblem()
 * (config.ts) before main() dispatches, so this reader trusts them.
 */
export async function loadCredential(): Promise<Credential | null> {
  const envToken = process.env.YMMV_TOKEN || "";
  if (envToken !== "") {
    // RAW and unverified: github_id null, and the handle is whatever YMMV_HANDLE claims. This
    // reader stays network-free; api.ts verifyEnvCredential() replaces both with what whoami says
    // the token is bound to before any command acts on them.
    return {
      base: BASE,
      token: envToken,
      handle: process.env.YMMV_HANDLE || null,
      github_id: null,
      source: "env",
    };
  }
  const stored = await loadToken();
  return stored ? { ...stored, source: "file" } : null;
}

export async function deleteToken(): Promise<void> {
  await rm(tokenFilePath(), { force: true });
}

/** The base a stored token was minted for, regardless of the current base — for logout messaging.
 *  Deliberately looser than peekCredential (no token check): "a token file for X exists" is still
 *  the right logout message when the token field itself is corrupt. */
export async function peekBase(): Promise<string | null> {
  const parsed = await readTokenFile();
  return typeof parsed?.base === "string" ? parsed.base : null;
}
