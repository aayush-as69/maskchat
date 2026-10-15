import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, withLock } from './store.js';

test('mentor queue: set, list, and atomic claim', async () => {
  const store = createMemoryStore();
  await store.setMentor('socket-a', { socketId: 'socket-a', alias: 'Amber Falcon 12', tags: ['Python'], joinedAt: 1 });
  assert.deepEqual((await store.listMentors()).map((m) => m.socketId), ['socket-a']);

  const claimed = await store.claimMentor('socket-a');
  assert.equal(claimed.alias, 'Amber Falcon 12');
  assert.equal(await store.claimMentor('socket-a'), null); // already claimed
  assert.deepEqual(await store.listMentors(), []);
});

test('getMentor peeks without removing, unlike claimMentor (Phase 5)', async () => {
  const store = createMemoryStore();
  assert.equal(await store.getMentor('socket-a'), null);
  await store.setMentor('socket-a', { socketId: 'socket-a', alias: 'Amber Falcon 12', capacity: 3, seekerCount: 0, roomId: null, joinedAt: 1 });
  const peeked = await store.getMentor('socket-a');
  assert.equal(peeked.capacity, 3);
  // Still there after a peek - only claimMentor removes it.
  assert.deepEqual((await store.listMentors()).map((m) => m.socketId), ['socket-a']);
  await store.setMentor('socket-a', { ...peeked, seekerCount: 1, roomId: 'room-1' });
  assert.equal((await store.getMentor('socket-a')).roomId, 'room-1');
});

test('rooms: set, get, find by participant, delete', async () => {
  const store = createMemoryStore();
  await store.setRoom('room-1', { participants: ['a', 'b'], aliases: { a: 'Alias A', b: 'Alias B' }, tags: ['DBMS'], createdAt: Date.now() });
  assert.equal((await store.getRoom('room-1')).aliases.a, 'Alias A');
  assert.deepEqual(await store.findRoomIdsBySocket('b'), ['room-1']);
  assert.deepEqual(await store.findRoomIdsBySocket('c'), []);
  await store.deleteRoom('room-1');
  assert.equal(await store.getRoom('room-1'), null);
});

test('cooldowns expire on their own', async () => {
  const store = createMemoryStore();
  assert.equal(await store.getCooldown('user-1'), null);
  await store.setCooldown('user-1', Date.now() + 1000);
  assert.ok(await store.getCooldown('user-1'));
  await store.setCooldown('user-1', Date.now() - 1);
  assert.equal(await store.getCooldown('user-1'), null); // already in the past
});

test('consumeRate enforces a sliding window per key', async () => {
  const store = createMemoryStore();
  const now = 5_000_000;
  assert.equal(await store.consumeRate('k', 2, 1000, now), true);
  assert.equal(await store.consumeRate('k', 2, 1000, now + 10), true);
  assert.equal(await store.consumeRate('k', 2, 1000, now + 20), false);
  assert.equal(await store.consumeRate('k', 2, 1000, now + 1500), true);
  assert.equal(await store.consumeRate('other-key', 2, 1000, now + 20), true);
});

test('recordViolation counts within a window and clearViolations resets it', async () => {
  const store = createMemoryStore();
  const now = 9_000_000;
  assert.equal(await store.recordViolation('user-1', 1000, now), 1);
  assert.equal(await store.recordViolation('user-1', 1000, now + 10), 2);
  await store.clearViolations('user-1');
  assert.equal(await store.recordViolation('user-1', 1000, now + 20), 1);
});

test('waiting queue: add, list, and atomic claim (Phase 3)', async () => {
  const store = createMemoryStore();
  await store.addWaitingSeeker('socket-a', { socketId: 'socket-a', alias: 'Amber Falcon 12', tags: ['DBMS'], joinedAt: 1 });
  await store.addWaitingSeeker('socket-b', { socketId: 'socket-b', alias: 'Coral Otter 5', tags: ['Python'], joinedAt: 2 });
  assert.deepEqual((await store.listWaitingSeekers()).map((s) => s.socketId).sort(), ['socket-a', 'socket-b']);

  const claimed = await store.claimWaitingSeeker('socket-a');
  assert.equal(claimed.alias, 'Amber Falcon 12');
  assert.equal(await store.claimWaitingSeeker('socket-a'), null); // already claimed
  assert.deepEqual((await store.listWaitingSeekers()).map((s) => s.socketId), ['socket-b']);

  assert.equal(await store.removeWaitingSeeker('socket-b'), true);
  assert.equal(await store.removeWaitingSeeker('socket-b'), false); // already gone
});

