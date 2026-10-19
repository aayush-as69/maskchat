import 'dotenv/config';
import crypto from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import {
  dailyAlias,
  identityKey,
  createOffenderRef,
  verifyInstitutionVerificationToken,
  detectViolation,
  moderationPolicy,
  sanitizeTags,
  tagScore,
  sanitizeReportReason,
  sanitizeReportDetails,
  sanitizeReportMessages,
  sanitizeCapacity,
  sanitizeYear,
  buildMentorCard,
  buildMentorRecognition,
  sanitizeTopicType,
  sanitizeExpertise,
  sanitizeSchedule,
  buildReopenedMentorEntry,
  groupRoomHasOpenSeat,
  MAX_GROUP_CAPACITY
} from './core.js';
import { createMemoryStore, createRedisStore, createDurableStore, withLock } from './store.js';
import { createPostgresStore } from './postgres.js';
import { logger, setInstanceId, shortHash } from './logger.js';
import { sendAlert } from './alerts.js';
import { loadInstitutions, resolveInstitutionByEmail, resolveInstitutionById, publicInstitutionList } from './institutions.js';
import { loadResources, resourcesFor } from './resources.js';
import { loadPilotConfig, pilotStatus, pilotGate } from './pilot.js';
import { PILOT_CHECKLIST, normalizeIncident, incidentTransition, pilotKpis, pilotExitAssessment } from './pilot-ops.js';
import { observeHttp, snapshot as observabilitySnapshot, evaluateAlerts as evaluateObservabilityAlerts, timed, elapsed } from './observability.js';
import { loadOidcConfig, createOidcState, buildAuthorizationUrl, authenticateOidcCallback } from './oidc.js';

