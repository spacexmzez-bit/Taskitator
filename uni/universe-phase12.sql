-- Universe Phase 12 (Space plan Phase 3B): Community attachments and post expiry.
-- Repeatable. Apply after uni/universe-phase11.sql. Deploy order: this SQL, then the Worker, then the frontend.
-- No Cron Trigger is needed: expired posts are hidden at read time and purged by the Worker's existing hourly
-- cleanup alarm, which also deletes their R2 objects.
CREATE TABLE IF NOT EXISTS universe_phase12(version INTEGER PRIMARY KEY);
-- Kept beside universe_posts (instead of a new column) so this file can be run more than once.
CREATE TABLE IF NOT EXISTS universe_post_expiry(post_id TEXT PRIMARY KEY,group_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS universe_post_expiry_due ON universe_post_expiry(expires_at);
-- post_id is NULL while a file is staged (uploaded, not yet attached to a post); staged files expire after an hour.
CREATE TABLE IF NOT EXISTS universe_post_files(
 id TEXT PRIMARY KEY,
 group_id TEXT NOT NULL,
 post_id TEXT,
 uploader_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('image','file')),
 name TEXT NOT NULL,
 mime TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes>0),
 hash TEXT NOT NULL,
 object_key TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 staged_until INTEGER
);
CREATE INDEX IF NOT EXISTS universe_post_files_post ON universe_post_files(post_id);
CREATE INDEX IF NOT EXISTS universe_post_files_staged ON universe_post_files(staged_until);
-- R2 objects waiting to be deleted. Rows are written in the same batch that removes the database row, so a failed
-- R2 delete is retried by the next cleanup instead of leaving an orphan.
CREATE TABLE IF NOT EXISTS universe_r2_trash(object_key TEXT PRIMARY KEY,queued_at INTEGER NOT NULL);
INSERT OR IGNORE INTO universe_phase12 VALUES(12);
