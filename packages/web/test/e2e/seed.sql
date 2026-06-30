-- E2E seed for the Playwright run (local D1 only). Idempotent: re-runnable via INSERT OR REPLACE.
-- Covers: a live profile (antfu) with a deliberately long dotfiles URL (long-value wrap), a second
-- profile (bardisty) to diff against, a renamed-away handle (antfuold → 301 → antfu), and an XSS
-- row (xsstest) to prove HTML-escaping + the safeHref javascript:-scheme guard.

DELETE FROM profile_entries WHERE github_id IN (1001, 2002, 3003);
DELETE FROM handle_history WHERE github_id IN (1001, 2002, 3003);

INSERT OR REPLACE INTO users (github_id, handle, handle_lower, extras, updated_at, created_at) VALUES
  (1001, 'antfu', 'antfu',
   '[{"label":"Keyboard","value":"HHKB Pro 2"},{"label":"Dotfiles","value":"https://github.com/antfu/dotfiles"}]',
   '2026-06-28T09:00:00.000Z', '2026-06-20T00:00:00.000Z'),
  (2002, 'bardisty', 'bardisty', '[]',
   '2026-06-28T10:00:00.000Z', '2026-06-21T00:00:00.000Z'),
  (3003, 'xsstest', 'xsstest',
   '[{"label":"Bio <script>alert(1)</script>","value":"<b>not bold</b> & \"quoted\""},{"label":"Evil link","value":"javascript:alert(1)"}]',
   '2026-06-28T11:00:00.000Z', '2026-06-22T00:00:00.000Z');

INSERT INTO profile_entries (github_id, key, value) VALUES
  (1001, 'editor', 'VS Code'),
  (1001, 'os', 'macOS 15.2'),
  (1001, 'shell', 'zsh'),
  (1001, 'terminal', 'Ghostty'),
  (1001, 'browser', 'Arc'),
  (1001, 'window-manager', 'Aerospace'),
  (1001, 'font', 'Berkeley Mono'),
  (1001, 'multiplexer', 'tmux'),
  (1001, 'dotfiles', 'https://github.com/antfu/dotfiles-but-with-a-very-long-path/blob/main/config'),
  (1001, 'ai-tool', 'Claude Code'),
  (2002, 'editor', 'Zed'),
  (2002, 'os', 'macOS 15.2'),
  (2002, 'shell', 'fish'),
  (2002, 'terminal', 'Ghostty'),
  (2002, 'browser', 'Zen'),
  (2002, 'window-manager', 'yabai'),
  (2002, 'font', 'JetBrains Mono'),
  (2002, 'multiplexer', 'tmux'),
  (2002, 'ai-tool', 'Claude Code'),
  (3003, 'dotfiles', 'javascript:alert(1)');

-- antfu was renamed away from "antfuold" → that old URL must 301 to /antfu.
INSERT OR REPLACE INTO handle_history (old_handle_lower, github_id, changed_at) VALUES
  ('antfuold', 1001, '2026-06-25T00:00:00.000Z');
