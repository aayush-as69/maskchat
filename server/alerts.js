// Phase 10 operational alerts. Slack is deliberately optional: when no
// webhook is configured, alerts are logged but never break request handling.
import { logger } from './logger.js';

const webhookUrl = String(process.env.SLACK_ALERT_WEBHOOK_URL || '').trim();
const cooldownMs = Number(process.env.ALERT_COOLDOWN_MS || 15 * 60_000);
const lastSent = new Map();

export function alertConfig() {
  return { enabled: Boolean(webhookUrl), cooldownMs };
}

export async function sendAlert(type, fields = {}) {
  const now = Date.now();
  const previous = lastSent.get(type) || 0;
  if (now - previous < cooldownMs) {
    logger.info('alert.suppressed', { type, cooldownMs });
    return { sent: false, suppressed: true };
  }

  lastSent.set(type, now);
  const payload = {
    text: `[MaskChat alert] ${type}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*MaskChat alert:* ${type}` } }]
  };
  if (Object.keys(fields).length) {
    payload.blocks.push({ type: 'section', fields: Object.entries(fields).slice(0, 10).map(([key, value]) => ({ type: 'mrkdwn', text: `*${key}:* ${String(value).slice(0, 500)}` })) });
  }

  if (!webhookUrl) {
    logger.warn('alert.not_configured', { type });
    return { sent: false, configured: false };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Slack webhook returned HTTP ${response.status}`);
    logger.info('alert.sent', { type });
    return { sent: true };
  } catch (error) {
    logger.error('alert.send_failed', { type, error: error.message });
    return { sent: false, error: error.message };
  }
}

export function resetAlertCooldownsForTests() {
  lastSent.clear();
}
