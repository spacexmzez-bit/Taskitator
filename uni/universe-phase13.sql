-- Universe Phase 13 (Space plan Phase 3C): Context tab files.
-- Repeatable. Apply after uni/universe-phase12.sql (it uses universe_r2_trash). Deploy order: SQL, Worker, frontend.
-- Quota (200 MB per Universe) and retention (3 months after the owner's Pro lapses) are enforced by the Worker.
CREATE TABLE IF NOT EXISTS universe_phase13(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS universe_context_files(
 id TEXT PRIMARY KEY,
 group_id TEXT NOT NULL,
 uploader_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('image','file')),
 name TEXT NOT NULL,
 mime TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes>0),
 hash TEXT NOT NULL,
 object_key TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS universe_context_files_group ON universe_context_files(group_id,created_at);
INSERT OR IGNORE INTO universe_phase13 VALUES(13);
