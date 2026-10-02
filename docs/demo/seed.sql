-- The demo's local D1, applied by docs/demo/record.sh to a throwaway database (never a remote one).
-- record.sh relies on these rows: bardisty (101) has never published, so `ymmv` takes the
-- first-publish walk, and the token row is that account's login (record.sh puts each run's token
-- hash in place of @TOKEN_HASH@ and writes the same token and 101 into token.json). LottieDottieDa
-- is the profile the last scene diffs against, and record.sh polls it to know the Worker is up.

INSERT INTO users (github_id, handle, handle_lower, extras, updated_at, created_at) VALUES
  (101, 'bardisty', 'bardisty', '[]', NULL, '2026-07-01T00:00:00.000Z'),
  (102, 'LottieDottieDa', 'lottiedottieda', '[{"label":"Password Manager","value":"Bitwarden"}]',
   '2026-07-09T07:55:51.771Z', '2026-07-01T00:00:00.000Z');

INSERT INTO profile_entries (github_id, key, value) VALUES
  (102, 'editor', 'notepad'),
  (102, 'os', 'Windows'),
  (102, 'shell', 'PowerShell'),
  (102, 'terminal', 'Warp'),
  (102, 'browser', 'zen');

INSERT INTO tokens (hash, github_id, created_at) VALUES
  ('@TOKEN_HASH@', 101, '2026-07-01T00:00:00.000Z');
