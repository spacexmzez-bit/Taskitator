-- Major Phase 5 (former phases 5–8). Run after universe-phase4.sql.
CREATE TABLE IF NOT EXISTS universe_phase5(version INTEGER PRIMARY KEY CHECK(version=5));
CREATE TABLE IF NOT EXISTS universe_lock_consent(group_id TEXT NOT NULL,account_id TEXT NOT NULL,epoch INTEGER NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),updated_at INTEGER NOT NULL,PRIMARY KEY(group_id,account_id));
CREATE TABLE IF NOT EXISTS universe_lock_eligibility(assignment_id TEXT PRIMARY KEY,group_id TEXT NOT NULL,task_revision INTEGER NOT NULL,assignment_revision INTEGER NOT NULL,eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),notice_at INTEGER NOT NULL,accepted_epoch INTEGER,created_at INTEGER NOT NULL,assignee_epoch INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS universe_lock_group ON universe_lock_eligibility(group_id);
CREATE TABLE IF NOT EXISTS universe_comments(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,task_id TEXT,parent_id TEXT,actor_id TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS universe_comments_page ON universe_comments(group_id,created_at,id);
CREATE TABLE IF NOT EXISTS universe_export_permissions(file_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,allowed INTEGER NOT NULL CHECK(allowed IN (0,1)));
CREATE TABLE IF NOT EXISTS universe_transfers(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('export','import')),group_id TEXT,revision INTEGER,reservation_id TEXT,state TEXT NOT NULL CHECK(state IN ('staged','done','cancelled')),manifest_key TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,result TEXT);
CREATE INDEX IF NOT EXISTS universe_transfers_cleanup ON universe_transfers(expires_at,state);
CREATE TABLE IF NOT EXISTS universe_transfer_files(transfer_id TEXT NOT NULL,file_id TEXT NOT NULL,object_key TEXT NOT NULL,size INTEGER NOT NULL,hash TEXT NOT NULL,uploaded INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,PRIMARY KEY(transfer_id,file_id));
CREATE TRIGGER IF NOT EXISTS universe_consent_depart AFTER DELETE ON universe_members BEGIN DELETE FROM universe_lock_consent WHERE group_id=OLD.group_id AND account_id=OLD.account_id; END;
INSERT OR IGNORE INTO universe_phase5 VALUES(5);
