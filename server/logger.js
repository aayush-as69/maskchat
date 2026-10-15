// Phase 4: structured logging.
//
// Every call here writes a single JSON line to stdout - the format almost
// every log pipeline (CloudWatch Logs, Datadog, Loki, `journalctl -o json`,
// a plain `| tee app.log`) can parse without extra setup. Deliberately not
// pulling in a logging framework: the whole point of this file is to be
// small enough to read in one sitting and audit against the privacy model.
//
// Hard rule, enforced by convention here rather than by a filter (there is
// no message content anywhere near this file to accidentally leak): NEVER
// pass raw message text, raw email addresses, or a raw (non-hashed)
// identityKey into `log()`. Where an event needs to reference a person, use
// `shortHash()` below to log a short, one-way, truncated fingerprint instead
// - enough to correlate repeated events from the same identity in a log
// search, not enough to reverse back to an email.

import crypto from 'node:crypto';

const SERVICE = 'maskchat-server';
// Set by index.js at boot so every log line can be attributed to the
// process that emitted it once you're running more than one instance.
let instanceId = crypto.randomBytes(4).toString('hex');

export function setInstanceId(id) {
  instanceId = id;
}

/**
 * A short, truncated, one-way fingerprint of a sensitive value (an
 * identityKey, an alias) - just enough to spot "the same person again" in a
 * log search without it being reversible to who that person is. Truncated
 * to 10 hex chars on purpose: this is for correlation, not identification.
 */
export function shortHash(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function write(level, event, fields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    instance: instanceId,
    event,
    ...fields
  };
  const text = JSON.stringify(line);
  if (level === 'error') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

export const logger = {
  info(event, fields = {}) { write('info', event, fields); },
  warn(event, fields = {}) { write('warn', event, fields); },
  error(event, fields = {}) { write('error', event, fields); }
};
