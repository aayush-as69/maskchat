const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const INCIDENT_STATES = ['open', 'contained', 'resolved'];

export const PILOT_CHECKLIST = [
  { id: 'auth', label: 'Institution authentication verified', required: true },
  { id: 'moderation', label: 'Moderator coverage and escalation contact confirmed', required: true },
  { id: 'backup', label: 'Latest PostgreSQL backup verified', required: true },
  { id: 'restore', label: 'Recent restore drill completed', required: true },
  { id: 'alerts', label: 'Operational alerts tested', required: true },
  { id: 'capacity', label: 'Pilot capacity and load-test thresholds reviewed', required: true },
  { id: 'support', label: 'Student support route published', required: true },
  { id: 'privacy', label: 'Privacy/retention policy reviewed with institution', required: true }
];

export function normalizeIncident(input = {}) {
  const severity = String(input.severity || 'medium').toLowerCase();
  const state = String(input.state || 'open').toLowerCase();
  if (!SEVERITIES.includes(severity)) throw new Error('Invalid incident severity.');
  if (!INCIDENT_STATES.includes(state)) throw new Error('Invalid incident state.');
  const summary = String(input.summary || '').trim().slice(0, 500);
  if (summary.length < 5) throw new Error('Incident summary must be at least 5 characters.');
  return {
    severity,
    state,
    summary,
    institutionId: String(input.institutionId || '').trim().slice(0, 100) || null,
    category: String(input.category || 'operational').trim().slice(0, 80),
    action: String(input.action || '').trim().slice(0, 500) || null
  };
}

export function incidentTransition(current, next) {
  const from = current || 'open';
  if (!INCIDENT_STATES.includes(from) || !INCIDENT_STATES.includes(next)) return false;
  if (from === 'resolved') return next === 'resolved';
  if (from === 'open') return next === 'open' || next === 'contained' || next === 'resolved';
  if (from === 'contained') return next === 'contained' || next === 'resolved';
  return false;
}

export function pilotKpis(counters = {}) {
  const n = (key) => Math.max(0, Number(counters[key] || 0));
  const attempted = n('matches_attempted');
  const succeeded = n('matches_succeeded');
  const messages = n('messages_sent');
  const blocked = n('messages_blocked');
  const reports = n('reports_filed');
  const denied = n('pilot_gate_pilot_not_started') + n('pilot_gate_pilot_ended') + n('pilot_gate_institution_not_in_pilot') + n('pilot_capacity_denied');
  return {
    connections: n('connections_total'),
    matchesAttempted: attempted,
    matchesSucceeded: succeeded,
    matchSuccessRate: attempted ? Number((succeeded / attempted).toFixed(4)) : null,
    messagesSent: messages,
    messagesBlocked: blocked,
    messageBlockRate: (messages + blocked) ? Number((blocked / (messages + blocked)).toFixed(4)) : null,
    reportsFiled: reports,
    pilotAccessDenied: denied,
    pilotVerified: n('pilot_verified')
  };
}

export function pilotExitAssessment({ kpis = {}, alerts = [], incidents = [] } = {}) {
  const openCritical = incidents.some((x) => x.severity === 'critical' && x.state !== 'resolved');
  const openHigh = incidents.some((x) => x.severity === 'high' && x.state !== 'resolved');
  const hardAlerts = alerts.filter((x) => ['http_error_rate', 'http_latency_p95', 'event_loop_lag'].includes(x.type));
  const gates = {
    criticalIncidentClear: !openCritical,
    highIncidentClear: !openHigh,
    operationalAlertsClear: hardAlerts.length === 0,
    hasTraffic: Number(kpis.connections || 0) > 0
  };
  return {
    gates,
    status: Object.values(gates).every(Boolean) ? 'ready_for_review' : 'hold',
    reasons: [
      ...(!gates.criticalIncidentClear ? ['Unresolved critical incident.'] : []),
      ...(!gates.highIncidentClear ? ['Unresolved high-severity incident.'] : []),
      ...(!gates.operationalAlertsClear ? ['Active operational alert conditions remain.'] : []),
      ...(!gates.hasTraffic ? ['No pilot traffic has been recorded yet.'] : [])
    ]
  };
}
