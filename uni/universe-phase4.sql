-- Repeatable Phase 4.1 migration. Apply after Phase 3.
CREATE TABLE IF NOT EXISTS universe_phase4(version INTEGER PRIMARY KEY CHECK(version=4));
CREATE TABLE IF NOT EXISTS universe_ai_reviews(
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 group_id TEXT NOT NULL, assignment_id TEXT NOT NULL, submission_id TEXT NOT NULL,
 task_revision INTEGER NOT NULL, assignment_revision INTEGER NOT NULL, membership_epoch INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('hosted','personal')), balance_key TEXT NOT NULL,
 day TEXT NOT NULL, month TEXT NOT NULL, model TEXT NOT NULL, key_version TEXT NOT NULL,
 payload_hash TEXT NOT NULL, policy TEXT NOT NULL, max_credits INTEGER NOT NULL, max_spend INTEGER NOT NULL,
 charged INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('quoted','running','done','uncertain','cancelled')),
 result TEXT, applied INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 UNIQUE(actor_id,operation_id)
);
CREATE INDEX IF NOT EXISTS universe_ai_balance ON universe_ai_reviews(balance_key,month,state);
CREATE INDEX IF NOT EXISTS universe_ai_submission ON universe_ai_reviews(submission_id,state);
CREATE UNIQUE INDEX IF NOT EXISTS universe_ai_one_inference ON universe_ai_reviews(submission_id) WHERE state IN ('running','done','uncertain');
CREATE TABLE IF NOT EXISTS universe_ai_attestations(
 submission_id TEXT PRIMARY KEY, review_id TEXT NOT NULL UNIQUE, task_revision INTEGER NOT NULL,
 verdict TEXT NOT NULL, completer_id TEXT NOT NULL, completer_role TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS universe_ai_budget_guard(id INTEGER PRIMARY KEY CHECK(id=1),ok INTEGER CONSTRAINT U_AI_BALANCE CHECK(ok=1));
CREATE TABLE IF NOT EXISTS universe_ai_safety(id INTEGER PRIMARY KEY CHECK(id=1),blocked INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO universe_ai_safety VALUES(1,0);
CREATE TABLE IF NOT EXISTS universe_member_epochs(group_id TEXT NOT NULL,account_id TEXT NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(group_id,account_id));
INSERT OR IGNORE INTO universe_member_epochs SELECT group_id,account_id,1 FROM universe_members;
CREATE TRIGGER IF NOT EXISTS universe_ai_member_join AFTER INSERT ON universe_members BEGIN
 INSERT INTO universe_member_epochs VALUES(NEW.group_id,NEW.account_id,1) ON CONFLICT(group_id,account_id) DO UPDATE SET epoch=epoch+1;
END;
CREATE TRIGGER IF NOT EXISTS universe_ai_member_depart AFTER DELETE ON universe_members BEGIN
 INSERT INTO universe_member_epochs VALUES(OLD.group_id,OLD.account_id,1) ON CONFLICT(group_id,account_id) DO UPDATE SET epoch=epoch+1;
END;
INSERT OR IGNORE INTO universe_phase4 VALUES(4);
