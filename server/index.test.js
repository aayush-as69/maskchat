import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  dailyAlias,
  identityKey,
  detectViolation,
  sanitizeTags,
  tagScore,
  sanitizeReportReason,
  sanitizeReportDetails,
  sanitizeReportMessages,
  createSlidingWindowLimiter,
  createViolationTracker,
  sanitizeCapacity,
  sanitizeYear,
  yearLabel,
  buildMentorCard,
  buildReopenedMentorEntry,
  groupRoomHasOpenSeat,
  MAX_GROUP_CAPACITY,
  sanitizeTopicType,
  sanitizeExpertise,
  sanitizeSchedule,
  buildMentorRecognition,
  createOffenderRef,
  verifyInstitutionVerificationToken
} from './core.js';

test('daily aliases are stable for one day but rotate with the day', () => {
  const secret = 'test-secret';
  const email = 'student@galgotiacollege.edu.in';
  const first = dailyAlias(email, secret, new Date('2026-09-13T08:00:00Z'));
  assert.equal(first, dailyAlias(email, secret, new Date('2026-09-13T20:00:00Z')));
  assert.notEqual(first, dailyAlias(email, secret, new Date('2026-09-14T08:00:00Z')));
});

test('identityKey stays stable across days and differs from the rotating alias', () => {
  const secret = 'test-secret';
  const email = 'student@galgotiacollege.edu.in';
  const keyOnDay1 = identityKey(email, secret);
  const keyOnDay2 = identityKey(email, secret);
  assert.equal(keyOnDay1, keyOnDay2);
  assert.notEqual(keyOnDay1, dailyAlias(email, secret));
  assert.notEqual(identityKey('other@galgotiacollege.edu.in', secret), keyOnDay1);
});

test('tag matching is case-insensitive and only retains usable tags', () => {
  assert.deepEqual(sanitizeTags([' DBMS ', 'DBMS', '', 'Python']), ['DBMS', 'Python']);
  assert.equal(tagScore(['dbms', 'Operating Systems'], ['DBMS', 'Python']), 1);
});

test('privacy filter blocks identifiers and harassment before delivery', () => {
  assert.equal(detectViolation('Contact me at test@example.com'), 'For privacy, do not share contact details or identifying information.');
  assert.equal(detectViolation('You are an idiot'), 'Please keep the conversation respectful.');
  assert.equal(detectViolation('Could you explain deadlocks?'), null);
});

test('report sanitizers fall back to safe defaults and trim length', () => {
  assert.equal(sanitizeReportReason('harassment'), 'harassment');
  assert.equal(sanitizeReportReason('made-up-reason'), 'other');
  assert.equal(sanitizeReportDetails('  hello  '), 'hello');
  assert.equal(sanitizeReportDetails('x'.repeat(600)).length, 500);
  const messages = sanitizeReportMessages([{ sender: 'a', text: 'b', sentAt: '2026-01-01' }, 'not-an-object']);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].sender, 'a');
  assert.equal(messages[1].sender, 'Unknown');
  assert.deepEqual(sanitizeReportMessages('nope'), []);
});

test('sliding window limiter allows up to the limit then blocks within the window', () => {
  const allow = createSlidingWindowLimiter(2, 1000);
  const now = 1_000_000;
  assert.equal(allow('socket-1', now), true);
  assert.equal(allow('socket-1', now + 10), true);
  assert.equal(allow('socket-1', now + 20), false);
  assert.equal(allow('socket-1', now + 1500), true); // window has rolled over
  assert.equal(allow('socket-2', now + 20), true); // separate key, separate bucket
});

test('sanitizeCapacity clamps to a sane group size (Phase 5)', () => {
  assert.equal(sanitizeCapacity(undefined), 1); // default: classic 1:1
  assert.equal(sanitizeCapacity(0), 1);
  assert.equal(sanitizeCapacity(-3), 1);
  assert.equal(sanitizeCapacity('not a number'), 1);
  assert.equal(sanitizeCapacity(3), 3);
  assert.equal(sanitizeCapacity(3.9), 3); // truncates, doesn't round
  assert.equal(sanitizeCapacity(MAX_GROUP_CAPACITY), MAX_GROUP_CAPACITY);
  assert.equal(sanitizeCapacity(MAX_GROUP_CAPACITY + 10), MAX_GROUP_CAPACITY);
});

