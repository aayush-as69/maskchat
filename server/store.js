// Phase 2: a small storage abstraction so the matchmaking/room/rate-limit
// state can live in-memory (single process, the original prototype
// behavior) or in Redis (shared across multiple server instances behind a
// load balancer). index.js only ever talks to this interface - it never
// touches a Map or a Redis client directly - so swapping the backend is a
// one-line change (whether REDIS_URL is set) rather than a rewrite.
//
// Both implementations expose the same async methods. Nothing here is
// Socket.io-specific: it only stores plain JSON-serializable data.

import crypto from 'node:crypto';

const KEY_PREFIX = 'maskchat:';

/**
 * Runs `fn` while holding the named lock, so two concurrent callers (two
 * sockets on one process, or two server instances sharing Redis) can't be
 * inside the same critical section at once. Waits up to `waitMs` for the
 * lock; if it never frees up, `fn` is NOT run, `onTimeout` is called, and
 * this returns null. `ttlMs` is only a crash safety net (a holder that dies
 * can't wedge the lock forever) - keep `fn` well under it.
 */
export async function withLock(store, key, fn, { ttlMs = 5000, waitMs = 3000, retryMs = 15, onTimeout } = {}) {
  const deadline = Date.now() + waitMs;
  let token = await store.acquireLock(key, ttlMs);
  while (!token) {
    if (Date.now() >= deadline) {
      onTimeout?.();
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    token = await store.acquireLock(key, ttlMs);
  }
  try {
    return await fn();
  } finally {
    await store.releaseLock(key, token);
  }
}

// Compare-and-delete: only the holder that set the token may release, so a
// slow holder whose lock already expired can't delete the *next* holder's.
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

/**
 * Single-process, memory-only store. Identical behavior to the original
 * prototype. Good for local dev and small single-instance deployments -
 * everything is lost on restart, which matches the "ephemeral by design"
 * privacy model.
 */
export function createMemoryStore() {
  const mentors = new Map();
  const rooms = new Map();
  const cooldowns = new Map();
  const rateBuckets = new Map();
  const violationBuckets = new Map();
  const reports = new Map();
  // Phase 3: seekers waiting for a mentor (queue UX), and lightweight
  // thumbs-up/down feedback aggregated per mentor identityKey (not per
  // socket or daily alias, so it survives reconnects and day rollovers
  // without ever being linked back to a real name).
  const waitingSeekers = new Map();
  const feedback = new Map();
  // Phase 4: observability counters. Plain cumulative counts (never reset
  // except by process restart) - index.js derives rates like "match success
  // rate" or "block-filter hit rate" from ratios between them at read time,
  // so nothing here needs to know what a "rate" even means.
  const counters = new Map();
  // Mentor profile card: how many sessions each mentor (by identityKey) has
  // opened. Same privacy properties as `feedback` above.
  const hosted = new Map();
  const locks = new Map();
  const blocks = new Map();
  const schedules = new Map();
  const scheduledSessions = new Map();
  // Phase 9: moderator escalation state. Identity keys are admin-only and
  // never returned to clients.
  const offenderReports = new Map();
  const bans = new Map();

  function prune(map, key, windowMs, now) {
    const kept = (map.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
    map.set(key, kept);
    return kept;
  }

  return {
    kind: 'memory',
    async close() {},

    // Advisory mutex. JS is single-threaded, but every `await` between a
    // read and its write is a point where another handler can run, so the
    // in-memory store needs this too - not just Redis.
    async acquireLock(key, ttlMs) {
      const held = locks.get(key);
      if (held && held.until > Date.now()) return null;
      const token = crypto.randomUUID();
      locks.set(key, { token, until: Date.now() + ttlMs });
      return token;
    },
    async releaseLock(key, token) {
      if (locks.get(key)?.token !== token) return false;
      locks.delete(key);
      return true;
    },

    async setMentor(socketId, data) { mentors.set(socketId, data); },
    async deleteMentor(socketId) { mentors.delete(socketId); },
    async listMentors() { return [...mentors.values()]; },
    // Non-destructive read, unlike claimMentor below. Phase 5 (group
    // sessions) needs this to peek at a mentor's remaining capacity/roomId
    // while deciding whether to add a seeker to their existing room or
    // claim them outright - claimMentor's get-and-remove semantics would
    // wrongly evict a mentor who still has room for more seekers.
    async getMentor(socketId) { return mentors.get(socketId) || null; },
    // Atomic get-and-remove. On a single process this is trivially safe
    // (JS is single-threaded), but it exists so callers can use the same
    // race-free claim pattern regardless of which store backend is active.
    async claimMentor(socketId) {
      const data = mentors.get(socketId);
      if (!data) return null;
      mentors.delete(socketId);
      return data;
    },

    async setRoom(roomId, data) { rooms.set(roomId, data); },
    async getRoom(roomId) { return rooms.get(roomId) || null; },
    async listRooms() { return [...rooms.entries()].map(([id, room]) => ({ id, ...room })); },
    async deleteRoom(roomId) { rooms.delete(roomId); },
    async findRoomIdsBySocket(socketId) {
      return [...rooms.entries()].filter(([, room]) => room.participants.includes(socketId)).map(([id]) => id);
    },

    async getCooldown(key) {
      const until = cooldowns.get(key);
      return until && until > Date.now() ? until : null;
    },
    async setCooldown(key, until) { cooldowns.set(key, until); },

    async consumeRate(key, limit, windowMs, now = Date.now()) {
      const kept = prune(rateBuckets, key, windowMs, now);
      if (kept.length >= limit) return false;
      kept.push(now);
      rateBuckets.set(key, kept);
      return true;
    },

    async recordViolation(key, windowMs, now = Date.now()) {
      const kept = prune(violationBuckets, key, windowMs, now);
      kept.push(now);
      violationBuckets.set(key, kept);
      return kept.length;
    },
    async clearViolations(key) { violationBuckets.delete(key); },

    async setReport(id, data) { reports.set(id, data); },
    async getReport(id) { return reports.get(id) || null; },
    async listReports() { return [...reports.values()]; },
    async deleteReport(id) { return reports.delete(id); },
    async recordOffenderReport(identityKey, now = Date.now()) {
      if (!identityKey) return 0;
      const next = (offenderReports.get(identityKey) || 0) + 1; offenderReports.set(identityKey, next); return next;
    },
    async getOffenderReportCount(identityKey) { return offenderReports.get(identityKey) || 0; },
    async listOffenders() { return [...offenderReports.entries()].map(([identityKey, reportCount]) => ({ identityKey, reportCount })); },
    async setBan(identityKey, data) { bans.set(identityKey, data); return true; },
    async getBan(identityKey) { const ban = bans.get(identityKey); if (!ban) return null; if (ban.until && ban.until <= Date.now()) { bans.delete(identityKey); return null; } return ban; },
    async deleteBan(identityKey) { return bans.delete(identityKey); },
    async listBans() { return [...bans.entries()].map(([identityKey, ban]) => ({ identityKey, ...ban })).filter((ban) => !ban.until || ban.until > Date.now()); },

    // --- Phase 3: matchmaking queue ---------------------------------------
    async addWaitingSeeker(socketId, data) { waitingSeekers.set(socketId, data); },
    async removeWaitingSeeker(socketId) { return waitingSeekers.delete(socketId); },
    // Atomic get-and-remove, mirroring claimMentor - so a seeker can't be
    // matched twice if a mentor-triggered match and a fresh match:request
    // race each other.
    async claimWaitingSeeker(socketId) {
      const data = waitingSeekers.get(socketId);
      if (!data) return null;
      waitingSeekers.delete(socketId);
      return data;
    },
    async listWaitingSeekers() { return [...waitingSeekers.values()]; },

    // --- Phase 3: mentor quality signal ------------------------------------
    async recordFeedback(identityKey, positive) {
      const current = feedback.get(identityKey) || { up: 0, down: 0 };
      const next = positive ? { ...current, up: current.up + 1 } : { ...current, down: current.down + 1 };
      feedback.set(identityKey, next);
      return next;
    },
    async getFeedbackStats(identityKey) { return feedback.get(identityKey) || { up: 0, down: 0 }; },

    // --- Mentor profile card ------------------------------------------------
    async incrHosted(identityKey) {
      const next = (hosted.get(identityKey) || 0) + 1;
      hosted.set(identityKey, next);
      return next;
    },
    async getHosted(identityKey) { return hosted.get(identityKey) || 0; },

    async blockIdentity(identityKey, blockedIdentityKey) {
      const set = blocks.get(identityKey) || new Set();
      set.add(blockedIdentityKey); blocks.set(identityKey, set); return true;
    },
    async unblockIdentity(identityKey, blockedIdentityKey) {
      return blocks.get(identityKey)?.delete(blockedIdentityKey) || false;
    },
    async isBlocked(identityKey, blockedIdentityKey) { return blocks.get(identityKey)?.has(blockedIdentityKey) || false; },
    async listBlocked(identityKey) { return [...(blocks.get(identityKey) || new Set())]; },
    async setSchedule(identityKey, data) { schedules.set(identityKey, data); },
    async getSchedule(identityKey) { return schedules.get(identityKey) || []; },
    async setScheduledSession(id, data) { scheduledSessions.set(id, data); },
    async getScheduledSession(id) { return scheduledSessions.get(id) || null; },
    async listScheduledSessions(identityKey) { return [...scheduledSessions.values()].filter((item) => item.mentorIdentityKey === identityKey || item.seekerIdentityKey === identityKey); },
    async deleteScheduledSession(id) { return scheduledSessions.delete(id); },

    // --- Phase 4: observability counters -----------------------------------
    async incrCounter(name, by = 1) {
      const next = (counters.get(name) || 0) + by;
      counters.set(name, next);
      return next;
    },
    async getCounters() { return Object.fromEntries(counters); },

    // Mirrors the Redis store's readiness check. Always true here - an
    // in-memory store has no external dependency to be unready for.
    async ping() { return true; }
  };
}

/**
 * Redis-backed store for running multiple server instances behind a load
 * balancer. Rooms and mentor entries carry a TTL as a safety net (so a
 * crashed instance can't leave orphaned entries forever); rate limits and
 * violation tracking use sorted sets for a proper sliding window.
 *
 * `redisClient` is expected to be an ioredis-compatible client, already
 * connected. This module never imports ioredis itself - see index.js, which
 * only loads it when REDIS_URL is configured, so a Redis-less dev setup
 * never needs the package installed.
 */
export function createRedisStore(redisClient, { mentorTtlSeconds = 3600, roomTtlSeconds = 6 * 3600 } = {}) {
  const mentorKey = (id) => `${KEY_PREFIX}mentor:${id}`;
  const roomKey = (id) => `${KEY_PREFIX}room:${id}`;
  const lockKey = (key) => `${KEY_PREFIX}lock:${key}`;
  const cooldownKey = (key) => `${KEY_PREFIX}cooldown:${key}`;
  const rateKey = (key) => `${KEY_PREFIX}rate:${key}`;
  const violationKey = (key) => `${KEY_PREFIX}violation:${key}`;
  const REPORTS_HASH = `${KEY_PREFIX}reports`;
  const waitingKey = (id) => `${KEY_PREFIX}queue:${id}`;
  const feedbackKey = (identityKey) => `${KEY_PREFIX}feedback:${identityKey}`;
  // Phase 4: one hash holding every named counter, shared across instances -
  // so /api/metrics reflects the whole cluster, not just whichever instance
  // happens to answer the request.
  const COUNTERS_HASH = `${KEY_PREFIX}counters`;
  // Mentor profile card: one hash of identityKey -> sessions hosted.
  const HOSTED_HASH = `${KEY_PREFIX}hosted`;
  const BLOCKS_HASH = `${KEY_PREFIX}blocks`;
  const SCHEDULE_HASH = `${KEY_PREFIX}schedules`;
  const SCHEDULED_HASH = `${KEY_PREFIX}scheduled`;
  const OFFENDERS_HASH = `${KEY_PREFIX}offenders`;
  const BANS_HASH = `${KEY_PREFIX}bans`;

  // SCAN instead of KEYS: KEYS blocks the whole Redis instance on large
  // datasets, SCAN doesn't. Mentor/room counts here are expected to be
  // small (bounded by concurrent users), but there's no reason to risk it.
  async function scanAll(pattern) {
    const found = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      found.push(...keys);
    } while (cursor !== '0');
    return found;
  }

  return {
    kind: 'redis',
    async close() { await redisClient.quit(); },

    // SET NX PX is atomic across instances; the value is a per-acquire token
    // so release can verify ownership (see RELEASE_LOCK_SCRIPT).
    async acquireLock(key, ttlMs) {
      const token = crypto.randomUUID();
      const reply = await redisClient.set(lockKey(key), token, 'PX', ttlMs, 'NX');
      return reply === 'OK' ? token : null;
    },
    async releaseLock(key, token) {
      return (await redisClient.eval(RELEASE_LOCK_SCRIPT, 1, lockKey(key), token)) === 1;
    },

    async setMentor(socketId, data) {
      await redisClient.set(mentorKey(socketId), JSON.stringify(data), 'EX', mentorTtlSeconds);
    },
    async deleteMentor(socketId) { await redisClient.del(mentorKey(socketId)); },
    async listMentors() {
      const keys = await scanAll(`${KEY_PREFIX}mentor:*`);
      if (!keys.length) return [];
      const values = await redisClient.mget(...keys);
      return values.filter(Boolean).map((value) => JSON.parse(value));
    },
    // See the memory store's getMentor for why Phase 5 needs a non-atomic
    // peek here too. Note this does *not* refresh the TTL the way setMentor
    // does - it's a read, not a keep-alive.
    async getMentor(socketId) {
      const value = await redisClient.get(mentorKey(socketId));
      return value ? JSON.parse(value) : null;
    },
    // GETDEL is atomic in Redis itself, so two instances racing to claim the
    // same mentor can't both succeed - exactly the guarantee match:request
    // needs when multiple server processes share this store.
    async claimMentor(socketId) {
      const value = await redisClient.getdel(mentorKey(socketId));
      return value ? JSON.parse(value) : null;
    },

    async setRoom(roomId, data) {
      await redisClient.set(roomKey(roomId), JSON.stringify(data), 'EX', roomTtlSeconds);
    },
    async getRoom(roomId) {
      const value = await redisClient.get(roomKey(roomId));
      return value ? JSON.parse(value) : null;
    },
    async listRooms() {
      const keys = await scanAll(`${KEY_PREFIX}room:*`);
      if (!keys.length) return [];
      const values = await redisClient.mget(...keys);
      const prefixLen = `${KEY_PREFIX}room:`.length;
      return keys.map((key, index) => ({ id: key.slice(prefixLen), ...(values[index] ? JSON.parse(values[index]) : {}) })).filter((room) => room.id && Array.isArray(room.participants));
    },
    async deleteRoom(roomId) { await redisClient.del(roomKey(roomId)); },
    async findRoomIdsBySocket(socketId) {
      const keys = await scanAll(`${KEY_PREFIX}room:*`);
      if (!keys.length) return [];
      const values = await redisClient.mget(...keys);
      const prefixLen = `${KEY_PREFIX}room:`.length;
      return keys
        .map((key, index) => ({ id: key.slice(prefixLen), room: values[index] ? JSON.parse(values[index]) : null }))
        .filter(({ room }) => room && room.participants.includes(socketId))
        .map(({ id }) => id);
    },

    async getCooldown(key) {
      const value = await redisClient.get(cooldownKey(key));
      return value ? Number(value) : null;
    },
    async setCooldown(key, until) {
      const ttlSeconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
      await redisClient.set(cooldownKey(key), String(until), 'EX', ttlSeconds);
    },

    async consumeRate(key, limit, windowMs) {
      const redisKey = rateKey(key);
      const now = Date.now();
      await redisClient.zremrangebyscore(redisKey, 0, now - windowMs);
      const count = await redisClient.zcard(redisKey);
      if (count >= limit) {
        await redisClient.pexpire(redisKey, windowMs);
        return false;
      }
      await redisClient.zadd(redisKey, now, `${now}:${Math.random().toString(36).slice(2)}`);
      await redisClient.pexpire(redisKey, windowMs);
      return true;
    },

    async recordViolation(key, windowMs) {
      const redisKey = violationKey(key);
      const now = Date.now();
      await redisClient.zremrangebyscore(redisKey, 0, now - windowMs);
      await redisClient.zadd(redisKey, now, `${now}:${Math.random().toString(36).slice(2)}`);
      await redisClient.pexpire(redisKey, windowMs);
      return redisClient.zcard(redisKey);
    },
    async clearViolations(key) { await redisClient.del(violationKey(key)); },

    async setReport(id, data) { await redisClient.hset(REPORTS_HASH, id, JSON.stringify(data)); },
    async getReport(id) {
      const value = await redisClient.hget(REPORTS_HASH, id);
      return value ? JSON.parse(value) : null;
    },
    async listReports() {
      const all = await redisClient.hgetall(REPORTS_HASH);
      return Object.values(all).map((value) => JSON.parse(value));
    },
    async deleteReport(id) {
      const removed = await redisClient.hdel(REPORTS_HASH, id);
      return removed > 0;
    },
    async recordOffenderReport(identityKey) { return Number(await redisClient.hincrby(OFFENDERS_HASH, identityKey, 1)); },
    async getOffenderReportCount(identityKey) { return Number(await redisClient.hget(OFFENDERS_HASH, identityKey)) || 0; },
    async listOffenders() { const all = await redisClient.hgetall(OFFENDERS_HASH); return Object.entries(all).map(([identityKey, reportCount]) => ({ identityKey, reportCount: Number(reportCount) || 0 })); },
    async setBan(identityKey, data) { await redisClient.hset(BANS_HASH, identityKey, JSON.stringify(data)); return true; },
    async getBan(identityKey) { const value = await redisClient.hget(BANS_HASH, identityKey); if (!value) return null; const ban = JSON.parse(value); if (ban.until && ban.until <= Date.now()) { await redisClient.hdel(BANS_HASH, identityKey); return null; } return ban; },
    async deleteBan(identityKey) { return (await redisClient.hdel(BANS_HASH, identityKey)) > 0; },
    async listBans() { const all = await redisClient.hgetall(BANS_HASH); return Object.entries(all).map(([identityKey, value]) => ({ identityKey, ...JSON.parse(value) })).filter((ban) => !ban.until || ban.until > Date.now()); },

    // --- Phase 3: matchmaking queue ---------------------------------------
    // Same key-per-entry + TTL + SCAN pattern as mentors, so a seeker's
    // place in the queue is also cleaned up automatically if their instance
    // crashes without a clean disconnect.
    async addWaitingSeeker(socketId, data) {
      await redisClient.set(waitingKey(socketId), JSON.stringify(data), 'EX', mentorTtlSeconds);
    },
    async removeWaitingSeeker(socketId) {
      const removed = await redisClient.del(waitingKey(socketId));
      return removed > 0;
    },
    async claimWaitingSeeker(socketId) {
      const value = await redisClient.getdel(waitingKey(socketId));
      return value ? JSON.parse(value) : null;
    },
    async listWaitingSeekers() {
      const keys = await scanAll(`${KEY_PREFIX}queue:*`);
      if (!keys.length) return [];
      const values = await redisClient.mget(...keys);
      return values.filter(Boolean).map((value) => JSON.parse(value));
    },

    // --- Phase 3: mentor quality signal ------------------------------------
    async recordFeedback(identityKey, positive) {
      const field = positive ? 'up' : 'down';
      await redisClient.hincrby(feedbackKey(identityKey), field, 1);
      const [up, down] = await redisClient.hmget(feedbackKey(identityKey), 'up', 'down');
      return { up: Number(up) || 0, down: Number(down) || 0 };
    },
    async getFeedbackStats(identityKey) {
      const [up, down] = await redisClient.hmget(feedbackKey(identityKey), 'up', 'down');
      return { up: Number(up) || 0, down: Number(down) || 0 };
    },

    // --- Mentor profile card ------------------------------------------------
    async incrHosted(identityKey) { return redisClient.hincrby(HOSTED_HASH, identityKey, 1); },
    async getHosted(identityKey) { return Number(await redisClient.hget(HOSTED_HASH, identityKey)) || 0; },

    async blockIdentity(identityKey, blockedIdentityKey) { await redisClient.sadd(`${BLOCKS_HASH}:${identityKey}`, blockedIdentityKey); return true; },
    async unblockIdentity(identityKey, blockedIdentityKey) { return (await redisClient.srem(`${BLOCKS_HASH}:${identityKey}`, blockedIdentityKey)) > 0; },
    async isBlocked(identityKey, blockedIdentityKey) { return (await redisClient.sismember(`${BLOCKS_HASH}:${identityKey}`, blockedIdentityKey)) === 1; },
    async listBlocked(identityKey) { return redisClient.smembers(`${BLOCKS_HASH}:${identityKey}`); },
    async setSchedule(identityKey, data) { await redisClient.hset(SCHEDULE_HASH, identityKey, JSON.stringify(data)); },
    async getSchedule(identityKey) { const v = await redisClient.hget(SCHEDULE_HASH, identityKey); return v ? JSON.parse(v) : []; },
    async setScheduledSession(id, data) { await redisClient.hset(SCHEDULED_HASH, id, JSON.stringify(data)); },
    async getScheduledSession(id) { const v = await redisClient.hget(SCHEDULED_HASH, id); return v ? JSON.parse(v) : null; },
    async listScheduledSessions(identityKey) { const all = await redisClient.hgetall(SCHEDULED_HASH); return Object.values(all).map(JSON.parse).filter((item) => item.mentorIdentityKey === identityKey || item.seekerIdentityKey === identityKey); },
    async deleteScheduledSession(id) { return (await redisClient.hdel(SCHEDULED_HASH, id)) > 0; },

    // --- Phase 4: observability counters -----------------------------------
    async incrCounter(name, by = 1) { return redisClient.hincrby(COUNTERS_HASH, name, by); },
    async getCounters() {
      const all = await redisClient.hgetall(COUNTERS_HASH);
      return Object.fromEntries(Object.entries(all).map(([key, value]) => [key, Number(value) || 0]));
    },

    // Used by /api/ready: a cheap round trip that proves the Redis
    // connection this instance depends on is actually up, not just that the
    // client object was constructed successfully at boot.
    async ping() {
      const reply = await redisClient.ping();
      return reply === 'PONG';
    }
  };
}

/**
 * Phase 16: combine durable PostgreSQL records with the existing realtime
 * store. Redis/memory remains responsible for sockets, rooms, queues, locks,
 * counters and short-lived abuse windows; PostgreSQL owns records that must
 * survive restarts and Redis TTL expiry.
 */
export function createDurableStore(ephemeralStore, durableStore) {
  if (!durableStore) return ephemeralStore;
  return {
    ...ephemeralStore,
    kind: `${ephemeralStore.kind}+postgres`,
    async close() { await Promise.allSettled([ephemeralStore.close(), durableStore.close()]); },
    ping: async () => {
      const [ephemeralOk, durableOk] = await Promise.all([ephemeralStore.ping(), durableStore.ping()]);
      return Boolean(ephemeralOk && durableOk);
    },
    setReport: durableStore.setReport,
    getReport: durableStore.getReport,
    listReports: durableStore.listReports,
    deleteReport: durableStore.deleteReport,
    recordOffenderReport: durableStore.recordOffenderReport,
    getOffenderReportCount: durableStore.getOffenderReportCount,
    listOffenders: durableStore.listOffenders,
    setBan: durableStore.setBan,
    getBan: durableStore.getBan,
    deleteBan: durableStore.deleteBan,
    listBans: durableStore.listBans,
    recordFeedback: durableStore.recordFeedback,
    getFeedbackStats: durableStore.getFeedbackStats,
    setSchedule: durableStore.setSchedule,
    getSchedule: durableStore.getSchedule,
    setScheduledSession: durableStore.setScheduledSession,
    getScheduledSession: durableStore.getScheduledSession,
    listScheduledSessions: durableStore.listScheduledSessions,
    deleteScheduledSession: durableStore.deleteScheduledSession,
    audit: durableStore.audit.bind(durableStore),
    listAudit: durableStore.listAudit.bind(durableStore),
    retention: durableStore.retention.bind(durableStore),
    deleteIdentityData: durableStore.deleteIdentityData.bind(durableStore)
  };
}
