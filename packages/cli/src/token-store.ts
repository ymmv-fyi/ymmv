import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
}

export function tokenFilePath(): string {
  // `suffix: ""` drops env-paths' default "-nodejs" suffix → a clean ~/.config/ymmv dir.
  return join(envPaths("ymmv", { suffix: "" }).config, "token.json");
}

/** Persist the token for the CURRENT base — 0600, via a temp file + atomic rename. */
export async function saveToken(data: Omit<StoredToken, "base">): Promise<void> {
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
  const stored: StoredToken = { base: BASE, token: data.token, handle: data.handle };
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
  // ignores the handle.
  if (
    !parsed ||
    parsed.base !== BASE ||
    typeof parsed.token !== "string" ||
    parsed.token === "" ||
    (parsed.handle !== null && typeof parsed.handle !== "string")
  ) {
    return null;
  }
  return parsed as StoredToken;
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
 * the stored file token. Env values are read at call time; empty string means unset (the YMMV_API
 * convention). The file readers above stay env-blind ON PURPOSE: login's revoke/warn flow and
 * logout must act on the FILE token only — an env token is read-only config the CLI must never
 * revoke, overwrite, or delete. Shapes are vetted by credentialEnvProblem() (config.ts) before
 * main() dispatches, so this reader trusts them.
 */
export async function loadCredential(): Promise<Credential | null> {
  const envToken = process.env.YMMV_TOKEN || "";
  if (envToken !== "") {
    return { base: BASE, token: envToken, handle: process.env.YMMV_HANDLE || null, source: "env" };
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