test('violation tracker escalates once the threshold is reached inside the window', () => {
  const tracker = createViolationTracker(3, 1000);
  const now = 2_000_000;
  assert.equal(tracker.shouldEscalate(tracker.record('socket-1', now)), false);
  assert.equal(tracker.shouldEscalate(tracker.record('socket-1', now + 10)), false);
  assert.equal(tracker.shouldEscalate(tracker.record('socket-1', now + 20)), true);
  tracker.clear('socket-1');
  assert.equal(tracker.shouldEscalate(tracker.record('socket-1', now + 30)), false);
});

test('sanitizeYear / yearLabel accept 1-6 only and format ordinals', () => {
  assert.equal(sanitizeYear(3), 3);
  assert.equal(sanitizeYear('2'), 2);
  assert.equal(sanitizeYear(0), null);
  assert.equal(sanitizeYear(7), null);
  assert.equal(sanitizeYear('abc'), null);
  assert.equal(sanitizeYear(undefined), null);
  assert.deepEqual([1, 2, 3, 4].map(yearLabel), ['1st year', '2nd year', '3rd year', '4th year']);
  assert.equal(yearLabel(null), null);
});

test('buildMentorCard only exposes allow-listed, non-identifying fields', () => {
  const card = buildMentorCard({
    tags: ['DBMS', 'Java'], year: 3, sessionsHosted: 12, helpful: 18, seatsFilled: 3, capacity: 5,
    // Anything extra a caller passes must never make it into the card.
    email: 'a@b.edu', identityKey: 'secret', alias: 'Amber Falcon 12', socketId: 'abc'
  });
  assert.deepEqual(Object.keys(card).sort(), ['availableNow', 'badges', 'capacity', 'demo', 'expertise', 'helpful', 'seatsFilled', 'sessionsHosted', 'tags', 'topicType', 'verified', 'year', 'yearLabel']);
  assert.equal(card.yearLabel, '3rd year');
  assert.equal(card.helpful, 18);
  assert.equal(card.capacity, 5);
  const json = JSON.stringify(card);
  for (const leaked of ['a@b.edu', 'secret', 'Amber Falcon', 'abc"']) assert.ok(!json.includes(leaked), `leaked ${leaked}`);
});

test('buildMentorCard clamps bad numbers', () => {
  const card = buildMentorCard({ tags: 'nope', year: 99, sessionsHosted: -4, helpful: 'x', seatsFilled: -1, capacity: 999 });
  assert.deepEqual(card.tags, []);
  assert.equal(card.year, null);
  assert.equal(card.sessionsHosted, 0);
  assert.equal(card.helpful, 0);
  assert.equal(card.seatsFilled, 0);
  assert.equal(card.capacity, MAX_GROUP_CAPACITY);
});

test('groupRoomHasOpenSeat counts seekers (participants minus the mentor) against capacity', () => {
  const room = (n, extra = {}) => ({ isGroup: true, capacity: 3, participants: Array.from({ length: n }, (_, i) => `p${i}`), ...extra });
  assert.equal(groupRoomHasOpenSeat(room(3)), true); // mentor + 2 seekers of 3
  assert.equal(groupRoomHasOpenSeat(room(4)), false); // mentor + 3 seekers: full
  assert.equal(groupRoomHasOpenSeat(room(2, { isGroup: false })), false);
  assert.equal(groupRoomHasOpenSeat(null), false);
});

