-- MaskChat Phase 16-17 PostgreSQL schema.
-- Run this once if you prefer manual migrations; the server also runs the
-- same idempotent DDL at startup when POSTGRES_URL is configured.

CREATE TABLE IF NOT EXISTS maskchat_reports (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','in_review','resolved')),
  assigned_to TEXT,
  institution_id TEXT,
  room_id TEXT,
  reported_identity_key TEXT,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS maskchat_reports_created_idx ON maskchat_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS maskchat_reports_institution_idx ON maskchat_reports(institution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS maskchat_reports_status_idx ON maskchat_reports(status, created_at DESC);

CREATE TABLE IF NOT EXISTS maskchat_offenders (
  identity_key TEXT PRIMARY KEY,
  report_count INTEGER NOT NULL DEFAULT 0,
  first_reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS maskchat_bans (
  identity_key TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('temporary','permanent')),
  until_at TIMESTAMPTZ,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  assigned_to TEXT
);
CREATE INDEX IF NOT EXISTS maskchat_bans_until_idx ON maskchat_bans(until_at);

CREATE TABLE IF NOT EXISTS maskchat_feedback (
  identity_key TEXT PRIMARY KEY,
  up_count INTEGER NOT NULL DEFAULT 0,
  down_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS maskchat_schedules (
  identity_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS maskchat_scheduled_sessions (
  id TEXT PRIMARY KEY,
  mentor_identity_key TEXT,
  seeker_identity_key TEXT,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maskchat_scheduled_sessions_mentor_idx ON maskchat_scheduled_sessions(mentor_identity_key);
CREATE INDEX IF NOT EXISTS maskchat_scheduled_sessions_seeker_idx ON maskchat_scheduled_sessions(seeker_identity_key);

CREATE TABLE IF NOT EXISTS maskchat_audit_events (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_ref TEXT,
  target_ref TEXT,
  institution_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS maskchat_audit_created_idx ON maskchat_audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS maskchat_audit_type_idx ON maskchat_audit_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS maskchat_audit_institution_idx ON maskchat_audit_events(institution_id, created_at DESC);
