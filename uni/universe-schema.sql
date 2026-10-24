-- Universe schema 1. Additive and repeatable; never touches personal tables.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS universe_schema(version INTEGER PRIMARY KEY CHECK(version=1));
CREATE TABLE IF NOT EXISTS universe_accounts(
 account_id TEXT PRIMARY KEY, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
 joined_limit INTEGER NOT NULL CHECK(joined_limit IN (2,7)), created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS universe_account_no_unblock BEFORE UPDATE OF blocked ON universe_accounts
 WHEN OLD.blocked=1 AND NEW.blocked<>1 BEGIN SELECT RAISE(ABORT,'U_ACCOUNT_BLOCKED'); END;
CREATE TABLE IF NOT EXISTS universe_groups(
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES universe_accounts(account_id),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120), purpose TEXT NOT NULL CHECK(length(purpose)<=2000),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS universe_members(
 group_id TEXT NOT NULL REFERENCES universe_groups(id), account_id TEXT NOT NULL REFERENCES universe_accounts(account_id),
 role TEXT NOT NULL CHECK(role IN ('owner','admin','reviewer','member')), joined_at INTEGER NOT NULL,
 PRIMARY KEY(group_id,account_id)
);
CREATE INDEX IF NOT EXISTS universe_members_account ON universe_members(account_id);
CREATE INDEX IF NOT EXISTS universe_groups_owner ON universe_groups(owner_id);
CREATE TABLE IF NOT EXISTS universe_reservations(
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES universe_accounts(account_id),
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS universe_reservations_account ON universe_reservations(account_id,expires_at);
CREATE TABLE IF NOT EXISTS universe_invitations(
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES universe_groups(id),
 actor_id TEXT NOT NULL REFERENCES universe_accounts(account_id),
 token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('admin','reviewer','member')),
 expires_at INTEGER NOT NULL, accepted_by TEXT REFERENCES universe_accounts(account_id), created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS universe_invites_group ON universe_invitations(group_id);
CREATE TABLE IF NOT EXISTS universe_operations(
 actor_id TEXT NOT NULL REFERENCES universe_accounts(account_id), operation_id TEXT NOT NULL,
 scope TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(actor_id,operation_id)
);
-- A failed guard is a constraint error, not a zero-row update. It rolls back
-- the entire D1 batch, including the operation acknowledgement.
CREATE TABLE IF NOT EXISTS universe_guard(
 id INTEGER PRIMARY KEY CHECK(id=1), ok INTEGER NOT NULL CONSTRAINT U_INVITE_INVALID CHECK(ok=1)
);
CREATE TABLE IF NOT EXISTS universe_events(
 id TEXT PRIMARY KEY, group_id TEXT REFERENCES universe_groups(id), actor_id TEXT NOT NULL,
 kind TEXT NOT NULL, resource_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS universe_owner_immutable BEFORE UPDATE OF owner_id,id ON universe_groups
 BEGIN SELECT RAISE(ABORT,'U_OWNER_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS universe_create_guard BEFORE INSERT ON universe_groups BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM universe_accounts WHERE account_id=NEW.owner_id AND blocked=0)
 THEN RAISE(ABORT,'U_ACCOUNT_BLOCKED') END;
 SELECT CASE WHEN (SELECT count(*) FROM universe_groups WHERE owner_id=NEW.owner_id)+
 (SELECT count(*) FROM universe_reservations WHERE account_id=NEW.owner_id AND expires_at>unixepoch()*1000)>=2
 THEN RAISE(ABORT,'U_OWNED_CAP') END;
END;
CREATE TRIGGER IF NOT EXISTS universe_owner_membership AFTER INSERT ON universe_groups BEGIN
 INSERT INTO universe_members VALUES(NEW.id,NEW.owner_id,'owner',NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS universe_member_guard BEFORE INSERT ON universe_members BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM universe_accounts WHERE account_id=NEW.account_id AND blocked=0)
 OR NOT EXISTS(SELECT 1 FROM universe_groups g JOIN universe_accounts a ON a.account_id=g.owner_id
 WHERE g.id=NEW.group_id AND a.blocked=0) THEN RAISE(ABORT,'U_ACCOUNT_BLOCKED') END;
 SELECT CASE WHEN (NEW.role='owner')<>(NEW.account_id=(SELECT owner_id FROM universe_groups WHERE id=NEW.group_id))
 THEN RAISE(ABORT,'U_OWNER_IMMUTABLE') END;
 SELECT CASE WHEN NEW.role<>'owner' AND (SELECT count(*) FROM universe_members WHERE group_id=NEW.group_id AND role<>'owner')>=20
 THEN RAISE(ABORT,'U_PARTICIPANT_CAP') END;
 SELECT CASE WHEN NEW.role<>'owner' AND (SELECT count(*) FROM universe_members WHERE account_id=NEW.account_id AND role<>'owner')>=
 (SELECT joined_limit FROM universe_accounts WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'U_JOINED_CAP') END;
END;
CREATE TRIGGER IF NOT EXISTS universe_member_owner_update BEFORE UPDATE ON universe_members
 WHEN OLD.role='owner' OR NEW.role='owner' OR OLD.group_id<>NEW.group_id OR OLD.account_id<>NEW.account_id
 BEGIN SELECT RAISE(ABORT,'U_OWNER_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS universe_member_owner_delete BEFORE DELETE ON universe_members WHEN OLD.role='owner'
 BEGIN SELECT RAISE(ABORT,'U_OWNER_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS universe_reservation_guard BEFORE INSERT ON universe_reservations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM universe_accounts WHERE account_id=NEW.account_id AND blocked=0)
 THEN RAISE(ABORT,'U_ACCOUNT_BLOCKED') END;
 SELECT CASE WHEN NEW.expires_at<=unixepoch()*1000 OR NEW.expires_at>unixepoch()*1000+3600000
 THEN RAISE(ABORT,'U_RESERVATION_EXPIRED') END;
 SELECT CASE WHEN (SELECT count(*) FROM universe_groups WHERE owner_id=NEW.account_id)+
 (SELECT count(*) FROM universe_reservations WHERE account_id=NEW.account_id AND expires_at>unixepoch()*1000)>=2
 THEN RAISE(ABORT,'U_OWNED_CAP') END;
END;
CREATE TRIGGER IF NOT EXISTS universe_invite_guard BEFORE INSERT ON universe_invitations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM universe_members m JOIN universe_groups g ON g.id=m.group_id
 JOIN universe_accounts a ON a.account_id=m.account_id JOIN universe_accounts o ON o.account_id=g.owner_id
 WHERE m.group_id=NEW.group_id AND m.account_id=NEW.actor_id AND a.blocked=0 AND o.blocked=0
 AND (m.role='owner' OR (m.role='admin' AND NEW.role<>'admin')))
 THEN RAISE(ABORT,'U_ROLE_DENIED') END;
END;
CREATE TRIGGER IF NOT EXISTS universe_accept_guard BEFORE UPDATE OF accepted_by ON universe_invitations BEGIN
 SELECT CASE WHEN OLD.accepted_by IS NOT NULL OR NEW.accepted_by IS NULL OR OLD.expires_at<=unixepoch()*1000
 THEN RAISE(ABORT,'U_INVITE_INVALID') END;
 -- The issuer must still be allowed to issue this role at acceptance time.
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM universe_members m JOIN universe_accounts a ON a.account_id=m.account_id
 WHERE m.group_id=OLD.group_id AND m.account_id=OLD.actor_id AND a.blocked=0
 AND (m.role='owner' OR (m.role='admin' AND OLD.role<>'admin')))
 THEN RAISE(ABORT,'U_ROLE_DENIED') END;
END;
CREATE TRIGGER IF NOT EXISTS universe_accept_member AFTER UPDATE OF accepted_by ON universe_invitations BEGIN
 INSERT INTO universe_members VALUES(NEW.group_id,NEW.accepted_by,NEW.role,unixepoch()*1000);
END;
CREATE TRIGGER IF NOT EXISTS universe_operation_guard BEFORE INSERT ON universe_operations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM universe_accounts WHERE account_id=NEW.actor_id AND blocked=0)
 THEN RAISE(ABORT,'U_ACCOUNT_BLOCKED') END;
END;
INSERT OR IGNORE INTO universe_schema VALUES(1);
