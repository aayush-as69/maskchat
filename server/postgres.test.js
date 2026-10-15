import test from 'node:test';
import assert from 'node:assert/strict';
import { POSTGRES_SCHEMA } from './postgres.js';

test('PostgreSQL schema contains durable moderation and audit tables', () => {
  for (const table of [
    'maskchat_reports',
    'maskchat_offenders',
    'maskchat_bans',
    'maskchat_feedback',
    'maskchat_schedules',
    'maskchat_scheduled_sessions',
    'maskchat_audit_events'
  ]) {
    assert.match(POSTGRES_SCHEMA, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});

test('PostgreSQL schema does not define a raw email column', () => {
  assert.doesNotMatch(POSTGRES_SCHEMA, /email\s+TEXT/i);
});
