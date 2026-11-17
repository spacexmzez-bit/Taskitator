-- Universe Phase 11 (Space plan Phase 3A): Community feed.
-- Repeatable. Apply after uni/universe-phase10.sql. Deploy order: this SQL, then the Worker, then the frontend.
-- The old discussion table (universe_comments) is not changed or dropped: its comments are copied into one read-only
-- "Earlier discussion" post per Universe, so nothing is lost and a rollback still has the original rows.
CREATE TABLE IF NOT EXISTS universe_phase11(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS universe_posts(
 id TEXT PRIMARY KEY,
 group_id TEXT NOT NULL,
 author_id TEXT NOT NULL,
 author_role TEXT NOT NULL,
 body TEXT NOT NULL,
 comment_roles TEXT NOT NULL DEFAULT '[]',
 comment_projects TEXT NOT NULL DEFAULT '[]',
 legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS universe_posts_page ON universe_posts(group_id,created_at,id);
CREATE TABLE IF NOT EXISTS universe_post_comments(
 id TEXT PRIMARY KEY,
 group_id TEXT NOT NULL,
 post_id TEXT NOT NULL,
 parent_id TEXT,
 author_id TEXT NOT NULL,
 author_role TEXT NOT NULL,
 body TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 edited_at INTEGER,
 deleted_at INTEGER,
 deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS universe_post_comments_page ON universe_post_comments(post_id,created_at,id);
-- One read-only legacy post per Universe that has old discussion comments.
INSERT OR IGNORE INTO universe_posts(id,group_id,author_id,author_role,body,legacy,created_at)
 SELECT 'legacy_'||c.group_id,c.group_id,g.owner_id,'owner','',1,min(c.created_at)
 FROM universe_comments c JOIN universe_groups g ON g.id=c.group_id GROUP BY c.group_id;
-- Old comments keep their id, author, time and reply link. Hidden (moderated) comments become removed comments.
-- The role is the author's role now (the old table never stored one), or member if they have left.
-- Task discussions keep the task title in front of the text.
INSERT OR IGNORE INTO universe_post_comments(id,group_id,post_id,parent_id,author_id,author_role,body,revision,created_at,edited_at,deleted_at)
 SELECT c.id,c.group_id,'legacy_'||c.group_id,c.parent_id,c.actor_id,
  COALESCE((SELECT m.role FROM universe_members m WHERE m.group_id=c.group_id AND m.account_id=c.actor_id),'member'),
  CASE WHEN c.hidden=1 THEN '' WHEN c.task_id IS NOT NULL THEN '['||COALESCE((SELECT json_extract(t.data,'$.title') FROM universe_tasks t WHERE t.id=c.task_id),'Task')||'] '||c.body ELSE c.body END,
  c.revision,c.created_at,CASE WHEN c.hidden=0 AND c.updated_at>c.created_at THEN c.updated_at END,CASE WHEN c.hidden=1 THEN c.updated_at END
 FROM universe_comments c WHERE EXISTS(SELECT 1 FROM universe_posts p WHERE p.id='legacy_'||c.group_id);
INSERT OR IGNORE INTO universe_phase11 VALUES(11);
