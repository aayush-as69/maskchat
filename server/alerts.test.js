import test from 'node:test';
import assert from 'node:assert/strict';
import { alertConfig, resetAlertCooldownsForTests, sendAlert } from './alerts.js';

test('alerts are safely disabled without a Slack webhook', async () => {
  resetAlertCooldownsForTests();
  const config = alertConfig();
  if (!process.env.SLACK_ALERT_WEBHOOK_URL) {
    assert.equal(config.enabled, false);
    const result = await sendAlert('test_alert', { ok: true });
    assert.equal(result.configured, false);
  }
});
