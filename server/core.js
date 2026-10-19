import crypto from 'node:crypto';

const blockedWords = /(?:\bidiot\b|\bstupid\b|\bmoron\b|\bloser\b|\bhate\s+you\b|\bmc\b|\bbc\b)/i;
const moderationVariants = [
  /\b(?:i+d+i+o+t+|1d10t|idi0t)\b/i,
  /\b(?:s+t+u+p+i+d+|stup1d|5tupid)\b/i,
  /\b(?:m+o+r+o+n+|m0r0n)\b/i,
  /\b(?:l+o+s+e+r+|l0ser)\b/i,
  /(?:h+8+\s*(?:u|you)|hate[^a-z0-9]{0,3}you)/i
];

// Phase 9: lightweight English moderation with Unicode normalization and common evasion handling.
function normalizeModerationText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[0-9]/g, (digit) => ({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' }[digit] || digit))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/(.)\1{2,}/gu, '$1$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const blockedLink = /(?:https?:\/\/|www\.)\S+/i;
const blockedDomain = /\b(?:[a-z0-9-]+\.)+(?:com|in|net|org|me|io|co|ly|gg|app)(?:\/\S*)?\b/i;
const personalData = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?<!\d)(?:\+91[ -]?)?[6-9]\d{9}(?!\d)/,
  /\b(?:roll\s*(?:no|number)\b|instagram|linkedin|whatsapp)\s*[:@-]?\s*\S+/i
];

export function dailyAlias(email, secret, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const digest = crypto.createHmac('sha256', secret).update(`${day}:${email.toLowerCase()}`).digest('hex');
  const colours = ['Amber', 'Azure', 'Coral', 'Indigo', 'Jade', 'Lilac', 'Saffron', 'Slate'];
  const animals = ['Badger', 'Falcon', 'Lynx', 'Otter', 'Panda', 'Raven', 'Tiger', 'Wolf'];
  const color = colours[parseInt(digest.slice(0, 2), 16) % colours.length];
  const animal = animals[parseInt(digest.slice(2, 4), 16) % animals.length];
  return `${color} ${animal} ${parseInt(digest.slice(4, 8), 16) % 100}`;
}

// A stable (non-rotating) per-email HMAC, distinct from the daily alias.
// Never shown to another user or exposed over the wire - it exists purely so
// abuse tracking (rate limits, cooldowns) survives a reconnect or a switch
// between server instances, instead of resetting whenever a socket id
// changes. The daily alias remains the only identity other students see.
export function identityKey(email, secret) {
  return crypto.createHmac('sha256', secret).update(`identity:${email.toLowerCase()}`).digest('hex');
}

export function createOffenderRef(identityKey, secret) {
  return crypto.createHmac('sha256', secret).update(`offender:${identityKey}`).digest('hex').slice(0, 24);
}

function base64urlDecode(value) {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function verifyInstitutionVerificationToken(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  let payload;
  try { payload = JSON.parse(base64urlDecode(encoded).toString('utf8')); } catch { return null; }
  if (!payload?.email || !Number.isFinite(Number(payload.exp)) || Number(payload.exp) * 1000 <= now) return null;
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(signature); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { email: String(payload.email).trim().toLowerCase(), exp: Number(payload.exp) };
}

export function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => String(tag).trim().slice(0, 32)).filter(Boolean))].slice(0, 6);
}

// --- Phase 5: group sessions ----------------------------------------------

// A mentor's session is 1:1 (capacity 1, the original/default behavior)
// unless they explicitly opt into hosting more seekers at once. Capped low
// on purpose - this is a peer-support chat, not a lecture hall, and a large
// capacity would make the existing content filter/report flow (built around
// "the other participant") much harder to reason about.
export const MAX_GROUP_CAPACITY = 5;

export function sanitizeCapacity(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_GROUP_CAPACITY);
}

// True while a group room still has an unfilled seat (participants include
// the mentor, so seekers = participants - 1).
export function groupRoomHasOpenSeat(room) {
  return !!room?.isGroup && room.participants.length - 1 < sanitizeCapacity(room.capacity);
}

// Rebuilds a mentor's pool entry from their room record, for reopening a
// seat that a departing seeker just freed. The room already carries every
// field the entry needs (that is why it stores mentorIdentityKey, mentorTags,
// mentorYear, capacity and institutionId), so nothing is invented here.
// `existing` is the mentor's current pool entry if they still have one.
export function buildReopenedMentorEntry({ roomId, room, mentorSocketId, existing = null }) {
  return {
    ...(existing || {}),
    socketId: mentorSocketId,
    alias: room.aliases?.[mentorSocketId] ?? existing?.alias,
    identityKey: room.mentorIdentityKey,
    institutionId: room.institutionId,
    tags: room.mentorTags || room.tags || [],
    capacity: sanitizeCapacity(room.capacity),
    year: room.mentorYear ?? null,
    expertise: room.mentorExpertise || existing?.expertise || 'intermediate',
    topicType: room.mentorTopicType || existing?.topicType || 'academic',
    schedule: room.mentorSchedule || existing?.schedule || [],
    scheduleId: room.mentorScheduleId || existing?.scheduleId || null,
    seekerCount: Math.max(0, room.participants.length - 1),
    roomId,
    joinedAt: existing?.joinedAt ?? room.createdAt ?? Date.now()
  };
}

