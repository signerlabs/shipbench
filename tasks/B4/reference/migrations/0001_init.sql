CREATE TABLE events (id TEXT PRIMARY KEY);
CREATE TABLE subs (user_id TEXT PRIMARY KEY, status TEXT, product_id TEXT, expires_at_ms INTEGER, will_renew INTEGER, last_event_ts INTEGER);
