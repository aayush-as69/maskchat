import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { io as connectSocket } from 'socket.io-client';

const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'phase7-e2e-admin-token';
const SERVER_DIR = fileURLToPath(new URL('.', import.meta.url));
let serverProcess;

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (...args) => {
      clearTimeout(timer);
      resolve(args.length === 1 ? args[0] : args);
    };
    socket.once(event, onEvent);
  });
}

function emitAck(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ack from ${event}`)), timeoutMs);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function connectVerified(email) {
  const socket = connectSocket(BASE_URL, { transports: ['websocket'], reconnection: false });
  await waitForEvent(socket, 'connect');
  const verified = await emitAck(socket, 'identity:verify', { email });
  assert.equal(verified.ok, true);
  return socket;
}

async function startMatch(mentor, seeker, { capacity = 2, tags = ['DBMS'] } = {}) {
  const training = await emitAck(mentor, 'mentor:training:accept', {});
  assert.equal(training.ok, true);
  const available = await emitAck(mentor, 'mentor:available', { tags, capacity, year: 3, expertise: 'intermediate', topicType: 'academic' });
  assert.equal(available.ok, true);
  const matchPromise = waitForEvent(seeker, 'match:found');
  const request = await emitAck(seeker, 'match:request', { tags, expertise: 'intermediate', topicType: 'academic' });
  assert.equal(request.ok, true);
  const match = await matchPromise;
  return match;
}

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@galgotiacollege.edu.in`;
}

async function closeSocket(socket) {
  if (!socket) return;
  if (socket.connected) socket.disconnect();
  else socket.close();
}

before(async () => {
  serverProcess = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      ADMIN_TOKEN,
      METRICS_LOG_INTERVAL_MS: '0',
      REDIS_URL: '',
      CLIENT_ORIGIN: BASE_URL
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  let spawnError = null;
  serverProcess.on('error', (error) => { spawnError = error; });
  const collect = (chunk) => { output += chunk.toString(); };
  serverProcess.stdout.on('data', collect);
  serverProcess.stderr.on('data', collect);

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (output.includes(`MaskChat server listening`)) return;
    if (spawnError) throw new Error(`Could not start MaskChat server: ${spawnError.message}`);
    if (serverProcess.exitCode !== null) throw new Error(`MaskChat server exited early:\n${output}`);
    await delay(50);
  }
  throw new Error(`MaskChat server did not start:\n${output}`);
});

after(async () => {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  await Promise.race([once(serverProcess, 'exit'), delay(3000)]);
  if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL');
});

test('live group join puts multiple seekers into the same room', async () => {
  const mentor = await connectVerified(uniqueEmail('mentor-group-join'));
  const seeker1 = await connectVerified(uniqueEmail('seeker-group-join-a'));
  const seeker2 = await connectVerified(uniqueEmail('seeker-group-join-b'));
  try {
    const first = await startMatch(mentor, seeker1, { capacity: 3, tags: ['DBMS', 'Java'] });
    const joined = waitForEvent(mentor, 'peer:joined');
    const second = await startMatch(mentor, seeker2, { capacity: 3, tags: ['DBMS'] });
    const peerJoined = await joined;

    assert.equal(second.roomId, first.roomId);
    assert.equal(second.isGroup, true);
    assert.equal(second.capacity, 3);
    assert.equal(second.seekerCount, 2);
    assert.equal(peerJoined.seekerCount, 2);
  } finally {
    await Promise.all([closeSocket(mentor), closeSocket(seeker1), closeSocket(seeker2)]);
  }
});