test('mentor feedback: accumulates thumbs up/down per identityKey (Phase 3)', async () => {
  const store = createMemoryStore();
  assert.deepEqual(await store.getFeedbackStats('mentor-1'), { up: 0, down: 0 });
  assert.deepEqual(await store.recordFeedback('mentor-1', true), { up: 1, down: 0 });
  assert.deepEqual(await store.recordFeedback('mentor-1', true), { up: 2, down: 0 });
  assert.deepEqual(await store.recordFeedback('mentor-1', false), { up: 2, down: 1 });
  assert.deepEqual(await store.getFeedbackStats('mentor-1'), { up: 2, down: 1 });
  // A different mentor's identityKey is tracked independently.
  assert.deepEqual(await store.getFeedbackStats('mentor-2'), { up: 0, down: 0 });
});

test('counters: accumulate and read back independently per name (Phase 4)', async () => {
  const store = createMemoryStore();
  assert.deepEqual(await store.getCounters(), {});
  assert.equal(await store.incrCounter('messages_sent'), 1);
  assert.equal(await store.incrCounter('messages_sent'), 2);
  assert.equal(await store.incrCounter('messages_blocked'), 1);
  assert.deepEqual(await store.getCounters(), { messages_sent: 2, messages_blocked: 1 });
  // incrCounter accepts a custom increment, not just +1.
  assert.equal(await store.incrCounter('messages_sent', 5), 7);
});

test('ping reports readiness (Phase 4)', async () => {
  const store = createMemoryStore();
  assert.equal(await store.ping(), true);
});

test('reports: set, get, list sorted by nothing (caller sorts), delete', async () => {
  const store = createMemoryStore();
  await store.setReport('r1', { id: 'r1', createdAt: 1, status: 'open' });
  await store.setReport('r2', { id: 'r2', createdAt: 2, status: 'open' });
  assert.equal((await store.listReports()).length, 2);
  assert.equal((await store.getReport('r1')).status, 'open');
  assert.equal(await store.deleteReport('r1'), true);
  assert.equal(await store.deleteReport('r1'), false);
  assert.equal(await store.getReport('r1'), null);
});

test('hosted-session counter increments per mentor identity and defaults to 0', async () => {
  const store = createMemoryStore();
  assert.equal(await store.getHosted('mentor-a'), 0);
  assert.equal(await store.incrHosted('mentor-a'), 1);
  assert.equal(await store.incrHosted('mentor-a'), 2);
  assert.equal(await store.incrHosted('mentor-b'), 1);
  assert.equal(await store.getHosted('mentor-a'), 2);
});

test('locks: only one holder at a time, released by token, expire as a safety net', async () => {
  const store = createMemoryStore();
  const first = await store.acquireLock('mentor:m1', 1000);
  assert.ok(first);
  assert.equal(await store.acquireLock('mentor:m1', 1000), null); // held
  assert.ok(await store.acquireLock('mentor:m2', 1000)); // other keys unaffected
  assert.equal(await store.releaseLock('mentor:m1', 'wrong-token'), false); // not the owner
  assert.equal(await store.acquireLock('mentor:m1', 1000), null); // still held
  assert.equal(await store.releaseLock('mentor:m1', first), true);
  assert.ok(await store.acquireLock('mentor:m1', 1)); // free again
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(await store.acquireLock('mentor:m1', 1000)); // previous holder's TTL lapsed
});

