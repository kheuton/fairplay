-- FairPlay ⇄ Skylight Sync — D1 initial schema
-- Phase 2a: chore surface only; surface='list' reserved for phase 2c.
-- Recurrence columns present in schema but occurrence_date='' for non-recurring tasks.

CREATE TABLE IF NOT EXISTS mapping (
  todoist_id         TEXT NOT NULL,
  -- FairPlay-minted stable id from FP::{json} (join key, survives Todoist id reuse)
  fp_stable_id       TEXT,
  -- YYYY-MM-DD of this occurrence; empty string '' for non-recurring tasks
  occurrence_date    TEXT NOT NULL DEFAULT '',
  -- 'chore' now; 'list' reserved for phase 2c
  surface            TEXT NOT NULL DEFAULT 'chore',
  -- The frame this row was created against — cross-frame write guard
  frame_id           TEXT NOT NULL,
  -- 'amy' | 'kyle'
  profile            TEXT NOT NULL,
  -- Skylight chore id (null while state='creating')
  skylight_id        TEXT,
  -- The exact summary string we wrote (read-back compares full string, never prefix)
  expected_summary   TEXT,
  -- Last status WE pushed: 'pending' | 'complete'
  last_pushed_status TEXT,
  -- Last status we observed on device
  observed_status    TEXT,
  -- Fingerprint (hash) of content+due we last pushed
  last_pushed_hash   TEXT,
  -- State machine: 'creating' | 'active' | 'deleting' | 'deleted' | 'needs_review' | 'detached'
  state              TEXT NOT NULL DEFAULT 'creating',
  -- Per-create idempotency token (also embedded in summary sentinel)
  idem_token         TEXT,
  updated_at         INTEGER,

  PRIMARY KEY (todoist_id, occurrence_date),
  -- Prevents a racing create from inserting a duplicate skylight object
  UNIQUE (skylight_id, frame_id)
);

-- Single-writer lease: at most one active run at a time
CREATE TABLE IF NOT EXISTS lease (
  id         TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
  run_id     TEXT NOT NULL,
  expires_at INTEGER NOT NULL,  -- Unix epoch seconds
  started_at INTEGER NOT NULL
);
