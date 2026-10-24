CREATE TABLE IF NOT EXISTS universe_phase2(version INTEGER PRIMARY KEY CHECK(version=2));
CREATE TABLE IF NOT EXISTS universe_lifecycle(account_id TEXT PRIMARY KEY REFERENCES universe_accounts(account_id), lapse_at INTEGER, checked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS universe_group_state(group_id TEXT PRIMARY KEY REFERENCES universe_groups(id), deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)), deleted_at INTEGER);
CREATE TABLE IF NOT EXISTS universe_cleanup(group_id TEXT PRIMARY KEY REFERENCES universe_groups(id), status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS universe_write_guard(id INTEGER PRIMARY KEY CHECK(id=1), ok INTEGER CONSTRAINT U_ACCESS_DENIED CHECK(ok=1));
CREATE TRIGGER IF NOT EXISTS universe_deleted_permanent BEFORE UPDATE ON universe_group_state WHEN OLD.deleted=1 AND NEW.deleted<>1 BEGIN SELECT RAISE(ABORT,'U_ACCESS_DENIED'); END;
CREATE TRIGGER IF NOT EXISTS universe_invite_lifecycle BEFORE INSERT ON universe_invitations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM universe_group_state WHERE group_id=NEW.group_id AND deleted=1)
 OR EXISTS(SELECT 1 FROM universe_groups g JOIN universe_lifecycle l ON l.account_id=g.owner_id WHERE g.id=NEW.group_id AND l.lapse_at IS NOT NULL AND l.lapse_at+604800000<=unixepoch()*1000)
 THEN RAISE(ABORT,'U_ACCESS_DENIED') END;
END;
CREATE TRIGGER IF NOT EXISTS universe_join_lifecycle BEFORE INSERT ON universe_members BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM universe_group_state WHERE group_id=NEW.group_id AND deleted=1)
 OR EXISTS(SELECT 1 FROM universe_groups g JOIN universe_lifecycle l ON l.account_id=g.owner_id WHERE g.id=NEW.group_id AND l.lapse_at IS NOT NULL AND l.lapse_at+604800000<=unixepoch()*1000)
 THEN RAISE(ABORT,'U_ACCESS_DENIED') END;
END;
CREATE TRIGGER IF NOT EXISTS universe_lapse_initial AFTER INSERT ON universe_lifecycle WHEN NEW.lapse_at IS NOT NULL BEGIN
 INSERT INTO universe_events SELECT lower(hex(randomblob(16))),id,NEW.account_id,'pro_lapsed',NEW.account_id,NEW.checked_at FROM universe_groups WHERE owner_id=NEW.account_id;
END;
CREATE TRIGGER IF NOT EXISTS universe_lapse_change AFTER UPDATE OF lapse_at ON universe_lifecycle WHEN OLD.lapse_at IS NOT NEW.lapse_at BEGIN
 INSERT INTO universe_events SELECT lower(hex(randomblob(16))),id,NEW.account_id,CASE WHEN NEW.lapse_at IS NULL THEN 'pro_restored' ELSE 'pro_lapsed' END,NEW.account_id,NEW.checked_at FROM universe_groups WHERE owner_id=NEW.account_id;
END;
DROP TRIGGER IF EXISTS universe_create_guard;
CREATE TRIGGER universe_create_guard BEFORE INSERT ON universe_groups BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM universe_accounts WHERE account_id=NEW.owner_id AND blocked=0) THEN RAISE(ABORT,'U_ACCOUNT_BLOCKED') END;
 SELECT CASE WHEN (SELECT count(*) FROM universe_groups g WHERE owner_id=NEW.owner_id AND NOT EXISTS(SELECT 1 FROM universe_group_state WHERE group_id=g.id AND deleted=1))+(SELECT count(*) FROM universe_reservations WHERE account_id=NEW.owner_id AND expires_at>unixepoch()*1000)>=2 THEN RAISE(ABORT,'U_OWNED_CAP') END;
END;
DROP TRIGGER IF EXISTS universe_reservation_guard;
CREATE TRIGGER universe_reservation_guard BEFORE INSERT ON universe_reservations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM universe_accounts WHERE account_id=NEW.account_id AND blocked=0) THEN RAISE(ABORT,'U_ACCOUNT_BLOCKED') END;
 SELECT CASE WHEN NEW.expires_at<=unixepoch()*1000 OR NEW.expires_at>unixepoch()*1000+3600000 THEN RAISE(ABORT,'U_RESERVATION_EXPIRED') END;
 SELECT CASE WHEN (SELECT count(*) FROM universe_groups g WHERE owner_id=NEW.account_id AND NOT EXISTS(SELECT 1 FROM universe_group_state WHERE group_id=g.id AND deleted=1))+(SELECT count(*) FROM universe_reservations WHERE account_id=NEW.account_id AND expires_at>unixepoch()*1000)>=2 THEN RAISE(ABORT,'U_OWNED_CAP') END;
END;
INSERT OR IGNORE INTO universe_phase2 VALUES(2);

DROP TRIGGER IF EXISTS universe_member_guard;
CREATE TRIGGER universe_member_guard BEFORE INSERT ON universe_members BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM universe_accounts WHERE account_id=NEW.account_id AND blocked=0)
 OR NOT EXISTS(SELECT 1 FROM universe_groups g JOIN universe_accounts a ON a.account_id=g.owner_id
 WHERE g.id=NEW.group_id AND a.blocked=0) THEN RAISE(ABORT,'U_ACCOUNT_BLOCKED') END;
 SELECT CASE WHEN (NEW.role='owner')<>(NEW.account_id=(SELECT owner_id FROM universe_groups WHERE id=NEW.group_id))
 THEN RAISE(ABORT,'U_OWNER_IMMUTABLE') END;
 SELECT CASE WHEN NEW.role<>'owner' AND (SELECT count(*) FROM universe_members WHERE group_id=NEW.group_id AND role<>'owner')>=20
 THEN RAISE(ABORT,'U_PARTICIPANT_CAP') END;
 SELECT CASE WHEN NEW.role<>'owner' AND (SELECT count(*) FROM universe_members m WHERE account_id=NEW.account_id AND role<>'owner' AND NOT EXISTS(SELECT 1 FROM universe_group_state WHERE group_id=m.group_id AND deleted=1))>=
 (SELECT joined_limit FROM universe_accounts WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'U_JOINED_CAP') END;
END;
