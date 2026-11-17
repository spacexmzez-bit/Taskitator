-- Phase 10: optional organisational label on invitations.
-- Apply after uni/universe-phase9.sql. Safe to run more than once.
-- This migration does not touch personal-task tables.
-- A label only helps managers remember who an invitation was sent to. It is never
-- compared with the name, email or username of the account that accepts it.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS universe_phase10(version INTEGER PRIMARY KEY CHECK(version=10));
CREATE TABLE IF NOT EXISTS universe_invitation_labels(
 invitation_id TEXT PRIMARY KEY, group_id TEXT NOT NULL,
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80)
);
CREATE INDEX IF NOT EXISTS universe_invitation_labels_group ON universe_invitation_labels(group_id);
INSERT OR IGNORE INTO universe_phase10 VALUES(10);