test('live group leave frees a seat and matches a waiting seeker into the existing room', async () => {
  const mentor = await connectVerified(uniqueEmail('mentor-group-leave'));
  const seeker1 = await connectVerified(uniqueEmail('seeker-group-leave-a'));
  const seeker2 = await connectVerified(uniqueEmail('seeker-group-leave-b'));
  const seeker3 = await connectVerified(uniqueEmail('seeker-group-leave-c'));
  try {
    const first = await startMatch(mentor, seeker1, { capacity: 2, tags: ['Python'] });
    const second = await startMatch(mentor, seeker2, { capacity: 2, tags: ['Python'] });
    assert.equal(second.roomId, first.roomId);

    const left = waitForEvent(mentor, 'peer:left');
    const ended = waitForEvent(seeker2, 'session:ended');
    const endAck = await emitAck(seeker2, 'session:end', { roomId: first.roomId });
    assert.equal(endAck.ok, true);
    const leftEvent = await left;
    const endedEvent = await ended;
    assert.equal(endedEvent.reason, 'left');
    assert.equal(leftEvent.remaining, 2);

    const thirdMatch = waitForEvent(seeker3, 'match:found');
    const request = await emitAck(seeker3, 'match:request', { tags: ['Python'] });
    assert.equal(request.ok, true);
    const third = await thirdMatch;
    assert.equal(third.roomId, first.roomId);
    assert.equal(third.seekerCount, 2);
  } finally {
    await Promise.all([closeSocket(mentor), closeSocket(seeker1), closeSocket(seeker2), closeSocket(seeker3)]);
  }
});

test('mentor ending a group room ends the room for every participant', async () => {
  const mentor = await connectVerified(uniqueEmail('mentor-end-room'));
  const seeker1 = await connectVerified(uniqueEmail('seeker-end-room-a'));
  const seeker2 = await connectVerified(uniqueEmail('seeker-end-room-b'));
  try {
    const first = await startMatch(mentor, seeker1, { capacity: 3, tags: ['OS'] });
    await startMatch(mentor, seeker2, { capacity: 3, tags: ['OS'] });

    const seekerEnded = waitForEvent(seeker1, 'session:ended');
    const seeker2Ended = waitForEvent(seeker2, 'session:ended');
    const ack = await emitAck(mentor, 'session:end', { roomId: first.roomId });
    assert.equal(ack.ok, true);
    assert.equal((await seekerEnded).reason, 'ended');
    assert.equal((await seeker2Ended).reason, 'ended');
  } finally {
    await Promise.all([closeSocket(mentor), closeSocket(seeker1), closeSocket(seeker2)]);
  }
});

test('live reporting closes the room and creates an admin-visible report', async () => {
  const mentor = await connectVerified(uniqueEmail('mentor-report'));
  const seeker = await connectVerified(uniqueEmail('seeker-report'));
  try {
    const match = await startMatch(mentor, seeker, { capacity: 2, tags: ['Networks'] });
    const mentorEnded = waitForEvent(mentor, 'session:ended');
    const reportAck = await emitAck(seeker, 'session:report', {
      roomId: match.roomId,
      reason: 'harassment',
      details: 'Phase 7 live socket report',
      includeMessages: false
    });
    assert.equal(reportAck.ok, true);
    assert.equal((await mentorEnded).reason, 'reported');

    const response = await fetch(`${BASE_URL}/api/admin/reports`, {
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const report = body.reports.find((item) => item.roomId === match.roomId && item.details === 'Phase 7 live socket report');
    assert.ok(report, 'created report should be visible through the admin API');
    assert.equal(report.reason, 'harassment');
    assert.equal(report.details, 'Phase 7 live socket report');
  } finally {
    await Promise.all([closeSocket(mentor), closeSocket(seeker)]);
  }
});

test('refresh and rejoin restores the same group seat during the disconnect grace window', async () => {
  const mentorEmail = uniqueEmail('mentor-rejoin');
  const seekerEmail = uniqueEmail('seeker-rejoin');
  const mentor = await connectVerified(mentorEmail);
  const seeker = await connectVerified(seekerEmail);
  let refreshed;
  try {
    const match = await startMatch(mentor, seeker, { capacity: 3, tags: ['Algorithms'] });
    const reconnected = waitForEvent(mentor, 'peer:reconnected');

    seeker.disconnect();
    await delay(100);

    refreshed = await connectVerified(seekerEmail);
    const rejoin = await emitAck(refreshed, 'session:rejoin', { roomId: match.roomId });
    assert.equal(rejoin.ok, true);
    assert.equal(rejoin.roomId, match.roomId);
    assert.equal(rejoin.isGroup, true);
    assert.equal(rejoin.capacity, 3);
    assert.equal(rejoin.peers.length, 1);
    await reconnected;

    const followup = await emitAck(refreshed, 'session:end', { roomId: match.roomId });
    assert.equal(followup.ok, true);
  } finally {
    await Promise.all([closeSocket(mentor), closeSocket(seeker), closeSocket(refreshed)]);
  }
});
