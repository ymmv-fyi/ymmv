// The authoritative handle bind, used ONLY by login (POST /api/v1/auth/token) — publish never
// writes handle/handle_lower (its bound-handle guard + conditional batch live in
// pages/api/v1/profile.ts). GitHub's /user introspection just proved the caller owns `handle`, so
// the bind takes it unconditionally: it releases any OTHER account's claim, live or vacated.
// The atomic-history pattern is subtle — `INSERT OR REPLACE … SELECT` reads the pre-update handle
// IN-transaction so there's no pre-read/TOCTOU, `OR REPLACE` gives latest-wins, and the SELECT
// form sidesteps the SQLite INSERT…SELECT…ON CONFLICT parser caveat — so it lives in ONE place.
// A login is not a publish: the claim leaves updated_at/extras untouched (a never-published login
// must not look published, or the GET "200 requires updated_at" invariant breaks).

/** Build the history + release + claim statements for one D1 batch (login-only). */
export function handleBindStatements(
  db: D1Database,
  githubId: number,
  handle: string,
  now: string,
): D1PreparedStatement[] {
  const handleLower = handle.toLowerCase();
  return [
    // 1. record the caller's OLD handle → history IFF renaming (SELECT reads the pre-update value).
    db
      .prepare(
        "INSERT OR REPLACE INTO handle_history (old_handle_lower, github_id, changed_at) " +
          "SELECT handle_lower, github_id, ? FROM users " +
          "WHERE github_id = ? AND handle_lower IS NOT NULL AND handle_lower <> ?",
      )
      .bind(now, githubId, handleLower),
    // 2. release a stale LIVE holder of this handle → NULL limbo (GitHub-proven ownership wins).
    db
      .prepare(
        "UPDATE users SET handle = NULL, handle_lower = NULL WHERE handle_lower = ? AND github_id <> ?",
      )
      .bind(handleLower, githubId),
    // 2b. clear a stale VACATED marker for this handle. A prior owner who renamed away left a
    //     handle_history row pointing the handle at THEM; GitHub's /user just proved the caller
    //     owns it NOW, so current ownership supersedes that marker. Without this, a GET on the
    //     freshly reclaimed-but-unpublished handle 301s to the prior owner (the live bind is
    //     unpublished, so resolution falls through to the stale history row). old_handle_lower is
    //     the PK, so this drops at most one row; it targets the CLAIMED handle, never the caller's
    //     own old handle just recorded in statement 1 (a different key — statement 1's WHERE
    //     excludes it).
    db.prepare("DELETE FROM handle_history WHERE old_handle_lower = ?").bind(handleLower),
    // 3. claim the handle, unpublished (updated_at stays NULL, extras untouched on conflict).
    //    created_at lands only on first insert.
    db
      .prepare(
        "INSERT INTO users (github_id, handle, handle_lower, extras, updated_at, created_at) " +
          "VALUES (?, ?, ?, '[]', NULL, ?) " +
          "ON CONFLICT(github_id) DO UPDATE SET handle = excluded.handle, handle_lower = excluded.handle_lower",
      )
      .bind(githubId, handle, handleLower, now),
  ];
}
