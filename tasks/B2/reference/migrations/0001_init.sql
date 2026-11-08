CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE members (
  household_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, user_id)
);
CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
);
CREATE TABLE locations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  household_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  depth INTEGER NOT NULL
);
CREATE TABLE items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  household_id TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  location_id TEXT,
  expires_on TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX items_household ON items (household_id, seq);
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  expires_on TEXT NOT NULL,
  remind_on TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (item_id, remind_on)
);
