-- Phase 9: safe owner transfer and overwrite-import support.
-- Apply after the existing Phase 7 schema and Phase 8 catalog-color correction.
-- This migration does not touch personal-task tables.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS universe_phase9(version INTEGER PRIMARY KEY CHECK(version=9));
CREATE TABLE IF NOT EXISTS universe_catalog_styles(
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL, color TEXT NOT NULL
);

-- Owner changes are permitted only through the owner-authorized application route.
-- The new owner must already be a current member, be unblocked, have active Pro,
-- and have capacity under the existing two-owned-Universe limit.
DROP TRIGGER IF EXISTS universe_owner_immutable;
CREATE TRIGGER IF NOT EXISTS universe_owner_transfer_guard
BEFORE UPDATE OF owner_id ON universe_groups
WHEN NEW.owner_id<>OLD.owner_id
BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM universe_members m JOIN universe_accounts a ON a.account_id=m.account_id
  JOIN universe_lifecycle l ON l.account_id=m.account_id
  WHERE m.group_id=OLD.id AND m.account_id=NEW.owner_id AND m.role<>'owner'
    AND a.blocked=0 AND l.lapse_at IS NULL
 ) THEN RAISE(ABORT,'U_TRANSFER_TARGET') END;
 SELECT CASE WHEN (
  SELECT count(*) FROM universe_groups g
  WHERE g.owner_id=NEW.owner_id AND g.id<>OLD.id
    AND NOT EXISTS(SELECT 1 FROM universe_group_state s WHERE s.group_id=g.id AND s.deleted=1)
 ) + (
  SELECT count(*) FROM universe_reservations r WHERE r.account_id=NEW.owner_id AND r.expires_at>unixepoch()*1000
 ) >= 2 THEN RAISE(ABORT,'U_OWNED_CAP') END;
END;

-- Keep membership identity fixed. Role changes involving 'owner' are valid only
-- when they match the group's current owner_id, allowing a transactional transfer.
DROP TRIGGER IF EXISTS universe_member_owner_update;
CREATE TRIGGER IF NOT EXISTS universe_member_owner_update
BEFORE UPDATE ON universe_members
WHEN OLD.group_id<>NEW.group_id OR OLD.account_id<>NEW.account_id
 OR (NEW.role='owner' AND NEW.account_id<>(SELECT owner_id FROM universe_groups WHERE id=NEW.group_id))
 OR (NEW.account_id=(SELECT owner_id FROM universe_groups WHERE id=NEW.group_id) AND NEW.role<>'owner')
 OR (OLD.role='owner' AND OLD.account_id=(SELECT owner_id FROM universe_groups WHERE id=OLD.group_id)
     AND NEW.role='owner' AND NEW.account_id=OLD.account_id)
BEGIN SELECT RAISE(ABORT,'U_OWNER_IMMUTABLE'); END;

DROP TRIGGER IF EXISTS universe_member_owner_delete;
CREATE TRIGGER IF NOT EXISTS universe_member_owner_delete
BEFORE DELETE ON universe_members
WHEN OLD.role='owner' AND OLD.account_id=(SELECT owner_id FROM universe_groups WHERE id=OLD.group_id)
BEGIN SELECT RAISE(ABORT,'U_OWNER_IMMUTABLE'); END;

INSERT OR IGNORE INTO universe_phase9 VALUES(9);
