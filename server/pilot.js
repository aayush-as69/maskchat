const DEFAULTS = {
  enabled: false,
  maxActiveUsers: 100,
  supportContact: '',
  startAt: '',
  endAt: '',
  allowedInstitutions: [],
  requireMentorAcknowledgement: true,
  notice: 'MaskChat is running as a controlled institution pilot.'
};

function parseDate(value, label) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid ISO date/time.`);
  return time;
}

function parseList(value) {
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean).slice(0, 100);
}

export function loadPilotConfig(env = process.env) {
  const enabled = env.PILOT_MODE === '1' || String(env.PILOT_MODE || '').toLowerCase() === 'true';
  const maxActiveUsers = Number(env.PILOT_MAX_ACTIVE_USERS || DEFAULTS.maxActiveUsers);
  if (!Number.isInteger(maxActiveUsers) || maxActiveUsers < 1 || maxActiveUsers > 100000) {
    throw new Error('PILOT_MAX_ACTIVE_USERS must be an integer from 1 to 100000.');
  }
  return {
    enabled,
    maxActiveUsers,
    supportContact: String(env.PILOT_SUPPORT_CONTACT || '').trim().slice(0, 200),
    startAt: parseDate(env.PILOT_START_AT, 'PILOT_START_AT'),
    endAt: parseDate(env.PILOT_END_AT, 'PILOT_END_AT'),
    allowedInstitutions: parseList(env.PILOT_ALLOWED_INSTITUTIONS),
    requireMentorAcknowledgement: env.PILOT_REQUIRE_MENTOR_ACK !== '0',
    notice: String(env.PILOT_NOTICE || DEFAULTS.notice).trim().slice(0, 500) || DEFAULTS.notice
  };
}

export function pilotStatus(config, now = Date.now()) {
  const beforeStart = config.startAt !== null && now < config.startAt;
  const afterEnd = config.endAt !== null && now >= config.endAt;
  const active = config.enabled && !beforeStart && !afterEnd;
  return {
    enabled: config.enabled,
    active,
    phase: !config.enabled ? 'disabled' : beforeStart ? 'scheduled' : afterEnd ? 'ended' : 'active',
    startAt: config.startAt ? new Date(config.startAt).toISOString() : null,
    endAt: config.endAt ? new Date(config.endAt).toISOString() : null,
    maxActiveUsers: config.maxActiveUsers,
    allowedInstitutions: config.allowedInstitutions,
    requireMentorAcknowledgement: config.requireMentorAcknowledgement,
    supportContact: config.supportContact || null,
    notice: config.notice
  };
}

export function pilotAllowsInstitution(config, institutionId) {
  if (!config.allowedInstitutions.length) return true;
  return config.allowedInstitutions.includes(String(institutionId || ''));
}

export function pilotGate(config, institutionId, now = Date.now()) {
  const status = pilotStatus(config, now);
  if (!status.active) {
    return { ok: false, reason: status.phase === 'scheduled' ? 'pilot_not_started' : status.phase === 'ended' ? 'pilot_ended' : 'pilot_disabled' };
  }
  if (!pilotAllowsInstitution(config, institutionId)) return { ok: false, reason: 'institution_not_in_pilot' };
  return { ok: true };
}
