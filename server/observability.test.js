import test from 'node:test';
import assert from 'node:assert/strict';
import { observeHttp, observeSocketEvent, snapshot, evaluateAlerts, resetObservabilityForTests } from './observability.js';

test('observability records HTTP latency and error rate', () => {
  resetObservabilityForTests();
  observeHttp({ method: 'GET', route: '/api/health', status: 200, durationMs: 20 });
  observeHttp({ method: 'GET', route: '/api/admin/dashboard', status: 500, durationMs: 1800 });
  const s = snapshot();
  assert.equal(s.http.requests, 2);
  assert.equal(s.http.errors5xx, 1);
  assert.equal(s.http.errorRate5xx, 0.5);
  assert.equal(s.http.latencyMs.p95, 1800);
  assert.ok(Number.isFinite(s.process.eventLoopP99Ms));
});

test('observability records socket failures and alert conditions', () => {
  resetObservabilityForTests();
  for (let i = 0; i < 10; i += 1) observeHttp({ method: 'POST', route: '/api/test', status: 500, durationMs: 2000 });
  observeSocketEvent('match:request', 42, false);
  const s = snapshot();
  assert.equal(s.socket.errors, 1);
  const alerts = evaluateAlerts(s);
  assert.ok(alerts.some((a) => a.type === 'http_error_rate'));
  assert.ok(alerts.some((a) => a.type === 'http_latency_p95'));
});