export function detectViolation(text, { attachments = [] } = {}) {
  if (typeof text !== 'string' || !text.trim()) return 'Messages cannot be empty.';
  if (text.length > 800) return 'Keep messages under 800 characters.';
  if (Array.isArray(attachments) && attachments.length) return 'Attachments are disabled to protect anonymity.';
  if (personalData.some((pattern) => pattern.test(text))) return 'For privacy, do not share contact details or identifying information.';
  if (blockedLink.test(text) || blockedDomain.test(text)) return 'Links are disabled to protect anonymity. Please keep the conversation inside MaskChat.';
  const normalized = normalizeModerationText(text);
  if (blockedWords.test(text) || blockedWords.test(normalized) || moderationVariants.some((pattern) => pattern.test(normalized))) return 'Please keep the conversation respectful.';
  return null;
}

export function moderationPolicy() {
  return { attachments: 'blocked', externalLinks: 'blocked', classifier: 'local English rule filter' };
}

export function tagScore(requested, offered) {
  const mentorTags = new Set(offered.map((tag) => tag.toLowerCase()));
  return requested.reduce((score, tag) => score + Number(mentorTags.has(tag.toLowerCase())), 0);
}



// --- Phase 8: richer anonymous matching/profile helpers -------------------
export const TOPIC_TYPES = new Set(['academic', 'career', 'wellbeing']);
export const EXPERTISE_LEVELS = new Set(['beginner', 'intermediate', 'advanced']);

export function sanitizeTopicType(value) {
  const v = String(value || '').trim().toLowerCase();
  return TOPIC_TYPES.has(v) ? v : 'academic';
}

export function sanitizeExpertise(value) {
  const v = String(value || '').trim().toLowerCase();
  return EXPERTISE_LEVELS.has(v) ? v : 'intermediate';
}

export function sanitizeSchedule(schedule) {
  if (!Array.isArray(schedule)) return [];
  return schedule.slice(0, 14).map((slot) => ({
    start: String(slot?.start || '').slice(0, 32),
    end: String(slot?.end || '').slice(0, 32),
    day: Math.min(6, Math.max(0, Math.trunc(Number(slot?.day) || 0)))
  })).filter((slot) => slot.start && slot.end);
}

export function buildMentorRecognition({ helpful = 0, sessionsHosted = 0 }) {
  const badges = [];
  if (sessionsHosted >= 1) badges.push('First session');
  if (sessionsHosted >= 5) badges.push('5 sessions');
  if (sessionsHosted >= 10) badges.push('10 sessions');
  if (helpful >= 5) badges.push('Helpful mentor');
  if (helpful >= 20) badges.push('Community favorite');
  return badges;
}

// --- Phase 1: trust & safety helpers -------------------------------------

export const REPORT_REASONS = new Set([
  'harassment',
  'inappropriate_content',
  'safety_concern',
  'spam',
  'other'
]);

export function sanitizeReportReason(reason) {
  return REPORT_REASONS.has(reason) ? reason : 'other';
}

export function sanitizeReportDetails(details) {
  return String(details || '').trim().slice(0, 500);
}

// Caps how much of a reporter's own visible transcript can be attached as
// evidence. Never captured automatically - only sent if the reporter opts in.
export function sanitizeReportMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-20).map((message) => ({
    sender: String(message?.sender || 'Unknown').trim().slice(0, 64),
    text: String(message?.text || '').trim().slice(0, 800),
    sentAt: String(message?.sentAt || '')
  }));
}

// Simple in-memory sliding-window rate limiter, keyed by an arbitrary string
// (typically a socket id). Not shared across processes - fine for a single
// instance; swap for a Redis-backed limiter when the server is scaled out.
export function createSlidingWindowLimiter(limit, windowMs) {
  const hits = new Map();
  return function consume(key, now = Date.now()) {
    const timestamps = (hits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
    if (timestamps.length >= limit) {
      hits.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    hits.set(key, timestamps);
    return true;
  };
}

// Tracks how many times a key (socket id) has triggered the content filter
// recently, so repeated abuse can be escalated rather than just re-blocked
// message by message.
export function createViolationTracker(threshold, windowMs) {
  const history = new Map();
  return {
    record(key, now = Date.now()) {
      const timestamps = (history.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
      timestamps.push(now);
      history.set(key, timestamps);
      return timestamps.length;
    },
    shouldEscalate(count) {
      return count >= threshold;
    },
    clear(key) {
      history.delete(key);
    }
  };
}

// --- Mentor profile card ----------------------------------------------------

// Self-declared, optional, deliberately coarse ("3rd year", not a batch or
// graduation date) so it can't narrow a mentor down to one person.
export function sanitizeYear(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 6 ? n : null;
}

export function yearLabel(year) {
  const n = sanitizeYear(year);
  if (!n) return null;
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return `${n}${suffix} year`;
}

// The only mentor data a seeker ever receives. Built from an explicit
// allow-list of fields on purpose: no alias, name, email, identityKey,
// roll number or socket id can leak into the card by accident, because
// nothing is copied over that isn't named here.
export function buildMentorCard({ tags, year, sessionsHosted, helpful, seatsFilled, capacity, expertise = 'intermediate', topicType = 'academic', badges = [] , demo = false }) {
  return {
    tags: Array.isArray(tags) ? tags.slice(0, 4) : [],
    year: sanitizeYear(year),
    yearLabel: yearLabel(year),
    sessionsHosted: Math.max(0, Number(sessionsHosted) || 0),
    helpful: Math.max(0, Number(helpful) || 0),
    verified: true,
    availableNow: true,
    seatsFilled: Math.max(0, Number(seatsFilled) || 0),
    capacity: sanitizeCapacity(capacity),
    expertise: sanitizeExpertise(expertise),
    topicType: sanitizeTopicType(topicType),
    badges: Array.isArray(badges) ? badges.slice(0, 5) : [],
    demo: !!demo
  };
}
