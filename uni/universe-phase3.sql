-- Additive Phase 3 schema. Apply after universe-phase2.sql.
CREATE TABLE IF NOT EXISTS universe_phase3(version INTEGER PRIMARY KEY CHECK(version=3));
CREATE TABLE IF NOT EXISTS universe_projects(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES universe_groups(id),title TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS universe_projects_group ON universe_projects(group_id);
CREATE TABLE IF NOT EXISTS universe_tasks(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES universe_groups(id),project_id TEXT NOT NULL REFERENCES universe_projects(id),revision INTEGER NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS universe_tasks_group ON universe_tasks(group_id);
CREATE TABLE IF NOT EXISTS universe_assignments(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES universe_groups(id),task_id TEXT NOT NULL REFERENCES universe_tasks(id),account_id TEXT,revision INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','pending','approved','rejected','cancelled')),submission_id TEXT);
CREATE INDEX IF NOT EXISTS universe_assignments_task ON universe_assignments(task_id);
CREATE TABLE IF NOT EXISTS universe_submissions(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,assignment_id TEXT NOT NULL REFERENCES universe_assignments(id),actor_id TEXT NOT NULL,task_revision INTEGER NOT NULL,data TEXT NOT NULL,decision TEXT,reviewer_id TEXT,reason TEXT,created_at INTEGER NOT NULL,decided_at INTEGER,retain_until INTEGER,disputed INTEGER NOT NULL DEFAULT 0 CHECK(disputed IN (0,1)));
CREATE INDEX IF NOT EXISTS universe_submissions_assignment ON universe_submissions(assignment_id,created_at);
CREATE TABLE IF NOT EXISTS universe_files(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,task_id TEXT NOT NULL,assignment_id TEXT,actor_id TEXT NOT NULL,task_revision INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('proof','reference')),name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,hash TEXT NOT NULL,object_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','uploaded','attached','deleted')),submission_id TEXT,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,cleaned_at INTEGER);
CREATE INDEX IF NOT EXISTS universe_files_cleanup ON universe_files(state,expires_at);
INSERT OR IGNORE INTO universe_phase3 VALUES(3);