test('withLock serializes a read-modify-write: two simultaneous first-joins open one room, not two (Phase 6 fix)', async () => {
  // Mirrors matchSeekerToMentor's group path: peek the mentor entry, and
  // only the caller who finds no roomId opens a room and writes it back.
  async function join(store, seeker, rooms) {
    return withLock(store, 'mentor:m1', async () => {
      const mentor = await store.getMentor('m-socket');
      if (mentor.roomId) return { roomId: mentor.roomId, joined: true };
      await new Promise((resolve) => setTimeout(resolve, 5)); // the awaits where the race used to live
      const roomId = `room-${rooms.length + 1}`;
      rooms.push(roomId);
      await store.setMentor('m-socket', { ...mentor, roomId, seekerCount: 1 });
      return { roomId, joined: false };
    });
  }
  const store = createMemoryStore();
  await store.setMentor('m-socket', { socketId: 'm-socket', capacity: 3, seekerCount: 0, roomId: null });
  const rooms = [];
  const results = await Promise.all(['s1', 's2', 's3'].map((seeker) => join(store, seeker, rooms)));
  assert.equal(rooms.length, 1);
  assert.deepEqual([...new Set(results.map((r) => r.roomId))], ['room-1']);
  assert.equal(results.filter((r) => !r.joined).length, 1);

  // Sanity check that the test really exercises the race: without the lock, the same code opens several rooms.
  const racy = createMemoryStore();
  await racy.setMentor('m-socket', { socketId: 'm-socket', capacity: 3, seekerCount: 0, roomId: null });
  const racyRooms = [];
  await Promise.all(['s1', 's2'].map(async () => {
    const mentor = await racy.getMentor('m-socket');
    if (mentor.roomId) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
    racyRooms.push('r');
    await racy.setMentor('m-socket', { ...mentor, roomId: 'r' });
  }));
  assert.equal(racyRooms.length, 2);
});

test('withLock times out without running fn, and releases even if fn throws', async () => {
  const store = createMemoryStore();
  const held = await store.acquireLock('k', 5000);
  let ran = false;
  let timedOut = false;
  const result = await withLock(store, 'k', async () => { ran = true; }, { waitMs: 40, retryMs: 5, onTimeout: () => { timedOut = true; } });
  assert.equal(result, null);
  assert.equal(ran, false);
  assert.equal(timedOut, true);
  await store.releaseLock('k', held);

  await assert.rejects(withLock(store, 'k', async () => { throw new Error('boom'); }), /boom/);
  assert.ok(await store.acquireLock('k', 1000)); // not left locked by the throw
});


test('Phase 8 stable-key blocks and schedules persist in the store abstraction', async () => {
  const store = createMemoryStore();
  await store.blockIdentity('student-a', 'mentor-b');
  assert.equal(await store.isBlocked('student-a', 'mentor-b'), true);
  assert.deepEqual(await store.listBlocked('student-a'), ['mentor-b']);
  assert.equal(await store.unblockIdentity('student-a', 'mentor-b'), true);
  assert.equal(await store.isBlocked('student-a', 'mentor-b'), false);

  const schedule = [{ day: 1, start: '18:00', end: '19:00' }];
  await store.setSchedule('mentor-b', schedule);
  assert.deepEqual(await store.getSchedule('mentor-b'), schedule);
  await store.setScheduledSession('book-1', { id: 'book-1', mentorIdentityKey: 'mentor-b', seekerIdentityKey: 'student-a' });
  assert.equal((await store.listScheduledSessions('student-a'))[0].id, 'book-1');
  assert.equal(await store.deleteScheduledSession('book-1'), true);
});

test('Phase 9 offender tracking and bans survive the store interface', async () => {
  const store = createMemoryStore();
  const identity = 'a'.repeat(64);
  assert.equal(await store.recordOffenderReport(identity), 1);
  assert.equal(await store.recordOffenderReport(identity), 2);
  assert.equal(await store.getOffenderReportCount(identity), 2);
  await store.setBan(identity, { type: 'temporary', until: Date.now() + 60_000, reason: 'repeat reports' });
  assert.equal((await store.getBan(identity)).type, 'temporary');
  assert.equal((await store.listBans()).length, 1);
  assert.equal(await store.deleteBan(identity), true);
  assert.equal(await store.getBan(identity), null);
});
