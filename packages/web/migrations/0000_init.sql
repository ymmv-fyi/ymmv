-- ymmv.fyi v1 normalized schema (api unit). Everything keyed on the immutable github_id;
-- the handle is a refreshed alias. Replaces the throwaway skeleton `profiles` blob.
DROP TABLE IF EXISTS profiles;

CREATE TABLE users (
  github_id    INTEGER PRIMARY KEY,
  handle       TEXT,                       -- display casing; NULL = displaced/limbo (released handle)
  handle_lower TEXT UNIQUE,                -- lookup key; NULL allowed (SQLite treats NULLs as distinct)
  extras       TEXT NOT NULL DEFAULT '[]', -- JSON Extra[] (C2: curated keys normalize, extras stay JSON)
  updated_at   TEXT,                       -- ISO; NULL until first publish (= "no profile yet")
  created_at   TEXT NOT NULL,
  CHECK ((handle IS NULL) = (handle_lower IS NULL))  -- invariant: both set, or both NULL
);

CREATE TABLE profile_entries (
  github_id INTEGER NOT NULL,
  key       TEXT NOT NULL,                 -- a CURATED_KEY (validated server-side on write)
  value     TEXT NOT NULL,
  PRIMARY KEY (github_id, key)
);

CREATE TABLE tokens (
  hash       TEXT PRIMARY KEY,            -- sha256(raw bearer); the raw token is never stored
  github_id  INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT                          -- NULL = active
);

CREATE TABLE handle_history (
  old_handle_lower TEXT PRIMARY KEY,       -- latest-wins on a re-freed handle (A3)
  github_id        INTEGER NOT NULL,       -- who vacated it
  changed_at       TEXT NOT NULL
);