const PORT = Number(process.env.PORT || 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:3001';
const ALIAS_SECRET = process.env.ALIAS_SECRET || 'maskchat-development-secret';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const AUTH_MODE = process.env.AUTH_MODE || (process.env.NODE_ENV === 'production' ? 'trusted-token' : 'development');
// Unknown email domains are only accepted (as throwaway demo institutions) in development auth mode.
const ALLOW_DEMO_INSTITUTIONS = AUTH_MODE === 'development';
// Development gets a random per-process secret so the session cookie works out of the box;
// production must configure one explicitly (validated at startup).
const IDENTITY_VERIFICATION_SECRET = process.env.IDENTITY_VERIFICATION_SECRET || (AUTH_MODE === 'development' ? crypto.randomBytes(32).toString('hex') : '');
const OFFENDER_REF_SECRET = process.env.OFFENDER_REF_SECRET || IDENTITY_VERIFICATION_SECRET || ALIAS_SECRET;
const REQUIRE_HTTPS = process.env.REQUIRE_HTTPS === '1' || (process.env.NODE_ENV === 'production' && process.env.REQUIRE_HTTPS !== '0');
// Cookie SameSite policy. Keep 'Lax' when the client and API share a site (same domain or
// sibling subdomains such as app.example.com + api.example.com). Use COOKIE_SAMESITE=None only
// when the client (e.g. *.vercel.app) is on a different site than the API; this forces Secure.
const COOKIE_SAMESITE = ({ none: 'None', strict: 'Strict', lax: 'Lax' })[String(process.env.COOKIE_SAMESITE || 'lax').toLowerCase()] || 'Lax';
const HTTP_BODY_LIMIT = process.env.HTTP_BODY_LIMIT || '32kb';
const HTTP_RATE_LIMIT = Number(process.env.HTTP_RATE_LIMIT || 120);
const HTTP_RATE_WINDOW_MS = Number(process.env.HTTP_RATE_WINDOW_MS || 60_000);
const httpRateBuckets = new Map();
const POSTGRES_URL = process.env.POSTGRES_URL || '';
const POSTGRES_SSL = process.env.POSTGRES_SSL === '1';
const POSTGRES_POOL_MAX = Number(process.env.POSTGRES_POOL_MAX || 10);
const REQUIRE_POSTGRES = process.env.REQUIRE_POSTGRES === '1' || process.env.NODE_ENV === 'production';
const RETENTION_REPORT_DAYS = Number(process.env.RETENTION_REPORT_DAYS || 90);
const RETENTION_AUDIT_DAYS = Number(process.env.RETENTION_AUDIT_DAYS || 365);
const RETENTION_FEEDBACK_DAYS = Number(process.env.RETENTION_FEEDBACK_DAYS || 180);
const ABUSE_REPORT_LIMIT = Number(process.env.ABUSE_REPORT_LIMIT || 5);
const ABUSE_REPORT_WINDOW_MS = Number(process.env.ABUSE_REPORT_WINDOW_MS || 10 * 60_000);
const ABUSE_FEEDBACK_LIMIT = Number(process.env.ABUSE_FEEDBACK_LIMIT || 8);
const ABUSE_FEEDBACK_WINDOW_MS = Number(process.env.ABUSE_FEEDBACK_WINDOW_MS || 10 * 60_000);
const ABUSE_MATCH_LIMIT = Number(process.env.ABUSE_MATCH_LIMIT || 12);
const ABUSE_MATCH_WINDOW_MS = Number(process.env.ABUSE_MATCH_WINDOW_MS || 60_000);
const OIDC = loadOidcConfig();
// --- Phase 5: multi-institution support -----------------------------------
// Replaces the single hardcoded INSTITUTION_DOMAIN. See institutions.js -
// set INSTITUTIONS (JSON array of {id?, name, domain}) to serve more than
// one college from the same deployment; unset, it falls back to the
// original single Galgotias entry. Matching is always isolated per
// institution (see the institutionId filters in the socket handlers below) -
// there is no cross-institution matching pool.
const INSTITUTIONS = loadInstitutions();
const RESOURCES = loadResources();
const PILOT = loadPilotConfig();
const moderatorAlerts = [];
function noteModeratorAlert(type, data = {}) {
  const alert = { id: crypto.randomUUID(), type, createdAt: Date.now(), read: false, ...data };
  moderatorAlerts.unshift(alert);
  if (moderatorAlerts.length > 100) moderatorAlerts.length = 100;
  return alert;
}
const START_TIME = Date.now();
// Phase 11: browser push subscriptions. The subscription itself contains no
// campus email or alias. Actual Web Push delivery can be enabled by deploying
// a Web Push provider/VAPID key pair; active-tab match notifications continue
// to work through the browser Notification API without that provider.

// --- Phase 4: observability configuration ---------------------------------
// A distinct id per process so log lines and future multi-instance
// dashboards can tell which server instance emitted an event. Defaults to a
// random id; set INSTANCE_ID explicitly in orchestrated deployments (e.g.
// to the container/pod name) so it's stable across restarts.
const INSTANCE_ID = process.env.INSTANCE_ID || `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
setInstanceId(INSTANCE_ID);
// How often to emit a rolled-up metrics snapshot to the logs, on top of the
// on-demand /api/metrics endpoint - useful for log-based dashboards/alerts
// (CloudWatch Logs Insights, Datadog log processing, etc.) that don't poll
// an HTTP endpoint. Set to 0 to disable periodic snapshots entirely.
const METRICS_LOG_INTERVAL_MS = Number(process.env.METRICS_LOG_INTERVAL_MS || 60_000);
const REPORT_SPIKE_THRESHOLD = Number(process.env.REPORT_SPIKE_THRESHOLD || 10);
const REPORT_SPIKE_WINDOW_MS = Number(process.env.REPORT_SPIKE_WINDOW_MS || 5 * 60_000);
const reportSpikeEvents = [];
function noteReportForAlert(institutionId) {
  const now = Date.now();
  reportSpikeEvents.push({ now, institutionId });
  while (reportSpikeEvents.length && now - reportSpikeEvents[0].now > REPORT_SPIKE_WINDOW_MS) reportSpikeEvents.shift();
  const total = reportSpikeEvents.length;
  if (total >= REPORT_SPIKE_THRESHOLD) {
    noteModeratorAlert('report_spike', { institutionId, message: 'Safety reports have spiked.' });
    void sendAlert('report_spike', { reportsInWindow: total, windowMinutes: Math.round(REPORT_SPIKE_WINDOW_MS / 60000), institution: institutionId || 'unknown' });
  }
}

// --- Phase 2: scaling configuration ---------------------------------------
// Unset: single process, in-memory state (identical to Phase 1 behavior).
// Set to a redis:// URL: state moves to Redis and Socket.io gets a Redis
// adapter, so any number of instances behind a load balancer share
// matchmaking, rooms, rate limits, cooldowns, and reports. See README.md
// ("Running multiple instances") before using this in production.
const REDIS_URL = process.env.REDIS_URL || '';
// Set when the app sits behind a reverse proxy/load balancer terminating
// TLS (nginx, a cloud load balancer, etc.) - needed for req.secure, correct
// client IPs, and secure cookies to work.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// Only needed if this process should terminate TLS itself (no proxy in
// front of it). Most deployments behind a load balancer should leave these
// unset and set TRUST_PROXY=1 instead.
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || '';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || '';

// --- Phase 1: trust & safety configuration --------------------------------
const MATCH_ACTION_LIMIT = 6; // mentor:available / match:request / demo:start
const MATCH_ACTION_WINDOW_MS = 60_000;
const MESSAGE_LIMIT = 30;
const MESSAGE_WINDOW_MS = 10_000;
const VIOLATION_THRESHOLD = 3; // blocked messages before a cooldown kicks in
const VIOLATION_WINDOW_MS = 10 * 60_000;
const COOLDOWN_MS = 15 * 60_000;

// --- Phase 3: product depth configuration ---------------------------------
// How long a room stays open after a participant's socket disconnects
// before it's actually torn down - long enough to survive a page refresh
// or a brief network blip and rejoin (see 'session:rejoin'), short enough
// that a real walk-away still frees up the room quickly.
const DISCONNECT_GRACE_MS = 25_000;

function safeTokenEqual(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Admin access is not configured on this server.' });
  if (!safeTokenEqual(req.get('x-admin-token'), ADMIN_TOKEN)) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}

function requestIp(req) { return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 96); }
function parseCookies(value = '') {
  const cookies = {};
  for (const part of String(value).split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!key) continue;
    try { cookies[key] = decodeURIComponent(raw); } catch { cookies[key] = raw; }
  }
  return cookies;
}

function setCookie(res, name, value, { maxAge = 300, path = '/', httpOnly = true, secure = REQUIRE_HTTPS, sameSite = COOKIE_SAMESITE } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${Math.max(0, Math.floor(maxAge))}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure || sameSite === 'None') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name, path = '/') {
  setCookie(res, name, '', { maxAge: 0, path });
}

function consumeHttpRate(req) {
  const key = requestIp(req); const now = Date.now();
  const kept = (httpRateBuckets.get(key) || []).filter((t) => now - t < HTTP_RATE_WINDOW_MS);
  if (kept.length >= HTTP_RATE_LIMIT) { httpRateBuckets.set(key, kept); return false; }
  kept.push(now); httpRateBuckets.set(key, kept);
  return true;
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (REQUIRE_HTTPS) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (REQUIRE_HTTPS && !req.secure) return res.status(400).json({ error: 'HTTPS is required.' });
  next();
}

function offenderRefForIdentity(identity) {
  return identity ? createOffenderRef(identity, OFFENDER_REF_SECRET) : null;
}

function redactAdminIdentity(report) {
  if (!report) return report;
  const copy = { ...report };
  if (copy.reportedIdentityKey) {
    copy.reportedOffenderRef = createOffenderRef(copy.reportedIdentityKey, OFFENDER_REF_SECRET);
    delete copy.reportedIdentityKey;
  }
  return copy;
}

async function resolveIdentityFromRef(store, ref) {
  if (!/^[a-f0-9]{24}$/.test(String(ref || ''))) return null;
  const offenders = await store.listOffenders();
  return offenders.find((entry) => createOffenderRef(entry.identityKey, OFFENDER_REF_SECRET) === ref)?.identityKey || null;
}

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(serverDirectory, '../client/dist');
const allowedOrigins = new Set([
  ...CLIENT_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean),
]);
if (process.env.NODE_ENV !== 'production') {
  ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173', 'http://localhost:3001', 'http://127.0.0.1:3001']
    .forEach((origin) => allowedOrigins.add(origin));
}
const corsOptions = {
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by MaskChat.'));
  }
};

// Everything that needs Redis is set up inside this async bootstrap, because
// connecting a Redis client (and building the Socket.io adapter from it) is
// asynchronous, and ioredis / @socket.io/redis-adapter are only imported
// (via dynamic import) when REDIS_URL is actually set - a plain single
// instance dev setup never needs those packages installed at all.
function issueInstitutionVerificationToken(email, expiresInSeconds = 300) {
  const payload = Buffer.from(JSON.stringify({ email: String(email).trim().toLowerCase(), exp: Math.floor(Date.now() / 1000) + Math.max(60, Math.min(300, expiresInSeconds)) })).toString('base64url');
  const signature = crypto.createHmac('sha256', IDENTITY_VERIFICATION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', { error: reason instanceof Error ? reason.stack || reason.message : String(reason) });
});

async function main() {
  if (process.env.NODE_ENV === 'production') {
    if (ALIAS_SECRET.length < 32) throw new Error('ALIAS_SECRET must be at least 32 characters in production.');
    if (!IDENTITY_VERIFICATION_SECRET || IDENTITY_VERIFICATION_SECRET.length < 32) throw new Error('IDENTITY_VERIFICATION_SECRET must be configured in production.');
    if (AUTH_MODE !== 'trusted-token') throw new Error('Production AUTH_MODE must be trusted-token.');
    if (OIDC.enabled && !OIDC.postLoginRedirect) throw new Error('OIDC_POST_LOGIN_REDIRECT must be configured when OIDC is enabled.');
    if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 32) throw new Error('ADMIN_TOKEN must be at least 32 characters in production.');
  }
  const app = express();
  if (TRUST_PROXY) app.set('trust proxy', 1);
  app.use(cors(corsOptions));
  app.use(securityHeaders);
  app.use(express.json({ limit: HTTP_BODY_LIMIT, strict: true }));

  let httpServer;
  if (SSL_KEY_PATH && SSL_CERT_PATH) {
    httpServer = createHttpsServer({ key: fs.readFileSync(SSL_KEY_PATH), cert: fs.readFileSync(SSL_CERT_PATH) }, app);
  } else {
    httpServer = createHttpServer(app);
  }

  const io = new Server(httpServer, { cors: { ...corsOptions, methods: ['GET', 'POST'] }, maxHttpBufferSize: 64 * 1024 });

  let store;
  let redisClients = [];
  if (REDIS_URL) {
    const { default: Redis } = await import('ioredis');
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const dataClient = new Redis(REDIS_URL);
    const pubClient = new Redis(REDIS_URL);
    const subClient = pubClient.duplicate();
    redisClients = [dataClient, pubClient, subClient];
    await Promise.all(redisClients.map((client) => new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    })));
    io.adapter(createAdapter(pubClient, subClient));
    store = createRedisStore(dataClient);
    console.log('MaskChat: using Redis-backed store and Socket.io adapter.');
  } else {
    store = createMemoryStore();
    console.log('MaskChat: using in-memory store (single instance only).');
  }

  if (POSTGRES_URL) {
    const durable = await createPostgresStore({ url: POSTGRES_URL, ssl: POSTGRES_SSL, max: POSTGRES_POOL_MAX });
    store = createDurableStore(store, durable);
    console.log('MaskChat: using PostgreSQL for durable reports, moderation, feedback, schedules and audit events.');
  } else if (REQUIRE_POSTGRES) {
    throw new Error('POSTGRES_URL must be configured for production.');
  }

  // Phase 18: distributed HTTP abuse protection. Unlike the earlier local
  // prototype limiter, this one uses the selected store and therefore shares
  // limits across instances when Redis is enabled.
  app.use(async (req, res, next) => {
    const started = timed();
    const finish = () => observeHttp({ method: req.method, route: req.route?.path || req.path, status: res.statusCode, durationMs: elapsed(started) });
    res.once('finish', finish);
    res.once('close', () => { if (!res.writableFinished) observeHttp({ method: req.method, route: req.route?.path || req.path, status: res.statusCode || 499, durationMs: elapsed(started) }); });
    const ip = requestIp(req);
    if (!(await store.consumeRate(`http:${ip}`, HTTP_RATE_LIMIT, HTTP_RATE_WINDOW_MS))) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  });

  // Phase 17: retention is explicit and configurable. It never runs against
  // realtime rooms or aliases; it only removes durable records past their
  // declared operational retention windows.
  let retentionTimer = null;
  if (typeof store.retention === 'function') {
    const runRetention = async () => {
      try {
        const result = await store.retention({ reportDays: RETENTION_REPORT_DAYS, auditDays: RETENTION_AUDIT_DAYS, feedbackDays: RETENTION_FEEDBACK_DAYS });
        logger.info('privacy.retention', result);
      } catch (error) {
        logger.error('privacy.retention_failed', { error: error.message });
      }
    };
    await runRetention();
    retentionTimer = setInterval(runRetention, 24 * 60 * 60_000);
    retentionTimer.unref();
  }

  // --- Phase 4: structured logging & metrics --------------------------------
  // A tiny wrapper so call sites read as "count this thing happening" rather
  // than repeating the counter-name string logic everywhere. Counter names
  // are deliberately generic ("attempted"/"succeeded") so the same shape
  // works for match:request и mentor:available both feeding matches_*.
  async function count(name, by = 1) {
    try { await store.incrCounter(name, by); } catch (error) { logger.error('metrics.counter_failed', { name, error: error.message }); }
  }

  async function auditEvent(eventType, data = {}) {
    if (typeof store.audit !== 'function') return;
    try { await store.audit({ eventType, ...data }); }
    catch (error) { logger.error('audit.write_failed', { eventType, error: error.message }); }
  }

  // Gauge for "sockets connected right now" - a plain in-process counter is
  // correct even in multi-instance mode, since each instance only knows
  // about its own sockets; a cluster-wide total is the sum across
  // instances' /api/metrics responses, not a single shared number.
  let currentConnections = 0;

  // Turns raw cumulative counters into the ratios Phase 4 asks for
  // (match success rate, block-filter hit rate) without ever dividing by
  // zero - an empty pilot with no traffic yet should read as "no data", not
  // NaN or a crashed endpoint.
  function rate(numerator, denominator) {
    if (!denominator) return null;
    return Number((numerator / denominator).toFixed(4));
  }

  async function metricsSnapshot() {
    const counters = await store.getCounters();
    const get = (name) => counters[name] || 0;
    const matchesAttempted = get('matches_attempted');
    const matchesSucceeded = get('matches_succeeded');
    const matchesQueued = get('matches_queued');
    const messagesSent = get('messages_sent');
    const messagesBlocked = get('messages_blocked');
    const observability = observabilitySnapshot();
    return {
      uptimeSeconds: Math.round((Date.now() - START_TIME) / 1000),
      storage: store.kind,
      observability,
      connections: {
        current: currentConnections,
        totalSinceStart: get('connections_total')
      },
      matching: {
        attempted: matchesAttempted,
        succeeded: matchesSucceeded,
        queued: matchesQueued,
        successRate: rate(matchesSucceeded, matchesAttempted)
      },
      messages: {
        sent: messagesSent,
        blocked: messagesBlocked,
        blockRate: rate(messagesBlocked, messagesSent + messagesBlocked)
      },
      moderation: {
        violationsRecorded: get('violations_recorded'),
        cooldownsApplied: get('cooldowns_applied'),
        reportsFiled: get('reports_filed')
      },
      demoSessionsStarted: get('demo_sessions_started')
    };
  }

  let metricsTimer = null;
  if (METRICS_LOG_INTERVAL_MS > 0) {
    metricsTimer = setInterval(async () => {
      try {
        const metrics = await metricsSnapshot();
        logger.info('metrics.snapshot', metrics);
        for (const alert of evaluateObservabilityAlerts(metrics.observability)) {
          noteModeratorAlert(alert.type, { message: `Operational threshold exceeded: ${alert.type}.`, value: alert.value, threshold: alert.threshold });
          void sendAlert(alert.type, alert);
        }
      } catch (error) {
        logger.error('metrics.snapshot_failed', { error: error.message });
      }
    }, METRICS_LOG_INTERVAL_MS).unref();
  }

  function cooldownError(until) {
    const minutesLeft = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
    return `You've been temporarily paused after repeated policy violations. Try again in about ${minutesLeft} minute(s).`;
  }

  // Ends a room for every participant, wherever their socket happens to be
  // connected. `io.to(...)`/`io.in(...).socketsLeave(...)` are adapter-aware:
  // with the Redis adapter they reach sockets on any instance, not just this
  // process - so this is safe to call regardless of which instance a given
  // participant's socket lives on.
  async function closeRoom(roomId, reason = 'ended', feedback = null) {
    const room = await store.getRoom(roomId);
    if (!room) return;
    const summary = { topic: (room.tags || [])[0] || 'General support', tags: room.tags || [], durationSeconds: Math.max(0, Math.floor((Date.now() - (room.startedAt || Date.now())) / 1000)), participants: room.participants?.length || 0, feedback: feedback || null };
    io.to(roomId).emit('session:summary', summary);
    io.to(roomId).emit('session:ended', { reason });
    for (const socketId of room.participants) {
      io.in(socketId).socketsLeave(roomId);
    }
    await store.deleteRoom(roomId);
    // Phase 5: a group room that closes before reaching capacity might still
    // have a live mentor entry pointing at it (see matchSeekerToMentor) -
    // drop it too so nobody else tries to join a room that no longer exists.
    // Keyed by mentorEntryKey (the socket id the mentor entry was stored
    // under at match time), not the mentor's current socket id, since a
    // session:rejoin changes the latter without touching the mentors map.
    if (room.isGroup) {
      await store.deleteMentor(room.mentorEntryKey);
      const currentMentor = currentMentorSocketId(room);
      if (currentMentor && currentMentor !== room.mentorEntryKey) await store.deleteMentor(currentMentor);
    }
    logger.info('session.closed', { reason, demo: !!room.demo, participantCount: room.participants.length });
  }

  // Finds whichever current socket id corresponds to the room's mentor, by
  // identity rather than a stored socket id - a mentor's socket id changes
  // across a refresh/session:rejoin, but their identityKey never does.
  // Demo rooms have no mentorIdentityKey (there is no real mentor), so this
  // correctly returns undefined for them.
  function currentMentorSocketId(room) {
    if (!room.mentorIdentityKey) return undefined;
    return Object.keys(room.identities || {}).find((id) => room.identities[id] === room.mentorIdentityKey);
  }

  // Phase 5: removes one participant from a group room without ending it
  // for everyone else - the group equivalent of "hanging up". Falls back to
  // a full closeRoom when there's nobody left to keep the room open for
  // (a non-group room, or a group room already down to its last pair), so
  // classic 1:1 behavior (either side leaving ends it for both) is unchanged.
  async function leaveRoom(roomId, leavingSocketId, reason = 'left') {
    const peeked = await store.getRoom(roomId);
    if (!peeked) return;
    if (!peeked.isGroup || peeked.participants.length <= 2) {
      await closeRoom(roomId, reason);
      return;
    }

    // Removing a seeker and reopening their seat is a read-modify-write on
    // the room, racing against a joiner's own read-modify-write (which would
    // otherwise overwrite the removal, or count seats off a stale list). It
    // takes the same per-mentor lock as the join path for that reason.
    let reopenedEntry = null;
    const remove = async () => {
      const room = await store.getRoom(roomId); // re-read: it may have changed while we waited
      if (!room || !room.participants.includes(leavingSocketId)) return 'gone';
      if (room.participants.length <= 2) return 'close';
      const alias = room.aliases[leavingSocketId];
      room.participants = room.participants.filter((id) => id !== leavingSocketId);
      delete room.aliases[leavingSocketId];
      delete room.identities[leavingSocketId];
      reopenedEntry = await reopenGroupSeat(roomId, room);
      await store.setRoom(roomId, room);
      io.to(leavingSocketId).emit('session:ended', { reason });
      io.in(leavingSocketId).socketsLeave(roomId);
      io.to(roomId).emit('peer:left', { alias, remaining: room.participants.length });
      logger.info('session.participant_left', { reason, remaining: room.participants.length, seatReopened: !!reopenedEntry });
      return 'left';
    };
    // If the lock can't be had, still let the person leave (unlocked, the
    // old behavior) rather than trap them in the room.
    const outcome = (await withLock(store, mentorLockKey(peeked.mentorIdentityKey), remove, {
      onTimeout: () => logger.warn('room.leave_lock_timeout', {})
    })) ?? await remove();
    if (outcome === 'close') await closeRoom(roomId, reason);
    // A seat just opened, so anyone already waiting for this mentor's
    // subjects can take it now instead of needing to ask again. Done after
    // the lock is released: matching takes the same lock.
    if (reopenedEntry) await tryMatchWaitingSeekers(reopenedEntry);
  }

  // The lock is per mentor *identity*, not per socket id: a mentor's socket
  // id changes across a refresh, and one mentor's join/leave/reopen steps
  // must all serialize against each other regardless.
  const mentorLockKey = (identityKey) => `mentor:${identityKey}`;

  function profileMatchScore(request, mentor) {
    let score = tagScore(request.tags || [], mentor.tags || []) * 10;
    if ((request.topicType || 'academic') === (mentor.topicType || 'academic')) score += 4;
    if (request.year && mentor.year && Number(request.year) === Number(mentor.year)) score += 2;
    if (request.expertise && mentor.expertise === request.expertise) score += 1;
    return score;
  }

  function mentorPublicCardFields(mentor) {
    return { expertise: mentor.expertise || 'intermediate', topicType: mentor.topicType || 'academic' };
  }


  // Phase 5 fix: puts a group mentor back in the pool when a seat frees up.
  // Called with the mentor lock held, after `room` has had the leaver
  // removed but before it is saved (this may set room.mentorEntryKey /
  // clear room.poolClosedByFull on it, and the caller persists the room).
  // Returns the mentor's pool entry if they are (now) open for more
  // seekers, else null.
  //
  // Reopens only when it is safe to assume the mentor still wants seekers:
  //  - they still have a pool entry (never filled up): just refresh its
  //    seekerCount, or
  //  - we removed them ourselves because the room filled up
  //    (room.poolClosedByFull, set in matchSeekerToMentor) and they are
  //    still connected. A mentor who chose 'mentor:unavailable', or whose
  //    entry was cleared by a disconnect, is deliberately left out.
  async function reopenGroupSeat(roomId, room) {
    if (!groupRoomHasOpenSeat(room) || !room.mentorIdentityKey) return null;
    const existing = await store.getMentor(room.mentorEntryKey);
    if (existing) {
      const refreshed = buildReopenedMentorEntry({ roomId, room, mentorSocketId: existing.socketId, existing });
      await store.setMentor(existing.socketId, refreshed);
      return refreshed;
    }
    if (!room.poolClosedByFull) return null;
    const mentorSocketId = currentMentorSocketId(room);
    // fetchSockets is adapter-aware, so this also works when the mentor's
    // socket lives on a different instance.
    if (!mentorSocketId || (await io.in(mentorSocketId).fetchSockets()).length === 0) return null;
    const entry = buildReopenedMentorEntry({ roomId, room, mentorSocketId });
    await store.setMentor(mentorSocketId, entry);
    room.mentorEntryKey = mentorSocketId;
    room.poolClosedByFull = false;
    return entry;
  }

  async function applyCooldown(socket, key, violationCount = VIOLATION_THRESHOLD) {
    const multiplier = violationCount >= 10 ? 96 : violationCount >= 6 ? 4 : 1;
    const durationMs = Math.min(COOLDOWN_MS * multiplier, 24 * 60 * 60_000);
    const until = Date.now() + durationMs;
    await store.setCooldown(key, until);
    const roomIds = await store.findRoomIdsBySocket(socket.id);
    await Promise.all(roomIds.map((roomId) => closeRoom(roomId, 'abuse_cooldown')));
    socket.emit('account:cooldown', { until });
    await count('cooldowns_applied');
    logger.warn('cooldown.applied', { identity: shortHash(key), durationMs });
  }

  // Local map of pending grace-period disconnect timers, keyed by
  // `${roomId}:${socketId}`. This is per-process, but that's fine even in
  // Redis multi-instance mode: the check that runs when a timer fires reads
  // the shared room record, not this map, so a rejoin handled by a
  // *different* instance still prevents the close (see 'session:rejoin' and
  // the 'disconnect' handler below).
  const pendingDisconnects = new Map();

  // Recomputes every waiting seeker's place in line and pushes it to them.
  // Called whenever the queue's membership changes (join, cancel, match,
  // disconnect) so the UI can show a live position instead of a stale one.
  // Phase 5: position/total are scoped per institution - a seeker's queue
  // position should reflect their own college's line, not a number that
  // includes students they could never be matched with anyway.
  async function refreshQueuePositions() {
    const waiting = (await store.listWaitingSeekers()).sort((a, b) => a.joinedAt - b.joinedAt);
    const byInstitution = new Map();
    for (const entry of waiting) {
      const list = byInstitution.get(entry.institutionId) || [];
      list.push(entry);
      byInstitution.set(entry.institutionId, list);
    }
    for (const list of byInstitution.values()) {
      list.forEach((entry, index) => {
        io.to(entry.socketId).emit('queue:update', { position: index + 1, total: list.length });
      });
    }
  }

  // Adds one more seeker into an already-open group room's participant
  // list. Mutates the room object in place; the caller is responsible for
  // persisting it with store.setRoom.
  function addSeekerToRoom(room, seeker) {
    room.participants.push(seeker.socketId);
    room.aliases[seeker.socketId] = seeker.alias;
    room.identities[seeker.socketId] = seeker.identityKey;
  }

  // Builds the anonymous profile card a seeker sees for their mentor.
  // `year` is the mentor's optional self-declared year of study.
  async function mentorCardFor({ identityKey, tags, year, seatsFilled, capacity }) {
    const [stats, sessionsHosted, mentors] = await Promise.all([
      store.getFeedbackStats(identityKey),
      store.getHosted(identityKey),
      store.listMentors()
    ]);
    const mentor = mentors.find((entry) => entry.identityKey === identityKey);
    return buildMentorCard({ tags, year, sessionsHosted, helpful: stats.up, seatsFilled, capacity, expertise: mentor?.expertise, topicType: mentor?.topicType, badges: buildMentorRecognition({ helpful: stats.up, sessionsHosted }) });
  }

  // Creates the room for a mentor's *first* seeker - identical for a
  // classic 1:1 match and the opening seeker of a group session, since a
  // group room only starts to look different once a second seeker joins it.
  // Phase 3's `identities` map (needed for session:rejoin) and
  // `mentorIdentityKey` (needed for post-session feedback attribution, and
  // now also for currentMentorSocketId) are set up identically either way.
  async function openRoomWithFirstSeeker({ mentor, firstSeeker, capacity }) {
    const roomId = crypto.randomUUID();
    io.in(firstSeeker.socketId).socketsJoin(roomId);
    io.in(mentor.socketId).socketsJoin(roomId);
    const isGroup = capacity > 1;
    // Phase 5: a group room's persistent `tags` describe the mentor's
    // offered subjects (shared across every seeker who joins), matching
    // what other seekers were scored against. A classic 1:1 room keeps the
    // original behavior of recording the seeker's own requested tags.
    const tags = isGroup ? mentor.tags : firstSeeker.tags;
    const room = {
      participants: [mentor.socketId, firstSeeker.socketId],
      aliases: { [mentor.socketId]: mentor.alias, [firstSeeker.socketId]: firstSeeker.alias },
      identities: { [mentor.socketId]: mentor.identityKey, [firstSeeker.socketId]: firstSeeker.identityKey },
      mentorIdentityKey: mentor.identityKey,
      mentorEntryKey: mentor.socketId,
      mentorYear: sanitizeYear(mentor.year),
      mentorTags: mentor.tags,
      mentorExpertise: mentor.expertise || 'intermediate',
      mentorTopicType: mentor.topicType || 'academic',
      mentorSchedule: mentor.schedule || [],
      mentorScheduleId: mentor.scheduleId || null,
      // Phase 5: both sides of a room are always the same institution (see
      // the filters in match:request/tryMatchWaitingSeekers), so one id is
      // enough to record here - used for admin/report filtering.
      institutionId: firstSeeker.institutionId ?? mentor.institutionId,
      isGroup,
      capacity,
      tags,
      createdAt: Date.now()
    };
    await store.setRoom(roomId, room);
    // Counted when the room opens, so it reflects sessions the mentor was
    // actually matched into (the card then shows the fresh total).
    await store.incrHosted(mentor.identityKey);
    const mentorCard = await mentorCardFor({ identityKey: mentor.identityKey, tags: mentor.tags, year: mentor.year, seatsFilled: 1, capacity });
    io.to(firstSeeker.socketId).emit('match:found', { roomId, peer: mentor.alias, peers: [mentor.alias], tags, isGroup, capacity, seekerCount: 1, startedAt: room.createdAt, mentorCard });
    io.to(mentor.socketId).emit('match:found', { roomId, peer: firstSeeker.alias, peers: [firstSeeker.alias], tags, isGroup, capacity, seekerCount: 1, startedAt: room.createdAt });
    await count('matches_succeeded');
    logger.info('match.succeeded', { tagCount: tags.length, isGroup, capacity });
    return { roomId };
  }

  // Places one seeker with whichever mentor is currently registered at
  // mentorSocketId - claiming them outright for a classic 1:1 match,
  // opening a fresh group room for a group-capable mentor's first seeker,
  // or joining an already-open group room for every seeker after that.
  // Returns { roomId } on success, or null if the mentor could not be used
  // (already fully booked, or gone) so the caller can fall through to the
  // next candidate / put the seeker in the queue.
  //
  // Concurrency: the classic 1:1 path is race-free via claimMentor's atomic
  // get-and-remove. The group path is a read-modify-write (read the mentor
  // entry, open or update a room, write the entry back), so it runs inside a
  // per-mentor lock and re-reads the entry once it holds it. Without that,
  // two seekers arriving at once could both see "no roomId yet" and each open
  // a room, or both take the last seat.
  async function matchSeekerToMentor({ seekerSocketId, seekerProfile, mentorSocketId }) {
    const peeked = await store.getMentor(mentorSocketId);
    if (!peeked) return null;
    const capacity = sanitizeCapacity(peeked.capacity);
    const seeker = { socketId: seekerSocketId, ...seekerProfile };

    if (capacity <= 1) {
      const claimed = await store.claimMentor(mentorSocketId);
      if (!claimed) return null;
      return openRoomWithFirstSeeker({ mentor: claimed, firstSeeker: seeker, capacity });
    }

    // Returns null (caller moves on to the next candidate / the queue) if the
    // lock can't be acquired in time, same as any other "mentor unusable".
    return withLock(store, mentorLockKey(peeked.identityKey), async () => {
      const mentor = await store.getMentor(mentorSocketId);
      if (!mentor) return null;

      if (mentor.roomId) {
        const room = await store.getRoom(mentor.roomId);
        const seekerCount = room ? room.participants.length - 1 : Infinity;
        if (!room || seekerCount >= capacity) {
          // The room is gone or already full - drop this mentor from the
          // pool so nobody else tries it either.
          await store.deleteMentor(mentorSocketId);
          return null;
        }
        addSeekerToRoom(room, seeker);
        const newSeekerCount = seekerCount + 1;
        const nowFull = newSeekerCount >= capacity;
        // Remember that *we* took the mentor out of the pool for being full,
        // so a seat freed later can put them back (see reopenGroupSeat).
        if (nowFull) room.poolClosedByFull = true;
        await store.setRoom(mentor.roomId, room);
        io.in(seekerSocketId).socketsJoin(mentor.roomId);
        if (nowFull) await store.deleteMentor(mentorSocketId);
        else await store.setMentor(mentorSocketId, { ...mentor, seekerCount: newSeekerCount });
        const existingPeerAliases = room.participants.filter((id) => id !== seekerSocketId).map((id) => room.aliases[id]);
        const mentorCard = await mentorCardFor({ identityKey: mentor.identityKey, tags: mentor.tags, year: room.mentorYear ?? mentor.year, seatsFilled: newSeekerCount, capacity });
        io.to(seekerSocketId).emit('match:found', { roomId: mentor.roomId, peer: mentor.alias, peers: existingPeerAliases, tags: room.tags, isGroup: true, capacity, seekerCount: newSeekerCount, startedAt: room.createdAt, mentorCard });
        io.to(mentor.roomId).emit('peer:joined', { alias: seeker.alias, seekerCount: newSeekerCount, capacity });
        await count('matches_succeeded');
        logger.info('match.succeeded', { tagCount: (room.tags || []).length, isGroup: true, capacity, seekerCount: newSeekerCount });
        return { roomId: mentor.roomId };
      }

      // First seeker for this group-capable mentor - open a fresh room and
      // remember it on the mentor entry so the next seeker can find it.
      const result = await openRoomWithFirstSeeker({ mentor, firstSeeker: seeker, capacity });
      await store.setMentor(mentorSocketId, { ...mentor, roomId: result.roomId, seekerCount: 1 });
      return result;
    }, { onTimeout: () => logger.warn('match.mentor_lock_timeout', {}) });
  }

  // Called right after a mentor registers as available. Looks for the
  // best-waiting seeker(s) whose tags overlap this mentor's, so someone who
  // queued while nobody was free gets matched the moment a mentor opens up,
  // instead of needing to ask again. Phase 5: for a group-capable mentor
  // this loops, filling as many open seats as there are matching waiting
  // seekers, rather than stopping after the first. Returns true if at least
  // one match was made.
  async function tryMatchWaitingSeekers(mentor) {
    let matchedAny = false;
    for (;;) {
      const waiting = (await store.listWaitingSeekers())
        // Phase 5: never match across institutions.
        .filter((entry) => entry.institutionId === mentor.institutionId)
        .map((entry) => ({ ...entry, score: profileMatchScore(entry, mentor) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
      if (!waiting.length) break;

      let matchedThisPass = false;
      for (const candidate of waiting) {
        const claimedSeeker = await store.claimWaitingSeeker(candidate.socketId);
        if (!claimedSeeker) continue; // already matched elsewhere between list and claim
        const result = await matchSeekerToMentor({
          seekerSocketId: claimedSeeker.socketId,
          seekerProfile: { alias: claimedSeeker.alias, identityKey: claimedSeeker.identityKey, institutionId: claimedSeeker.institutionId, tags: claimedSeeker.tags },
          mentorSocketId: mentor.socketId
        });
        if (!result) {
          // Mentor is already full or gone - put the seeker back in line
          // rather than losing their place, and stop trying this mentor.
          await store.addWaitingSeeker(claimedSeeker.socketId, claimedSeeker);
          await refreshQueuePositions();
          return matchedAny;
        }
        matchedAny = true;
        matchedThisPass = true;
        await refreshQueuePositions();
        break; // re-list the queue fresh before the next seat, since it just changed
      }
      if (!matchedThisPass) break;
    }
    return matchedAny;
  }

  // --- Phase 4: health, readiness, metrics ----------------------------------
  // Liveness: "is the process up and able to answer HTTP requests at all".
  // Deliberately checks nothing external - a load balancer or orchestrator
  // (Kubernetes liveness probe, an uptime monitor) uses this to decide
  // whether to restart the instance, so it should only fail when the
  // process itself is actually broken.
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'MaskChat',
      storage: store.kind,
      uptimeSeconds: Math.round((Date.now() - START_TIME) / 1000),
      instance: INSTANCE_ID
    });
  });

  // Readiness: "is this instance able to actually serve traffic right now".
  // Unlike /api/health, this does fail when a real dependency is down (in
  // Redis mode, a PING round trip) - a load balancer should stop routing to
  // an instance that fails this, and an orchestrator's readiness probe
  // should hold it out of rotation, without killing/restarting it the way a
  // failed liveness probe would.
  app.get('/api/ready', async (_req, res) => {
    try {
      const ok = await store.ping();
      if (!ok) throw new Error('Store ping failed');
    } catch (error) {
      logger.error('ready.store_ping_failed', { error: error.message });
      noteModeratorAlert('ready_failure', { message: 'Readiness check failed: the backing store is unreachable.' });
      void sendAlert('ready_failure', { reason: 'store_unreachable', error: error.message });
      return res.status(503).json({ ok: false, reason: 'store_unreachable' });
    }
    res.json({ ok: true, storage: store.kind });
  });

  // Metrics: connection counts, match success rate, block-filter hit rate,
  // and related moderation counters. Token-gated like /api/admin/reports -
  // these numbers are aggregate and contain no message content or per-user
  // identity, but they're still operational data about a real student
  // population and shouldn't be world-readable.
  app.get('/api/metrics', requireAdmin, async (_req, res) => {
    try {
      res.json(await metricsSnapshot());
    } catch (error) {
      logger.error('metrics.endpoint_failed', { error: error.message });
      res.status(500).json({ error: 'Could not compute metrics.' });
    }
  });

  app.get('/api/admin/observability', requireAdmin, async (_req, res) => {
    try {
      const metrics = await metricsSnapshot();
      res.json({ ok: true, observability: metrics.observability, alerts: evaluateObservabilityAlerts(metrics.observability) });
    } catch (error) {
      logger.error('observability.endpoint_failed', { error: error.message });
      res.status(500).json({ error: 'Could not compute observability data.' });
    }
  });

  app.get('/api/admin/pilot', requireAdmin, async (_req, res) => {
    try {
      const counters = await store.getCounters();
      const activeByInstitution = {};
      for (const institution of INSTITUTIONS) {
        activeByInstitution[institution.id] = Number(counters[`pilot_active:${institution.id}`] || 0);
      }
      res.json({
        ok: true,
        pilot: pilotStatus(PILOT),
        activeUsers: Object.values(activeByInstitution).reduce((sum, value) => sum + Math.max(0, value), 0),
        activeByInstitution,
        institutions: INSTITUTIONS.map(({ id, name, domain, moderationContact }) => ({ id, name, domain, moderationContact, enabled: !PILOT.allowedInstitutions.length || PILOT.allowedInstitutions.includes(id) })),
        readiness: {
          productionAuth: AUTH_MODE === 'trusted-token',
          httpsRequired: REQUIRE_HTTPS,
          postgresRequired: REQUIRE_POSTGRES,
          redisConfigured: Boolean(REDIS_URL),
          backupPlanDocumented: true,
          mentorAcknowledgementRequired: PILOT.requireMentorAcknowledgement
        }
      });
    } catch (error) {
      logger.error('pilot.endpoint_failed', { error: error.message });
      res.status(500).json({ error: 'Could not compute pilot status.' });
    }
  });


  // Phase 25: pilot operations. Incident records use the existing durable
  // audit log so they remain available across application restarts and HA
  // instances without introducing a second operational database.
  app.get('/api/admin/pilot/operations', requireAdmin, async (_req, res) => {
    try {
      const counters = await store.getCounters();
      const [observability, incidents] = await Promise.all([
        Promise.resolve(observabilitySnapshot()),
        typeof store.listAudit === 'function'
          ? store.listAudit({ limit: 100, eventType: 'pilot.incident' })
          : Promise.resolve([])
      ]);
      const alerts = evaluateObservabilityAlerts(observability);
      const kpis = pilotKpis(counters);
      const latestById = new Map();
      for (const event of incidents) {
        const id = event.targetRef || event.metadata?.id;
        if (id && !latestById.has(id)) latestById.set(id, event);
      }
      const latestIncidents = [...latestById.values()];
      res.json({
        ok: true,
        pilot: pilotStatus(PILOT),
        checklist: PILOT_CHECKLIST,
        kpis,
        incidents: latestIncidents,
        alerts,
        exitAssessment: pilotExitAssessment({ kpis, alerts, incidents: latestIncidents.map((x) => x.metadata || {}) })
      });
    } catch (error) {
      logger.error('pilot.operations_failed', { error: error.message });
      res.status(500).json({ error: 'Could not compute pilot operations.' });
    }
  });

  app.post('/api/admin/pilot/incidents', requireAdmin, async (req, res) => {
    try {
      const incident = normalizeIncident(req.body || {});
      if (!incidentTransition('open', incident.state)) return res.status(400).json({ error: 'Invalid incident state.' });
      const id = crypto.randomUUID();
      await auditEvent('pilot.incident', {
        actorType: 'admin',
        targetRef: id,
        institutionId: incident.institutionId,
        metadata: { id, ...incident, createdAt: new Date().toISOString() }
      });
      if (incident.severity === 'critical' || incident.severity === 'high') {
        noteModeratorAlert('pilot_incident', { reportId: id, institutionId: incident.institutionId, message: `${incident.severity} pilot incident requires attention.` });
        void sendAlert('pilot_incident', { incidentId: id, severity: incident.severity, summary: incident.summary, institutionId: incident.institutionId });
      }
      res.status(201).json({ ok: true, incident: { id, ...incident } });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Invalid pilot incident.' });
    }
  });

  app.post('/api/admin/pilot/incidents/:id/transition', requireAdmin, async (req, res) => {
    try {
      if (typeof store.listAudit !== 'function') return res.status(503).json({ error: 'Durable audit storage is not enabled.' });
      const events = await store.listAudit({ limit: 100, eventType: 'pilot.incident' });
      const current = events.find((x) => x.targetRef === req.params.id || x.metadata?.id === req.params.id);
      if (!current) return res.status(404).json({ error: 'Pilot incident not found.' });
      const next = String(req.body?.state || '').toLowerCase();
      const currentState = current.metadata?.state || 'open';
      if (!incidentTransition(currentState, next)) return res.status(400).json({ error: `Cannot transition incident from ${currentState} to ${next}.` });
      await auditEvent('pilot.incident', {
        actorType: 'admin',
        targetRef: req.params.id,
        institutionId: current.institutionId || current.metadata?.institutionId || null,
        metadata: { ...current.metadata, state: next, action: String(req.body?.action || '').trim().slice(0, 500) || null, updatedAt: new Date().toISOString() }
      });
      res.json({ ok: true, id: req.params.id, state: next });
    } catch (error) {
      logger.error('pilot.incident_transition_failed', { error: error.message });
      res.status(500).json({ error: 'Could not transition pilot incident.' });
    }
  });

  // Phase 13: privacy-safe resource library. Chat attachments and arbitrary links remain blocked.
  app.get('/api/resources', (req, res) => {
    const institution = resolveInstitutionById(String(req.query.institutionId || ''), INSTITUTIONS);
    const tags = String(req.query.tags || '').split(',').map(x => x.trim()).filter(Boolean);
    res.json({ resources: resourcesFor(RESOURCES, institution?.id || '', tags) });
  });

  app.get('/api/admin/alerts', requireAdmin, (_req, res) => {
    res.json({ alerts: moderatorAlerts });
  });
  app.post('/api/admin/alerts/:id/read', requireAdmin, (req, res) => {
    const alert = moderatorAlerts.find(x => x.id === req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found.' });
    alert.read = true;
    res.json({ ok: true, alert });
  });

  // Phase 12: admin dashboard aggregation. All values are derived from the
  // existing store/metrics state; no client-side fake numbers are used.
  app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
    try {
      const [mentors, rooms, waiting, reports, offenders, bans, counters] = await Promise.all([
        store.listMentors(), store.listRooms(), store.listWaitingSeekers(), store.listReports(),
        store.listOffenders(), store.listBans(), store.getCounters()
      ]);
      const topicCounts = new Map();
      const institutionMap = new Map();
      const addTopic = (topic) => { if (topic) topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1); };
      const institution = (id) => {
        const key = id || 'unknown';
        if (!institutionMap.has(key)) institutionMap.set(key, { institutionId: key, name: resolveInstitutionById(key, INSTITUTIONS)?.name || 'Unknown', activeSessions: 0, mentorsAvailable: 0, queueLength: 0, reports: 0 });
        return institutionMap.get(key);
      };
      rooms.forEach((room) => { const item = institution(room.institutionId); item.activeSessions += 1; (room.tags || []).forEach(addTopic); });
      mentors.forEach((mentor) => { const item = institution(mentor.institutionId); item.mentorsAvailable += 1; (mentor.tags || []).forEach(addTopic); });
      waiting.forEach((entry) => { const item = institution(entry.institutionId); item.queueLength += 1; (entry.tags || []).forEach(addTopic); });
      reports.forEach((report) => { institution(report.institutionId).reports += 1; });
      const queueByPosition = waiting.reduce((acc, entry) => { const id = entry.institutionId || 'unknown'; acc[id] = (acc[id] || 0) + 1; return acc; }, {});
      const activeMentorKeys = new Set(rooms.map((room) => room.mentorIdentityKey).filter(Boolean));
      const mentorActivity = await Promise.all(mentors.map(async (mentor) => ({
        institutionId: mentor.institutionId || 'unknown', tags: mentor.tags || [], year: mentor.year || null,
        expertise: mentor.expertise || 'intermediate',
        active: activeMentorKeys.has(mentor.identityKey), sessionsHosted: mentor.identityKey ? await store.getHosted(mentor.identityKey) : 0,
        helpful: mentor.identityKey ? (await store.getFeedbackStats(mentor.identityKey)).up : 0
      })));
      const reportStatuses = reports.reduce((acc, report) => { acc[report.status] = (acc[report.status] || 0) + 1; return acc; }, { open: 0, in_review: 0, resolved: 0 });
      res.json({
        generatedAt: Date.now(),
        liveSessions: { count: rooms.length, participants: rooms.reduce((sum, room) => sum + (room.participants?.length || 0), 0), groups: rooms.filter((room) => room.isGroup).length },
        popularTopics: [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([topic, count]) => ({ topic, count })),
        mentorActivity: mentorActivity.sort((a, b) => (b.sessionsHosted + b.helpful) - (a.sessionsHosted + a.helpful)),
        queue: { total: waiting.length, byInstitution: Object.entries(queueByPosition).map(([institutionId, length]) => ({ institutionId, name: resolveInstitutionById(institutionId, INSTITUTIONS)?.name || 'Unknown', length })) },
        safety: { reports: reports.length, statuses: reportStatuses, repeatOffenders: offenders.length, activeBans: bans.length, violations: counters.violations_recorded || 0, cooldowns: counters.cooldowns_applied || 0, blockedMessages: counters.messages_blocked || 0 },
        institutions: [...institutionMap.values()].sort((a, b) => b.activeSessions + b.queueLength - (a.activeSessions + a.queueLength)),
        metrics: await metricsSnapshot()
      });
    } catch (error) {
      logger.error('admin.dashboard_failed', { error: error.message });
      res.status(500).json({ error: 'Could not compute admin dashboard.' });
    }
  });

  // Phase 5: lets the client show which colleges are supported (for the
  // login hint) without hardcoding a domain. Safe to leave unauthenticated -
  // it's just names and email domains, the same thing a user needs to know
  // before they can sign in at all.
