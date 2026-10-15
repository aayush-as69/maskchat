import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIncident, incidentTransition, pilotKpis, pilotExitAssessment, PILOT_CHECKLIST } from './pilot-ops.js';

test('pilot checklist contains required operational gates', () => {
  assert.ok(PILOT_CHECKLIST.length >= 6);
  assert.ok(PILOT_CHECKLIST.every((item) => item.required));
});

test('incident normalization rejects invalid severity and short summaries', () => {
  assert.throws(() => normalizeIncident({ severity: 'extreme', summary: 'bad' }));
  assert.throws(() => normalizeIncident({ severity: 'high', summary: 'x' }));
  assert.deepEqual(normalizeIncident({ severity: 'high', summary: 'Database latency observed' }), {
    severity: 'high', state: 'open', summary: 'Database latency observed', institutionId: null, category: 'operational', action: null
  });
});

test('incident transitions only move forward toward resolution', () => {
  assert.equal(incidentTransition('open', 'contained'), true);
  assert.equal(incidentTransition('contained', 'resolved'), true);
  assert.equal(incidentTransition('resolved', 'open'), false);
});

test('pilot KPI calculations avoid divide-by-zero', () => {
  assert.equal(pilotKpis({}).matchSuccessRate, null);
  const k = pilotKpis({ connections_total: 20, matches_attempted: 10, matches_succeeded: 8, messages_sent: 90, messages_blocked: 10, reports_filed: 2, pilot_verified: 15 });
  assert.equal(k.matchSuccessRate, 0.8);
  assert.equal(k.messageBlockRate, 0.1);
  assert.equal(k.pilotVerified, 15);
});

test('pilot exit assessment holds on unresolved incidents or alerts', () => {
  const result = pilotExitAssessment({ kpis: { connections: 10 }, alerts: [{ type: 'http_latency_p95' }], incidents: [{ severity: 'high', state: 'open' }] });
  assert.equal(result.status, 'hold');
  assert.ok(result.reasons.length >= 2);
  const clear = pilotExitAssessment({ kpis: { connections: 10 }, alerts: [], incidents: [] });
  assert.equal(clear.status, 'ready_for_review');
});
