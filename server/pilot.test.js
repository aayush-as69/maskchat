import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPilotConfig, pilotStatus, pilotGate } from './pilot.js';

test('pilot config parses controlled rollout settings', () => {
  const config = loadPilotConfig({
    PILOT_MODE: '1',
    PILOT_MAX_ACTIVE_USERS: '25',
    PILOT_ALLOWED_INSTITUTIONS: 'galgotias,amity',
    PILOT_START_AT: '2026-09-01T00:00:00Z',
    PILOT_END_AT: '2026-10-01T00:00:00Z',
    PILOT_SUPPORT_CONTACT: 'pilot@example.edu'
  });
  const status = pilotStatus(config, Date.parse('2026-09-30T12:00:00Z'));
  assert.equal(status.active, true);
  assert.equal(status.maxActiveUsers, 25);
  assert.deepEqual(status.allowedInstitutions, ['galgotias', 'amity']);
  assert.equal(status.supportContact, 'pilot@example.edu');
});

test('pilot gate enforces institution and lifecycle windows', () => {
  const config = loadPilotConfig({ PILOT_MODE: '1', PILOT_ALLOWED_INSTITUTIONS: 'galgotias', PILOT_START_AT: '2026-09-01T00:00:00Z', PILOT_END_AT: '2026-10-01T00:00:00Z' });
  assert.deepEqual(pilotGate(config, 'galgotias', Date.parse('2026-09-30T00:00:00Z')), { ok: true });
  assert.equal(pilotGate(config, 'amity', Date.parse('2026-09-30T00:00:00Z')).reason, 'institution_not_in_pilot');
  assert.equal(pilotGate(config, 'galgotias', Date.parse('2026-08-30T00:00:00Z')).reason, 'pilot_not_started');
  assert.equal(pilotGate(config, 'galgotias', Date.parse('2026-10-01T00:00:00Z')).reason, 'pilot_ended');
});