app.get('/api/institutions', (_req, res) => {
    res.json({ institutions: publicInstitutionList(INSTITUTIONS), pilot: pilotStatus(PILOT) });
  });

  app.get('/api/pilot/status', (_req, res) => {
    res.json({ pilot: pilotStatus(PILOT) });
  });

  app.post('/api/auth/preview', (req, res) => {
    if (AUTH_MODE !== 'development') return res.status(404).json({ error: 'Development authentication preview is disabled.' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const institution = resolveInstitutionByEmail(email, INSTITUTIONS, { allowDemoFallback: ALLOW_DEMO_INSTITUTIONS });
    if (!institution) return res.status(400).json({ error: 'Use an email address from a supported institution.' });
    // Development only: issue the same short-lived HttpOnly session cookie that
    // SSO issues, so browser refresh/reconnect can restore the session.
    setCookie(res, 'maskchat_verification', issueInstitutionVerificationToken(email, 300), { maxAge: 300, path: '/', httpOnly: true, secure: REQUIRE_HTTPS, sameSite: COOKIE_SAMESITE });
    return res.json({ alias: dailyAlias(email, ALIAS_SECRET), institution });
  });

  // Phase 26: real institutional OIDC login. The authorization state is
  // signed and also bound to a short-lived browser cookie. The resulting
  // MaskChat verification token is kept in an HttpOnly cookie so refreshes
  // can re-verify the session without exposing the token to JavaScript or URLs.
  app.get('/api/auth/oidc/start', async (req, res) => {
    if (!OIDC.enabled) return res.status(404).json({ error: 'Institution SSO is not configured.' });
    try {
      const state = createOidcState(OIDC);
      setCookie(res, 'maskchat_oidc_state', state.nonce, { maxAge: OIDC.maxAgeSeconds, path: '/api/auth/oidc', httpOnly: true, secure: REQUIRE_HTTPS, sameSite: COOKIE_SAMESITE });
      const discovery = await (await fetch(`${OIDC.issuer}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(5000) })).json();
      if (discovery.issuer !== OIDC.issuer) throw new Error('OIDC issuer mismatch.');
      return res.redirect(buildAuthorizationUrl(OIDC, discovery, state));
    } catch (error) {
      logger.error('oidc.start_failed', { error: error.message });
      clearCookie(res, 'maskchat_oidc_state', '/api/auth/oidc');
      return res.status(503).json({ error: 'Institution sign-in is temporarily unavailable.' });
    }
  });

  app.get('/api/auth/oidc/callback', async (req, res) => {
    if (!OIDC.enabled) return res.status(404).send('Institution SSO is not configured.');
    try {
      const cookies = parseCookies(req.get('cookie') || '');
      const expectedNonce = cookies.maskchat_oidc_state || '';
      if (!expectedNonce) return res.status(401).send('Your institution sign-in session expired. Please try again.');
      const result = await authenticateOidcCallback(OIDC, req.query, expectedNonce);
      clearCookie(res, 'maskchat_oidc_state', '/api/auth/oidc');
      const institution = resolveInstitutionByEmail(result.identity.email, INSTITUTIONS);
      if (!institution) return res.status(403).send('Your institution is not supported by this MaskChat deployment.');
      if (OIDC.allowedDomains.length && !OIDC.allowedDomains.includes(institution.domain)) return res.status(403).send('Your institution is not enabled for SSO.');
      const token = issueInstitutionVerificationToken(result.identity.email, result.expiresIn);
      setCookie(res, 'maskchat_verification', token, { maxAge: result.expiresIn, path: '/', httpOnly: true, secure: REQUIRE_HTTPS, sameSite: COOKIE_SAMESITE });
      return res.redirect(OIDC.postLoginRedirect);
    } catch (error) {
      logger.warn('oidc.callback_rejected', { error: error.message });
      clearCookie(res, 'maskchat_oidc_state', '/api/auth/oidc');
      return res.status(401).send('Institution sign-in could not be verified. Please try again.');
    }
  });

  app.get('/api/auth/session', (req, res) => {
    try {
      const cookies = parseCookies(req.get('cookie') || '');
      const token = cookies.maskchat_verification || '';
      const verified = verifyInstitutionVerificationToken(token, IDENTITY_VERIFICATION_SECRET);
      if (!verified?.email) return res.status(401).json({ authenticated: false });
      const institution = resolveInstitutionByEmail(verified.email, INSTITUTIONS, { allowDemoFallback: ALLOW_DEMO_INSTITUTIONS });
      if (!institution) return res.status(403).json({ authenticated: false, error: 'Your institution is not supported.' });
      return res.json({ authenticated: true, alias: dailyAlias(verified.email, ALIAS_SECRET), institution });
    } catch {
      return res.status(401).json({ authenticated: false });
    }
  });

  app.get('/api/auth/mode', (_req, res) => {
    res.json({ mode: OIDC.enabled ? 'oidc' : AUTH_MODE, oidc: OIDC.enabled, institutions: publicInstitutionList(INSTITUTIONS).map(({ id, name, domain }) => ({ id, name, domain })) });
  });

  // --- Phase 1: moderator/admin path ---------------------------------------
  // Minimal, token-gated review surface for reports filed from active chats.
  // Set ADMIN_TOKEN in the environment to enable it; it's disabled by default.
  // With REDIS_URL set, this reflects reports filed on every instance, not
  // just this one - see store.js's Redis-backed report methods.
  // The /admin pages are static files that ship with the client build
  // (client/public/admin -> client/dist/admin), so they are served by whichever
  // process serves the client: the CDN on Vercel, or express.static(clientDist) below.

  app.get('/api/admin/moderation/policy', requireAdmin, async (_req, res) => {
    res.json({ policy: moderationPolicy(), statuses: ['open', 'in_review', 'resolved'], banTypes: ['temporary', 'permanent'] });
  });

  app.get('/api/admin/reports', requireAdmin, async (_req, res) => {
    const all = (await store.listReports())
      .sort((a, b) => b.createdAt - a.createdAt)
      // Phase 5: attach a human-readable institution name for the admin UI;
      // older reports filed before this change have no institutionId and
      // just show as unknown rather than erroring.
      .map((report) => ({
        ...redactAdminIdentity(report),
        institutionName: resolveInstitutionById(report.institutionId, INSTITUTIONS)?.name || null
      }));
    res.json({ reports: all, adminEnabled: true, institutions: publicInstitutionList(INSTITUTIONS) });
  });

  app.post('/api/admin/reports/:id/status', requireAdmin, async (req, res) => {
    const report = await store.getReport(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found (it may have already been cleared).' });
    const status = String(req.body?.status || '').trim();
    if (!['open', 'in_review', 'resolved'].includes(status)) return res.status(400).json({ error: 'Status must be open, in_review, or resolved.' });
    report.status = status;
    report.assignedTo = String(req.body?.assignedTo || report.assignedTo || '').trim().slice(0, 120) || null;
    if (status === 'resolved') report.resolvedAt = Date.now(); else delete report.resolvedAt;
    await store.setReport(req.params.id, report);
    await auditEvent('moderation.report_status', { actorType: 'admin', targetRef: req.params.id, institutionId: report.institutionId || null, metadata: { status, assignedTo: report.assignedTo || null } });
    res.json({ ok: true, report });
  });

  // Backwards-compatible shortcut for existing admin UI clients.
  app.post('/api/admin/reports/:id/resolve', requireAdmin, async (req, res) => {
    const report = await store.getReport(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found (it may have already been cleared).' });
    report.status = 'resolved'; report.resolvedAt = Date.now();
    await store.setReport(req.params.id, report);
    await auditEvent('moderation.report_status', { actorType: 'admin', targetRef: req.params.id, institutionId: report.institutionId || null, metadata: { status: 'resolved' } });
    res.json({ ok: true, report });
  });

  app.post('/api/admin/offenders/:ref/ban', requireAdmin, async (req, res) => {
    const identity = await resolveIdentityFromRef(store, req.params.ref);
    if (!identity) return res.status(404).json({ error: 'Offender not found.' });
    const type = req.body?.type === 'permanent' ? 'permanent' : 'temporary';
    const until = type === 'permanent' ? null : Date.now() + Math.max(60_000, Math.min(Number(req.body?.durationMs) || 24 * 60 * 60_000, 30 * 24 * 60 * 60_000));
    const ban = { type, until, reason: String(req.body?.reason || 'Moderator action').slice(0, 300), createdAt: Date.now(), assignedTo: String(req.body?.assignedTo || '').slice(0, 120) || null };
    await store.setBan(identity, ban);
    await auditEvent('moderation.ban', { actorType: 'admin', targetRef: req.params.ref, metadata: { type, until, reason: ban.reason } });
    res.json({ ok: true, offenderRef: req.params.ref, ban });
  });

  app.delete('/api/admin/offenders/:ref/ban', requireAdmin, async (req, res) => {
    const identity = await resolveIdentityFromRef(store, req.params.ref);
    if (!identity) return res.status(404).json({ error: 'Offender not found.' });
    const removed = await store.deleteBan(identity);
    if (removed) await auditEvent('moderation.unban', { actorType: 'admin', targetRef: req.params.ref });
    res.json({ ok: removed });
  });

  app.post('/api/admin/identity/:identityKey/ban', requireAdmin, async (req, res) => {
    const identity = String(req.params.identityKey || '').trim();
    if (!/^[a-f0-9]{64}$/.test(identity)) return res.status(400).json({ error: 'Invalid identity key.' });
    const type = req.body?.type === 'permanent' ? 'permanent' : 'temporary';
    const until = type === 'permanent' ? null : Date.now() + Math.max(60_000, Math.min(Number(req.body?.durationMs) || 24 * 60 * 60_000, 30 * 24 * 60 * 60_000));
    const ban = { type, until, reason: String(req.body?.reason || 'Moderator action').slice(0, 300), createdAt: Date.now(), assignedTo: String(req.body?.assignedTo || '').slice(0, 120) || null };
    await store.setBan(identity, ban);
    res.json({ ok: true, ban });
  });

  app.delete('/api/admin/identity/:identityKey/ban', requireAdmin, async (req, res) => {
    const identity = String(req.params.identityKey || '').trim();
    if (!/^[a-f0-9]{64}$/.test(identity)) return res.status(400).json({ error: 'Invalid identity key.' });
    res.json({ ok: await store.deleteBan(identity) });
  });

  app.get('/api/admin/offenders', requireAdmin, async (_req, res) => {
    const [offenders, bans] = await Promise.all([store.listOffenders(), store.listBans()]);
    res.json({ offenders: offenders.sort((a, b) => b.reportCount - a.reportCount).map(({ identityKey, ...entry }) => ({ ...entry, offenderRef: createOffenderRef(identityKey, OFFENDER_REF_SECRET) })), bans: bans.map(({ identityKey, ...ban }) => ({ ...ban, offenderRef: createOffenderRef(identityKey, OFFENDER_REF_SECRET) })) });
  });

  app.delete('/api/admin/reports/:id', requireAdmin, async (req, res) => {
    const existed = await store.deleteReport(req.params.id);
    if (existed) await auditEvent('moderation.report_deleted', { actorType: 'admin', targetRef: req.params.id });
    res.json({ ok: existed });
  });

  // Phase 17: auditable moderator activity without exposing raw identity keys.
  app.get('/api/admin/audit', requireAdmin, async (req, res) => {
    if (typeof store.listAudit !== 'function') return res.status(503).json({ error: 'Audit storage is not enabled.' });
    const events = await store.listAudit({ limit: req.query.limit, before: req.query.before, eventType: req.query.eventType, institutionId: req.query.institutionId });
    res.json({ events });
  });

  app.post('/api/admin/privacy/retention', requireAdmin, async (_req, res) => {
    if (typeof store.retention !== 'function') return res.status(503).json({ error: 'Durable privacy storage is not enabled.' });
    const result = await store.retention({ reportDays: RETENTION_REPORT_DAYS, auditDays: RETENTION_AUDIT_DAYS, feedbackDays: RETENTION_FEEDBACK_DAYS });
    await auditEvent('privacy.retention_run', { actorType: 'admin', metadata: { ...result, reportDays: RETENTION_REPORT_DAYS, auditDays: RETENTION_AUDIT_DAYS, feedbackDays: RETENTION_FEEDBACK_DAYS } });
    res.json({ ok: true, result });
  });

  app.post('/api/admin/privacy/erase/:ref', requireAdmin, async (req, res) => {
    if (typeof store.deleteIdentityData !== 'function') return res.status(503).json({ error: 'Durable privacy storage is not enabled.' });
    const identity = await resolveIdentityFromRef(store, req.params.ref);
    if (!identity) return res.status(404).json({ error: 'Identity not found.' });
    const result = await store.deleteIdentityData(identity);
    await auditEvent('privacy.identity_erased', { actorType: 'admin', metadata: { ...result, reason: 'admin_requested_erasure' } });
    res.json({ ok: true, result });
  });

  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  io.on('connection', (socket) => {
    // Convenience accessor - profile.identityKey is only set once
    // identity:verify has run, so every handler below re-checks it.
    const rateKeyFor = () => {
      const profile = socket.data.profile;
      if (!profile) return socket.id;
      const institution = resolveInstitutionById(profile.institutionId, INSTITUTIONS);
      return `${institution?.rateLimitPool || profile.institutionId || 'default'}:${profile.identityKey}`;
    };
    const rateLimitFor = (profile) => resolveInstitutionById(profile?.institutionId, INSTITUTIONS)?.rateLimit || MATCH_ACTION_LIMIT;
    const messageRateLimitFor = (profile) => Math.max(10, (resolveInstitutionById(profile?.institutionId, INSTITUTIONS)?.rateLimit || MATCH_ACTION_LIMIT) * 5);
    async function abuseAllowed(profile, action, limit, windowMs) {
      if (!profile?.identityKey) return false;
      const pool = resolveInstitutionById(profile.institutionId, INSTITUTIONS)?.rateLimitPool || profile.institutionId || 'default';
      return store.consumeRate(`abuse:${pool}:${profile.identityKey}:${action}`, limit, windowMs);
    }

    // Phase 4: connection-count observability. currentConnections is a
    // simple in-process gauge (see metricsSnapshot above for why it isn't
    // shared through the store), connections_total is a cumulative counter
    // for "how many sockets has this instance ever seen".
    currentConnections += 1;
    count('connections_total');
    logger.info('connection.open', { currentConnections });

    socket.on('mentor:training:accept', (_payload, acknowledge) => {
      socket.data.mentorTrainingAccepted = true;
      acknowledge?.({ ok: true });
    });

    socket.on('mentor:schedule:set', async (payload, acknowledge) => {
      const profile = socket.data.profile;
      if (!profile) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      const schedule = sanitizeSchedule(payload?.schedule);
      await store.setSchedule(profile.identityKey, schedule);
      const mentor = await store.getMentor(socket.id);
      if (mentor) await store.setMentor(socket.id, { ...mentor, schedule });
      acknowledge?.({ ok: true, schedule });
    });

    socket.on('mentor:available', async (payload, acknowledge) => {
      const profile = socket.data.profile;
      if (!profile) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      if (await store.getBan(profile.identityKey)) return acknowledge?.({ ok: false, error: 'Your MaskChat access is restricted.' });
      if (!(await abuseAllowed(profile, 'match', ABUSE_MATCH_LIMIT, ABUSE_MATCH_WINDOW_MS))) {
        return acknowledge?.({ ok: false, error: 'Too many availability changes. Please wait a moment.' });
      }
      const cooldownUntil = await store.getCooldown(profile.identityKey);
      if (cooldownUntil) return acknowledge?.({ ok: false, error: cooldownError(cooldownUntil) });
      if (!(await store.consumeRate(rateKeyFor(), rateLimitFor(profile), MATCH_ACTION_WINDOW_MS))) {
        return acknowledge?.({ ok: false, error: 'Too many requests. Please wait a moment and try again.' });
      }
      const tags = sanitizeTags(payload?.tags);
      if (!tags.length) return acknowledge?.({ ok: false, error: 'Choose at least one subject tag.' });
      // Phase 5: a mentor opts into a group session by requesting a capacity
      // above 1 (defaults to the original 1:1 behavior). seekerCount/roomId
      // are populated once the first seeker joins - see matchSeekerToMentor.
      if (!socket.data.mentorTrainingAccepted) return acknowledge?.({ ok: false, error: 'Complete the mentor guidelines before becoming available.' });
      // A mentor who is already hosting a live group room with a free seat
      // keeps that room binding. Re-announcing must not overwrite the pool
      // entry with roomId: null / seekerCount: 0, or the next seeker would
      // open a second room and orphan the first one.
      const hostedEntry = await store.getMentor(socket.id);
      if (hostedEntry?.roomId) {
        const hostedRoom = await store.getRoom(hostedEntry.roomId);
        if (hostedRoom && groupRoomHasOpenSeat(hostedRoom)) {
          const hostedStats = await store.getFeedbackStats(profile.identityKey);
          return acknowledge?.({ ok: true, stats: hostedStats, sessionsHosted: await store.getHosted(profile.identityKey), capacity: hostedEntry.capacity, expertise: hostedEntry.expertise, topicType: hostedEntry.topicType, schedule: hostedEntry.schedule || [], alreadyHosting: true });
        }
      }
      const capacity = sanitizeCapacity(payload?.capacity);
      const expertise = sanitizeExpertise(payload?.expertise);
      const topicType = sanitizeTopicType(payload?.topicType);
      const schedule = sanitizeSchedule(payload?.schedule);
      const scheduleId = crypto.randomUUID();
      await store.setSchedule(profile.identityKey, schedule);
      const mentorEntry = { socketId: socket.id, alias: profile.alias, identityKey: profile.identityKey, institutionId: profile.institutionId, tags, capacity, year: sanitizeYear(payload?.year), expertise, topicType, scheduleId, schedule, seekerCount: 0, roomId: null, joinedAt: Date.now() };
      await store.setMentor(socket.id, mentorEntry);
      // Phase 3: mentor quality signal - let mentors see their own
      // aggregate thumbs up/down so there's a feedback loop, and check
      // whether anyone was already waiting for a mentor like them.
      const stats = await store.getFeedbackStats(profile.identityKey);
      const matched = await tryMatchWaitingSeekers(mentorEntry);
      if (!matched) socket.emit('mentor:queue', { status: 'available', tags, capacity });
      acknowledge?.({ ok: true, stats, sessionsHosted: await store.getHosted(profile.identityKey), capacity, expertise, topicType, schedule });
    });

    socket.on('mentor:unavailable', async () => {
      await store.deleteMentor(socket.id);
      socket.emit('mentor:queue', { status: 'offline' });
    });

    socket.on('match:request', async (payload, acknowledge) => {
      const seeker = socket.data.profile;
      if (!seeker) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      if (!(await abuseAllowed(seeker, 'match', ABUSE_MATCH_LIMIT, ABUSE_MATCH_WINDOW_MS))) {
        return acknowledge?.({ ok: false, error: 'Too many matching attempts. Please wait a moment.' });
      }
      const cooldownUntil = await store.getCooldown(seeker.identityKey);
      if (cooldownUntil) return acknowledge?.({ ok: false, error: cooldownError(cooldownUntil) });
      if (!(await store.consumeRate(rateKeyFor(), rateLimitFor(seeker), MATCH_ACTION_WINDOW_MS))) {
        return acknowledge?.({ ok: false, error: 'Too many requests. Please wait a moment and try again.' });
      }
      const requestedTags = sanitizeTags(payload?.tags);
      if (!requestedTags.length) return acknowledge?.({ ok: false, error: 'Choose at least one subject tag.' });
      const requestProfile = { tags: requestedTags, topicType: sanitizeTopicType(payload?.topicType), year: sanitizeYear(payload?.year), expertise: sanitizeExpertise(payload?.expertise) };
      await count('matches_attempted');

      const blocked = await store.listBlocked(seeker.identityKey);
      const scored = (await store.listMentors())
        .filter((mentor) => mentor.socketId !== socket.id)
        .filter((mentor) => mentor.institutionId === seeker.institutionId)
        .filter((mentor) => !blocked.includes(mentor.identityKey))
        .map((mentor) => ({ ...mentor, score: profileMatchScore(requestProfile, mentor) }))
        .filter((mentor) => mentor.score >= 10);

      // Phase 3: mentor quality signal - among equally tag-relevant
      // mentors, prefer the one with the better thumbs up/down record
      // before falling back to who's been waiting longest.
      const candidates = (await Promise.all(scored.map(async (mentor) => {
        const stats = mentor.identityKey ? await store.getFeedbackStats(mentor.identityKey) : { up: 0, down: 0 };
        return { ...mentor, quality: stats.up - stats.down };
      }))).sort((a, b) => b.score - a.score || b.quality - a.quality || a.joinedAt - b.joinedAt);

      // Claim/join atomically-ish (see matchSeekerToMentor) rather than
      // list-then-mutate: with multiple instances sharing the Redis store,
      // two seekers could otherwise both pick the same mentor between the
      // list and the write. If a candidate is already claimed/full/gone by
      // the time we get there, fall through to the next-best one instead of
      // failing outright.
      let matchResult = null;
      for (const candidate of candidates) {
        matchResult = await matchSeekerToMentor({
          seekerSocketId: socket.id,
          seekerProfile: { alias: seeker.alias, identityKey: seeker.identityKey, institutionId: seeker.institutionId, tags: requestedTags, topicType: requestProfile.topicType, year: requestProfile.year, expertise: requestProfile.expertise },
          mentorSocketId: candidate.socketId
        });
        if (matchResult) break;
      }
      if (!matchResult) {
        // Phase 3: queue UX - hold this seeker's place instead of just
        // failing, so they get matched automatically the moment a mentor
        // with an overlapping tag comes online (see tryMatchWaitingSeekers).
        await store.addWaitingSeeker(socket.id, {
          socketId: socket.id,
          alias: seeker.alias,
          identityKey: seeker.identityKey,
          institutionId: seeker.institutionId,
          tags: requestedTags,
          topicType: requestProfile.topicType, year: requestProfile.year, expertise: requestProfile.expertise,
          joinedAt: Date.now()
        });
        // Phase 5: position/total scoped to this seeker's own institution -
        // see refreshQueuePositions for the same scoping applied on updates.
        const waiting = (await store.listWaitingSeekers())
          .filter((entry) => entry.institutionId === seeker.institutionId)
          .sort((a, b) => a.joinedAt - b.joinedAt);
        const position = waiting.findIndex((entry) => entry.socketId === socket.id) + 1;
        await refreshQueuePositions();
        await count('matches_queued');
        return acknowledge?.({ ok: true, waiting: true, position, total: waiting.length });
      }

      acknowledge?.({ ok: true });
    });

    socket.on('schedule:list', async (payload, acknowledge) => {
      const seeker = socket.data.profile;
      if (!seeker) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      const request = { tags: sanitizeTags(payload?.tags), topicType: sanitizeTopicType(payload?.topicType), year: sanitizeYear(payload?.year), expertise: sanitizeExpertise(payload?.expertise) };
      const blocked = await store.listBlocked(seeker.identityKey);
      const candidates = (await store.listMentors())
        .filter((m) => m.institutionId === seeker.institutionId && !blocked.includes(m.identityKey))
        .map((m) => ({ ...m, score: profileMatchScore(request, m) }))
        .filter((m) => m.score >= 10 && (m.schedule || []).length)
        .sort((a,b) => b.score - a.score)
        .slice(0, 10);
      const results = [];
      for (const mentor of candidates) {
        const stats = await store.getFeedbackStats(mentor.identityKey);
        results.push({ mentorRef: mentor.scheduleId, mentorCard: buildMentorCard({ tags: mentor.tags, year: mentor.year, sessionsHosted: await store.getHosted(mentor.identityKey), helpful: stats.up, seatsFilled: mentor.seekerCount || 0, capacity: mentor.capacity, expertise: mentor.expertise, topicType: mentor.topicType }), schedule: mentor.schedule });
      }
      acknowledge?.({ ok: true, mentors: results });
    });

    socket.on('session:book', async (payload, acknowledge) => {
      const seeker = socket.data.profile;
      if (!seeker) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      const mentor = (await store.listMentors()).find((m) => m.scheduleId === String(payload?.mentorRef || '') && m.institutionId === seeker.institutionId);
      if (!mentor) return acknowledge?.({ ok: false, error: 'That mentor is no longer available for scheduled sessions.' });
      if (await store.isBlocked(seeker.identityKey, mentor.identityKey)) return acknowledge?.({ ok: false, error: 'You have chosen not to match with this mentor again.' });
      const requestedStart = String(payload?.start || '').slice(0, 64);
      const requestedEnd = String(payload?.end || '').slice(0, 64);
      const matchingSlot = (mentor.schedule || []).find((slot) => slot.start === requestedStart && slot.end === requestedEnd);
      if (!matchingSlot) return acknowledge?.({ ok: false, error: 'That availability slot is no longer offered.' });
      const nextDate = new Date();
      const delta = (Number(matchingSlot.day) - nextDate.getDay() + 7) % 7 || 7;
      nextDate.setDate(nextDate.getDate() + delta);
      const date = nextDate.toISOString().slice(0, 10);
      const sessionId = crypto.randomUUID();
      const item = { id: sessionId, createdAt: Date.now(), status: 'scheduled', date, start: requestedStart, end: requestedEnd, mentorIdentityKey: mentor.identityKey, mentorSocketId: mentor.socketId, seekerIdentityKey: seeker.identityKey, seekerSocketId: socket.id, institutionId: seeker.institutionId, tags: sanitizeTags(payload?.tags) };
      await store.setScheduledSession(sessionId, item);
      socket.emit('session:scheduled', { id: sessionId, start: item.start, end: item.end, mentorCard: buildMentorCard({ tags: mentor.tags, year: mentor.year, sessionsHosted: await store.getHosted(mentor.identityKey), helpful: (await store.getFeedbackStats(mentor.identityKey)).up, seatsFilled: mentor.seekerCount || 0, capacity: mentor.capacity, expertise: mentor.expertise, topicType: mentor.topicType }) });
      io.to(mentor.socketId).emit('session:booking', { id: sessionId, start: item.start, end: item.end });
      acknowledge?.({ ok: true, session: { id: item.id, createdAt: item.createdAt, status: item.status, start: item.start, end: item.end, institutionId: item.institutionId, tags: item.tags } });
    });

    socket.on('session:scheduled:list', async (_payload, acknowledge) => {
      const profile = socket.data.profile;
      if (!profile) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      const sessions = await store.listScheduledSessions(profile.identityKey);
      const mentors = await store.listMentors();
      const output = sessions.map(({ mentorIdentityKey, seekerIdentityKey, mentorSocketId, seekerSocketId, ...safe }) => {
        const mentor = mentors.find((item) => item.identityKey === mentorIdentityKey);
        return {
          ...safe,
          peerAlias: mentor?.alias || 'Anonymous Mentor',
          topic: safe.tags?.[0] || 'Peer mentoring',
          date: safe.date || 'Upcoming'
        };
      });
      acknowledge?.({ ok: true, sessions: output });
    });

    socket.on('mentor:block', async (payload, acknowledge) => {
      const profile = socket.data.profile;
      if (!profile) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      let targetIdentityKey = String(payload?.targetIdentityKey || '');
      if (!targetIdentityKey && payload?.roomId && payload?.targetAlias) {
        const room = await store.getRoom(payload.roomId);
        const targetSocket = room?.participants.find((id) => room.aliases?.[id] === String(payload.targetAlias).trim() && id !== socket.id);
        targetIdentityKey = targetSocket ? room.identities[targetSocket] : '';
      }
      if (!targetIdentityKey || targetIdentityKey === profile.identityKey) return acknowledge?.({ ok: false, error: 'Invalid mentor.' });
      await store.blockIdentity(profile.identityKey, targetIdentityKey);
      acknowledge?.({ ok: true });
    });

    socket.on('queue:cancel', async (_payload, acknowledge) => {
      const removed = await store.removeWaitingSeeker(socket.id);
      if (removed) await refreshQueuePositions();
      acknowledge?.({ ok: true });
    });

    socket.on('demo:start', async (payload, acknowledge) => {
      const profile = socket.data.profile;
      if (!profile) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      const cooldownUntil = await store.getCooldown(profile.identityKey);
      if (cooldownUntil) return acknowledge?.({ ok: false, error: cooldownError(cooldownUntil) });
      if (!(await store.consumeRate(rateKeyFor(), rateLimitFor(profile), MATCH_ACTION_WINDOW_MS))) {
        return acknowledge?.({ ok: false, error: 'Too many requests. Please wait a moment and try again.' });
      }
      const tags = sanitizeTags(payload?.tags);
      const roomId = crypto.randomUUID();
      const resolvedTags = tags.length ? tags : ['Academic guidance'];
      io.in(socket.id).socketsJoin(roomId);
      await store.setRoom(roomId, {
        participants: [socket.id],
        aliases: { [socket.id]: profile.alias },
        identities: { [socket.id]: profile.identityKey },
        institutionId: profile.institutionId,
        demo: true,
        tags: resolvedTags,
        createdAt: Date.now()
      });
      // Sample card so the guided demo walks through the same lobby a real
      // match does. Static, clearly flagged as demo, not tied to anyone.
      const mentorCard = buildMentorCard({ tags: resolvedTags, year: 3, sessionsHosted: 12, helpful: 18, seatsFilled: 1, capacity: 1, demo: true });
      socket.emit('match:found', { roomId, peer: 'Sage Lynx 42', tags: resolvedTags, demo: true, mentorCard });
      await count('demo_sessions_started');
      setTimeout(async () => {
        if (await store.getRoom(roomId)) {
          socket.emit('message:received', { id: crypto.randomUUID(), sender: 'Sage Lynx 42', text: 'Hi! I am here to help. What would you like to work through?', sentAt: new Date().toISOString(), demo: true });
        }
      }, 700);
      acknowledge?.({ ok: true });
    });

    socket.on('typing', async ({ roomId, active } = {}) => {
      const room = await store.getRoom(roomId);
      if (!room || !room.participants.includes(socket.id)) return;
      socket.to(roomId).emit('peer:typing', { alias: room.aliases?.[socket.id] || 'Anonymous peer', active: !!active });
    });

    socket.on('message:send', async (payload, acknowledge) => {
      const profile = socket.data.profile;
      if (!profile) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      const cooldownUntil = await store.getCooldown(profile.identityKey);
      if (cooldownUntil) return acknowledge?.({ ok: false, error: cooldownError(cooldownUntil) });
      if (!(await store.consumeRate(rateKeyFor(), messageRateLimitFor(profile), MESSAGE_WINDOW_MS))) {
        return acknowledge?.({ ok: false, error: 'You are sending messages too quickly. Please slow down.' });
      }
      const room = await store.getRoom(payload?.roomId);
      if (!room || !room.participants.includes(socket.id)) return acknowledge?.({ ok: false, error: 'This session is no longer active.' });
      const violation = detectViolation(payload?.text, { attachments: payload?.attachments });
      if (violation) {
        socket.emit('message:blocked', { reason: violation });
        await count('messages_blocked');
        const violationCount = await store.recordViolation(profile.identityKey, VIOLATION_WINDOW_MS);
        await count('violations_recorded');
        logger.warn('message.blocked', { identity: shortHash(profile.identityKey), reason: violation, violationCount });
        if (violationCount >= VIOLATION_THRESHOLD) {
          await applyCooldown(socket, profile.identityKey, violationCount);
        }
        return acknowledge?.({ ok: false, error: violation });
      }
      const message = { id: crypto.randomUUID(), sender: profile.alias, text: payload.text.trim(), sentAt: new Date().toISOString() };
      socket.to(payload.roomId).emit('message:received', message);
      await count('messages_sent');
      if (room.demo) {
        setTimeout(async () => {
          if (await store.getRoom(payload.roomId)) {
            socket.emit('message:received', { id: crypto.randomUUID(), sender: 'Sage Lynx 42', text: 'That makes sense. Try stating the concept in your own words first, then we can find the gap together.', sentAt: new Date().toISOString(), demo: true });
          }
        }, 900);
      }
      acknowledge?.({ ok: true, message });
    });

    socket.on('message:report', async (payload, acknowledge) => {
      const profile = socket.data.profile;
      if (!profile) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      if (!(await abuseAllowed(profile, 'report', ABUSE_REPORT_LIMIT, ABUSE_REPORT_WINDOW_MS))) {
        return acknowledge?.({ ok: false, error: 'Too many reports. Please wait before filing another report.' });
      }
      const room = await store.getRoom(payload?.roomId);
      if (!room || !room.participants.includes(socket.id)) return acknowledge?.({ ok: false, error: 'This session is no longer active.' });
      const id = crypto.randomUUID();
      const reportedAlias = String(payload?.message?.sender || 'Unknown').slice(0, 64);
      const reportedSocketId = Object.entries(room.aliases || {}).find(([, alias]) => alias === reportedAlias)?.[0];
      const reportedIdentityKey = reportedSocketId ? room.identities?.[reportedSocketId] || null : null;
      await store.setReport(id, { id, createdAt: Date.now(), status: 'open', assignedTo: null, roomId: payload.roomId, reason: sanitizeReportReason(payload?.reason), details: sanitizeReportDetails(payload?.details), messages: sanitizeReportMessages([payload?.message]), reporterAlias: room.aliases?.[socket.id] || 'Unknown', reportedAlias, reportedIdentityKey, otherAliases: [], institutionId: room.institutionId || null, tags: room.tags || [], messageReport: true });
      if (reportedIdentityKey) await store.recordOffenderReport(reportedIdentityKey);
      await auditEvent('report.filed', { actorType: 'student', actorRef: offenderRefForIdentity(room.identities?.[socket.id]), targetRef: reportedIdentityKey ? offenderRefForIdentity(reportedIdentityKey) : null, institutionId: room.institutionId || null, metadata: { reportId: id, messageReport: true, reason: sanitizeReportReason(payload?.reason) } });
      await count('reports_filed');
      noteReportForAlert(room.institutionId);
      acknowledge?.({ ok: true, reportId: id });
    });

    socket.on('session:end', async ({ roomId, feedback } = {}, acknowledge) => {
      const room = await store.getRoom(roomId);
      // Phase 3: lightweight mentor quality signal. Recorded here (before
      // the room is torn down/left) rather than as a separate event, since
      // the room record - which holds the mentor's identityKey, never the
      // seeker's - is only available up until then. Only a real (non-demo)
      // session's seeker can leave feedback, and a mentor can't rate
      // themselves.
      const mentorSocketId = room ? currentMentorSocketId(room) : undefined;
      if ((feedback === 'up' || feedback === 'down') && room && !room.demo && room.mentorIdentityKey && room.participants.includes(socket.id)) {
        if (socket.id !== mentorSocketId && await abuseAllowed(socket.data.profile, 'feedback', ABUSE_FEEDBACK_LIMIT, ABUSE_FEEDBACK_WINDOW_MS)) {
          await store.recordFeedback(room.mentorIdentityKey, feedback === 'up');
        }
      }
      // Phase 5: in a group room, a seeker ending their own session should
      // only remove them from it, not shut it down for everyone else still
      // talking to the mentor. The mentor ending it (or anyone in a classic
      // 1:1 room) still closes it for both/all sides, same as before.
      if (room?.isGroup && socket.id !== mentorSocketId) {
        await leaveRoom(roomId, socket.id, 'left');
      } else {
        await closeRoom(roomId, 'ended', feedback);
      }
      // Phase 4: the existing client never passes a callback here (it treats
      // session:end as fire-and-forget), so this was previously silent -
      // socket.io only invokes a callback the caller actually supplied. Added
      // for consistency with every other mutating handler in this file, and
      // so tooling (e.g. loadtest.js) can confirm the close actually happened
      // rather than racing a fixed delay.
      acknowledge?.({ ok: true });
    });

    socket.on('session:report', async (payload, acknowledge) => {
      const profile = socket.data.profile;
      if (!profile) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      if (!(await abuseAllowed(profile, 'report', ABUSE_REPORT_LIMIT, ABUSE_REPORT_WINDOW_MS))) {
        return acknowledge?.({ ok: false, error: 'Too many reports. Please wait before filing another report.' });
      }
      const room = await store.getRoom(payload?.roomId);
      if (!room || !room.participants.includes(socket.id)) {
        return acknowledge?.({ ok: false, error: 'This session is no longer active.' });
      }

      const reporterAlias = room.aliases?.[socket.id] || socket.data.profile?.alias || 'Unknown';
      // Phase 5: a group room can have more than one other participant, so
      // the reporter may optionally name which peer's alias they mean
      // (surfaced by the client as a dropdown built from the same roster it
      // already has). Anything that isn't actually a current peer's alias
      // is ignored rather than trusted verbatim, same spirit as every other
      // sanitize* helper in core.js.
      const otherAliases = room.participants.filter((id) => id !== socket.id).map((id) => room.aliases?.[id]).filter(Boolean);
      const requestedTarget = String(payload?.targetAlias || '').trim();
      const targetedAlias = otherAliases.includes(requestedTarget) ? requestedTarget : null;
      const reportedAlias = room.demo
        ? 'Guided demo (no real peer)'
        : targetedAlias || (otherAliases.length === 1 ? otherAliases[0] : null) || 'Unspecified (group session)';
      const reportedSocketId = Object.entries(room.aliases || {}).find(([, alias]) => alias === reportedAlias)?.[0];
      const reportedIdentityKey = reportedSocketId ? room.identities?.[reportedSocketId] || null : null;

      const id = crypto.randomUUID();
      await store.setReport(id, {
        id,
        createdAt: Date.now(),
        status: 'open',
        roomId: payload.roomId,
        reason: sanitizeReportReason(payload?.reason),
        details: sanitizeReportDetails(payload?.details),
        // Only included if the reporter explicitly opted in on their end -
        // never captured automatically, to keep the ephemeral-by-default promise.
        messages: payload?.includeMessages ? sanitizeReportMessages(payload?.messages) : [],
        reporterAlias,
        reportedAlias,
        reportedIdentityKey,
        assignedTo: null,
        offenderReportCount: reportedIdentityKey ? await store.recordOffenderReport(reportedIdentityKey) : 0,
        // Phase 5: full roster of everyone else in the room at report time,
        // so a moderator reviewing a group session isn't limited to the one
        // (possibly unspecified) targeted alias.
        otherAliases,
        institutionId: room.institutionId || null,
        tags: room.tags || []
      });

      await closeRoom(payload.roomId, 'reported');
      await auditEvent('report.filed', { actorType: 'student', actorRef: offenderRefForIdentity(room.identities?.[socket.id]), targetRef: reportedIdentityKey ? offenderRefForIdentity(reportedIdentityKey) : null, institutionId: room.institutionId || null, metadata: { reportId: id, messageReport: false, includeMessages: Boolean(payload?.includeMessages), reason: sanitizeReportReason(payload?.reason) } });
      await count('reports_filed');
      noteReportForAlert(room.institutionId);
      logger.warn('report.filed', { id, reason: sanitizeReportReason(payload?.reason) });
      noteModeratorAlert('new_report', { reportId: id, institutionId: room.institutionId || null, message: 'New safety report requires review.' });
      acknowledge?.({ ok: true });
    });

    socket.on('identity:verify', async (payload, acknowledge) => {
      if (!(await store.consumeRate(`verify:${socket.id}`, 5, 60_000))) return acknowledge?.({ ok: false, error: 'Too many verification attempts. Please wait a minute.' });
      let email = String(payload?.email || '').trim().toLowerCase();
      // In development an explicit email is accepted; with none (a reconnect after
      // refresh) the HttpOnly session cookie is used, exactly as in production.
      if (AUTH_MODE === 'trusted-token' || !email) {
        const presentedToken = payload?.verificationToken || parseCookies(socket.handshake.headers?.cookie || '').maskchat_verification;
        const verified = verifyInstitutionVerificationToken(presentedToken, IDENTITY_VERIFICATION_SECRET);
        if (!verified) return acknowledge?.({ ok: false, error: 'Institution verification is required.' });
        email = verified.email;
      }
      const institution = resolveInstitutionByEmail(email, INSTITUTIONS, { allowDemoFallback: ALLOW_DEMO_INSTITUTIONS });
      if (!institution) return acknowledge?.({ ok: false, error: 'Use an email address from a supported institution.' });
      if (PILOT.enabled) {
        const gate = pilotGate(PILOT, institution.id);
        if (!gate.ok) {
          await count(`pilot_gate_${gate.reason}`);
          await auditEvent('pilot.access_denied', { actorType: 'student', institutionId: institution.id, metadata: { reason: gate.reason } });
          const messages = { pilot_not_started: 'The institution pilot has not started yet.', pilot_ended: 'The institution pilot has ended.', institution_not_in_pilot: 'Your institution is not currently included in this pilot.' };
          return acknowledge?.({ ok: false, error: messages[gate.reason] || 'Pilot access is currently unavailable.' });
        }
        const counters = await store.getCounters();
        const activeUsers = Math.max(0, Number(counters[`pilot_active:${institution.id}`] || 0));
        if (activeUsers >= PILOT.maxActiveUsers) {
          await count('pilot_capacity_denied');
          return acknowledge?.({ ok: false, error: 'The pilot is currently at capacity. Please try again later.' });
        }
      }
      const verifiedIdentityKey = identityKey(email, ALIAS_SECRET);
      const activeBan = await store.getBan(verifiedIdentityKey);
      if (activeBan) return acknowledge?.({ ok: false, error: activeBan.type === 'permanent' ? 'Your MaskChat access is permanently restricted.' : 'Your MaskChat access is temporarily restricted until the restriction expires.' });
      socket.data.profile = {
        alias: dailyAlias(email, ALIAS_SECRET),
        identityKey: verifiedIdentityKey,
        // Phase 5: every mentor/seeker/room record below carries this, and
        // every matching lookup filters on it, so students at different
        // institutions are never shown to each other.
        institutionId: institution.id
      };
      if (PILOT.enabled) {
        await store.incrCounter(`pilot_active:${institution.id}`, 1);
        socket.data.pilotCounted = true;
        await count('pilot_verified');
      }
      logger.info('identity.verified', { identity: shortHash(socket.data.profile.identityKey), institution: institution.id });
      acknowledge?.({ ok: true, alias: socket.data.profile.alias, institution });
    });

    // Phase 3: session history across a refresh. A page reload disconnects
    // the old socket and connects a fresh one, so the client re-verifies
    // (getting the same alias/identityKey back, since both are
    // deterministic) and then calls this to reclaim its seat in the room it
    // was in, before the grace-period timer in 'disconnect' closes it.
    socket.on('session:rejoin', async (payload, acknowledge) => {
      const profile = socket.data.profile;
      if (!profile) return acknowledge?.({ ok: false, error: 'Verify your email first.' });
      const room = await store.getRoom(payload?.roomId);
      if (!room) return acknowledge?.({ ok: false, error: 'This session is no longer active.' });
      const oldSocketId = Object.keys(room.identities || {}).find((id) => room.identities[id] === profile.identityKey);
      if (!oldSocketId || !room.participants.includes(oldSocketId)) {
        return acknowledge?.({ ok: false, error: 'This session is no longer active.' });
      }

      const timerKey = `${payload.roomId}:${oldSocketId}`;
      const timer = pendingDisconnects.get(timerKey);
      if (timer) { clearTimeout(timer); pendingDisconnects.delete(timerKey); }

      const alias = room.aliases[oldSocketId];
      room.participants = room.participants.map((id) => (id === oldSocketId ? socket.id : id));
      delete room.aliases[oldSocketId];
      room.aliases[socket.id] = alias;
      delete room.identities[oldSocketId];
      room.identities[socket.id] = profile.identityKey;
      await store.setRoom(payload.roomId, room);
      io.in(socket.id).socketsJoin(payload.roomId);

      // Phase 5: a group room can have several other participants - report
      // the full roster back (peers), while keeping the original singular
      // `peer` field (first peer, or the sole peer in a classic 1:1 room)
      // for anything still reading it.
      const otherAliases = room.participants.filter((id) => id !== socket.id).map((id) => room.aliases[id]).filter(Boolean);
      const peerAlias = room.demo ? 'Sage Lynx 42' : (otherAliases[0] || 'Unknown');
      socket.to(payload.roomId).emit('peer:reconnected');
      // Only a seeker gets a mentor card (a mentor rejoining doesn't need to
      // see their own), so the client can tell which side it is after a refresh.
      let mentorCard;
      if (room.demo) {
        mentorCard = buildMentorCard({ tags: room.tags, year: 3, sessionsHosted: 12, helpful: 18, seatsFilled: 1, capacity: 1, demo: true });
      } else if (room.mentorIdentityKey && profile.identityKey !== room.mentorIdentityKey) {
        mentorCard = await mentorCardFor({ identityKey: room.mentorIdentityKey, tags: room.mentorTags || room.tags, year: room.mentorYear, seatsFilled: room.participants.length - 1, capacity: room.capacity || 1 });
        if (mentorCard) { mentorCard.expertise = room.mentorExpertise || mentorCard.expertise; mentorCard.topicType = room.mentorTopicType || mentorCard.topicType; }
      }
      acknowledge?.({
        ok: true,
        roomId: payload.roomId,
        peer: peerAlias,
        peers: room.demo ? ['Sage Lynx 42'] : otherAliases,
        tags: room.tags || [],
        startedAt: room.createdAt,
        demo: !!room.demo,
        isGroup: !!room.isGroup,
        capacity: room.capacity || 1,
        mentorCard
      });
    });

    socket.on('disconnect', async () => {
      if (socket.data.pilotCounted && socket.data.profile?.institutionId) {
        await store.incrCounter(`pilot_active:${socket.data.profile.institutionId}`, -1);
        socket.data.pilotCounted = false;
      }
      currentConnections = Math.max(0, currentConnections - 1);
      logger.info('connection.close', { currentConnections });
      await store.deleteMentor(socket.id);
      const removedFromQueue = await store.removeWaitingSeeker(socket.id);
      if (removedFromQueue) await refreshQueuePositions();

      const roomIds = await store.findRoomIdsBySocket(socket.id);
      for (const roomId of roomIds) {
        // Phase 3: don't tear the room down immediately - a page refresh
        // looks identical to a real disconnect here, so give the
        // participant a short grace window to reconnect and call
        // 'session:rejoin' before actually closing the room. See the
        // pendingDisconnects comment above for why this stays correct even
        // across Redis-backed instances.
        socket.to(roomId).emit('peer:reconnecting');
        const timerKey = `${roomId}:${socket.id}`;
        const timer = setTimeout(async () => {
          pendingDisconnects.delete(timerKey);
          const room = await store.getRoom(roomId);
          if (!room || !room.participants.includes(socket.id)) return;
          // Phase 5: a seeker dropping out of a group session (and not
          // reconnecting within the grace window) just leaves that one
          // seat open - it doesn't take the mentor's other seekers down
          // with it. The mentor disconnecting still ends the whole room,
          // same as a classic 1:1 disconnect always has.
          if (room.isGroup && socket.id !== currentMentorSocketId(room)) {
            await leaveRoom(roomId, socket.id, 'peer_disconnected');
          } else {
            await closeRoom(roomId, 'peer_disconnected');
          }
        }, DISCONNECT_GRACE_MS);
        pendingDisconnects.set(timerKey, timer);
      }
    });
  });

  httpServer.listen(PORT, () => {
    console.log(`MaskChat server listening on http${SSL_KEY_PATH ? 's' : ''}://localhost:${PORT}`);
    logger.info('server.started', { port: PORT, storage: store.kind, tls: !!(SSL_KEY_PATH && SSL_CERT_PATH) });
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutdown', { signal, currentConnections });
    // Stop accepting new HTTP/socket connections first so a load balancer can
    // drain this instance cleanly during rolling deploys or node eviction.
    await new Promise((resolve) => io.close(() => resolve()));
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      httpServer.close(() => { clearTimeout(timer); resolve(); });
    });
    for (const timer of pendingDisconnects.values()) clearTimeout(timer);
    pendingDisconnects.clear();
    if (metricsTimer) clearInterval(metricsTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    await Promise.all([
      ...redisClients.map((client) => client.quit().catch(() => {})),
      typeof store.close === 'function' ? store.close().catch(() => {}) : Promise.resolve()
    ]);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('MaskChat failed to start:', error);
  logger.error('server.boot_failed', { error: error.message });
  process.exit(1);
});
