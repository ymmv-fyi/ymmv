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

/** Load the stored token IFF it was minted for the current base; otherwise null (forces re-login). */
export async function loadToken(): Promise<StoredToken | null> {
  let raw: string;
  try {
    raw = await readFile(tokenFilePath(), "utf8");
  } catch {
    return null; // ENOENT etc.
  }
  let parsed: StoredToken;
  try {
    parsed = JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }
  if (parsed.base !== BASE || typeof parsed.token !== "string") return null;
  return parsed;
}

export async function deleteToken(): Promise<void> {
  await rm(tokenFilePath(), { force: true });
}

/** The base a stored token was minted for, regardless of the current base — for logout messaging. */
export async function peekBase(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(tokenFilePath(), "utf8")) as Partial<StoredToken>;
    return typeof parsed.base === "string" ? parsed.base : null;
  } catch {
    return null;
  }
}