test('buildReopenedMentorEntry rebuilds a pool entry from the room after a seat frees up', () => {
  const room = {
    participants: ['m-new', 's1', 's2'],
    aliases: { 'm-new': 'Amber Falcon 12', s1: 'A', s2: 'B' },
    mentorIdentityKey: 'id-key', mentorTags: ['DBMS', 'Python'], mentorYear: 3,
    institutionId: 'galgotias', capacity: 3, tags: ['DBMS', 'Python'], createdAt: 1234
  };
  const entry = buildReopenedMentorEntry({ roomId: 'room-1', room, mentorSocketId: 'm-new' });
  assert.deepEqual(entry, {
    socketId: 'm-new', alias: 'Amber Falcon 12', identityKey: 'id-key', institutionId: 'galgotias',
    tags: ['DBMS', 'Python'], capacity: 3, year: 3, expertise: 'intermediate', topicType: 'academic', schedule: [], scheduleId: null, seekerCount: 2, roomId: 'room-1', joinedAt: 1234
  });
  // An existing entry keeps its own joinedAt and only has the seat count refreshed.
  const refreshed = buildReopenedMentorEntry({ roomId: 'room-1', room, mentorSocketId: 'm-new', existing: { ...entry, seekerCount: 3, joinedAt: 99 } });
  assert.equal(refreshed.seekerCount, 2);
  assert.equal(refreshed.joinedAt, 99);
});


test('Phase 8 profile helpers sanitize expertise, topic type and schedule', () => {
  assert.equal(sanitizeExpertise('advanced'), 'advanced');
  assert.equal(sanitizeExpertise('bio'), 'intermediate');
  assert.equal(sanitizeTopicType('career'), 'career');
  assert.equal(sanitizeTopicType('unknown'), 'academic');
  assert.deepEqual(sanitizeSchedule([{ day: 2, start: '18:00', end: '19:00' }, { day: 99, start: '', end: '' }]), [{ day: 2, start: '18:00', end: '19:00' }]);
});

test('Phase 8 recognition derives privacy-safe badges from aggregate counts', () => {
  assert.deepEqual(buildMentorRecognition({ sessionsHosted: 10, helpful: 20 }), ['First session', '5 sessions', '10 sessions', 'Helpful mentor', 'Community favorite']);
});

test('Phase 9 moderation catches English profanity and common evasion variants', () => {
  assert.equal(detectViolation('you are an 1d10t'), 'Please keep the conversation respectful.');
  assert.equal(detectViolation('you are stuuupid!!!'), 'Please keep the conversation respectful.');
  assert.equal(detectViolation('Let us finish the DBMS question'), null);
});

test('Phase 9 blocks links and attachments to protect anonymity', () => {
  assert.equal(detectViolation('Join me at https://example.com'), 'Links are disabled to protect anonymity. Please keep the conversation inside MaskChat.');
  assert.equal(detectViolation('example.com/myprofile'), 'Links are disabled to protect anonymity. Please keep the conversation inside MaskChat.');
  assert.equal(detectViolation('Here is the file', { attachments: [{ name: 'photo.png' }] }), 'Attachments are disabled to protect anonymity.');
});


test('offender references do not expose the stable identity key', () => {
  const key = identityKey('student@galgotiacollege.edu.in', 'long-test-secret');
  const ref = createOffenderRef(key, 'offender-ref-secret');
  assert.match(ref, /^[a-f0-9]{24}$/);
  assert.notEqual(ref, key);
});

test('trusted institution verification tokens are signed and expire', () => {
  const secret = 'trusted-verification-secret';
  const payload = Buffer.from(JSON.stringify({ email: 'student@galgotiacollege.edu.in', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const verified = verifyInstitutionVerificationToken(`${payload}.${signature}`, secret);
  assert.equal(verified.email, 'student@galgotiacollege.edu.in');
  assert.equal(verifyInstitutionVerificationToken(`${payload}.bad`, secret), null);
});

test('detectViolation does not flag ordinary uses of the word "roll"', async () => {
  const { detectViolation } = await import('./core.js');
  assert.equal(detectViolation('Should I roll the dice on this elective?'), null);
  assert.ok(detectViolation('my roll no 12345'));
});
