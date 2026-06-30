// Handle binding shared by POST /api/v1/profile (publish) and POST /api/v1/auth/token (login).
// The atomic-history pattern is subtle — `INSERT OR REPLACE … SELECT` reads the pre-update handle
// IN-transaction so there's no pre-read/TOCTOU, `OR REPLACE` gives latest-wins, and the SELECT
// form sidesteps the SQLite INSERT…SELECT…ON CONFLICT parser caveat — so it lives in ONE place.
// The two callers differ on exactly two axes:
//   • release   — login also NULLs a stale LIVE holder of this handle (a fresh GitHub /user just
//                 proved the caller owns it now); publish never transfers a live handle.
//   • stampPublish — publish's claim stamps updated_at + extras ("this row has a profile"); login
//                 leaves them untouched, or a never-published login would look published and break
//                 the GET "200 requires updated_at" invariant.

export type HandleBindOpts =
  | { stampPublish: true; extrasJson: string; release: boolean }
  | { stampPublish: false; release: boolean };

/** Build the history + (optional release) + claim statements for one D1 batch. */
export function handleBindStatements(
  db: D1Database,
  githubId: number,
  handle: string,
  now: string,
  opts: HandleBindOpts,
): D1PreparedStatement[] {
  const handleLower = handle.toLowerCase();
  const statements: D1PreparedStatement[] = [
    // 1. record the caller's OLD handle → history IFF renaming (SELECT reads the pre-update value).
    db
      .prepare(
        "INSERT OR REPLACE INTO handle_history (old_handle_lower, github_id, changed_at) " +
          "SELECT handle_lower, github_id, ? FROM users " +
          "WHERE github_id = ? AND handle_lower IS NOT NULL AND handle_lower <> ?",
      )
      .bind(now, githubId, handleLower),
  ];

  if (opts.release) {
    // 2. release a stale LIVE holder of this handle → NULL limbo (login only, GitHub-proven).
    statements.push(
      db
        .prepare(
          "UPDATE users SET handle = NULL, handle_lower = NULL WHERE handle_lower = ? AND github_id <> ?",
        )
        .bind(handleLower, githubId),
    );
  }

  // 3. claim the handle. created_at lands only on first insert. stampPublish decides whether the
  //    claim also marks the row published (updated_at + extras).
  statements.push(
    opts.stampPublish
      ? db
          .prepare(
            "INSERT INTO users (github_id, handle, handle_lower, extras, updated_at, created_at) " +
              "VALUES (?, ?, ?, ?, ?, ?) " +
              "ON CONFLICT(github_id) DO UPDATE SET handle = excluded.handle, " +
              "handle_lower = excluded.handle_lower, extras = excluded.extras, updated_at = excluded.updated_at",
          )
          .bind(githubId, handle, handleLower, opts.extrasJson, now, now)
      : db
          .prepare(
            "INSERT INTO users (github_id, handle, handle_lower, extras, updated_at, created_at) " +
              "VALUES (?, ?, ?, '[]', NULL, ?) " +
              "ON CONFLICT(github_id) DO UPDATE SET handle = excluded.handle, handle_lower = excluded.handle_lower",
          )
          .bind(githubId, handle, handleLower, now),
  );

  return statements;
}

/**
 * True when a thrown D1 error is a UNIQUE-constraint violation. The only UNIQUE in the profile
 * batch is users.handle_lower, so this is the TOCTOU backstop: a concurrent claim that slipped past
 * the pre-batch guard fails the constraint here and maps to a clean 409 instead of a 500.
 */
export function isUniqueViolation(e: unknown): boolean {
  // Specifically the handle_lower uniqueness — the only UNIQUE the profile batch can hit. Matching
  // any UNIQUE would let a future/unexpected constraint masquerade as 409 and hide a real 500.
  return e instanceof Error && /UNIQUE constraint failed: users\.handle_lower/i.test(e.message);
}
