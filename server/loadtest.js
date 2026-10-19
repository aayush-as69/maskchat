// Phase 4: load testing the Socket.io layer.
//
// Spins up PAIRS concurrent mentor+seeker connections against a running
// MaskChat server, drives each pair through the real flow a student would
// (verify -> come online / request a match -> exchange messages -> end
// session), and reports connection, matching, and messaging latency plus a
// pass/fail count. This is a load-generation tool, not a unit test - run it
// against a server you're allowed to hammer (local dev, or a staging
// deployment), never production.
//
// Usage:
//   node loadtest.js
//   PAIRS=100 MESSAGES_PER_SESSION=6 node loadtest.js
//   SERVER_URL=https://staging.example.com PAIRS=200 RAMP_MS=20 node loadtest.js
//
// Env vars (all optional):
//   SERVER_URL           default http://localhost:3001
//   PAIRS                number of concurrent mentor+seeker pairs (default 20)
//   MESSAGES_PER_SESSION messages exchanged per session, split both ways (default 4)
//   RAMP_MS              delay in ms between starting each pair, to simulate a
//                        ramp instead of a thundering herd (default 10)
//   TAG                  the shared subject tag mentors/seekers match on (default 'Load Test')
//   TIMEOUT_MS           per-pair overall timeout before it's counted a failure (default 15000)
//
// What to look for:
//   - matchTimeMs and messageAckMs percentiles should stay low and flat as
//     PAIRS increases. A p95 that climbs sharply, or a growing failure
//     count, is the server (or its host) running out of headroom.
//   - Failures/timeouts under load usually mean: the event loop is blocked
//     (check CPU), the rate limiter is legitimately kicking in (raise
//     MATCH_ACTION_LIMIT/MESSAGE_LIMIT for the test only, never in
//     production), or - in Redis mode - Redis itself is the bottleneck.
//   - Run this once in-memory (no REDIS_URL on the server) and once against
//     a Redis-backed multi-instance setup before trusting Phase 2 numbers.

import { io as ioClient } from 'socket.io-client';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';
const PAIRS = Number(process.env.PAIRS || 20);
const MESSAGES_PER_SESSION = Number(process.env.MESSAGES_PER_SESSION || 4);
const RAMP_MS = Number(process.env.RAMP_MS || 10);
const TAG = process.env.TAG || 'Load Test';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_FAILURE_RATE = Number(process.env.MAX_FAILURE_RATE || 0.02);
const MAX_MATCH_P95_MS = Number(process.env.MAX_MATCH_P95_MS || 1500);
const MAX_MESSAGE_P95_MS = Number(process.env.MAX_MESSAGE_P95_MS || 1000);
const REPORT_FILE = process.env.REPORT_FILE || '';
const JSON_OUTPUT = process.env.JSON_OUTPUT === '1';
const DOMAIN = 'galgotiacollege.edu.in';

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function percentileValue(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
}

function summarize(label, values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) {
    console.log(`  ${label}: no samples`);
    return;
  }
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  console.log(`  ${label}: avg=${avg.toFixed(0)}ms p50=${percentile(sorted, 50)}ms p95=${percentile(sorted, 95)}ms max=${sorted[sorted.length - 1]}ms (n=${sorted.length})`);
}

function connectAndVerify(email) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(SERVER_URL, { transports: ['websocket'], reconnection: false, timeout: TIMEOUT_MS });
    const timer = setTimeout(() => reject(new Error(`connect/verify timed out for ${email}`)), TIMEOUT_MS);
    socket.on('connect_error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => {
      socket.emit('identity:verify', { email }, (response) => {
        clearTimeout(timer);
        if (!response?.ok) return reject(new Error(`verify failed for ${email}: ${response?.error}`));
        resolve(socket);
      });
    });
  });
}

function waitForEvent(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

function emitWithAck(socket, event, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timed out for ${event}`)), timeoutMs);
    socket.emit(event, payload, (response) => { clearTimeout(timer); resolve(response); });
  });
}

async function runPair(index) {
  const result = { index, ok: false, matchTimeMs: null, messageAckMs: [], error: null };
  const mentorEmail = `loadtest-mentor-${index}-${Date.now()}@${DOMAIN}`;
  const seekerEmail = `loadtest-seeker-${index}-${Date.now()}@${DOMAIN}`;
  let mentor;
  let seeker;
  try {
    [mentor, seeker] = await Promise.all([connectAndVerify(mentorEmail), connectAndVerify(seekerEmail)]);

    const matchStart = Date.now();
    const mentorMatchPromise = waitForEvent(mentor, 'match:found', TIMEOUT_MS);
    const availableResponse = await emitWithAck(mentor, 'mentor:available', { tags: [TAG] }, TIMEOUT_MS);
    if (!availableResponse?.ok) throw new Error(`mentor:available rejected: ${availableResponse?.error}`);

    // Attach the seeker's match:found listener *before* emitting
    // match:request, not after awaiting its ack: the server emits
    // match:found (inside createMatchRoom) before it calls the ack
    // callback, so listening only after the ack resolves is a real race
    // that misses the event under load - exactly the kind of bug this
    // harness exists to catch.
    const seekerMatchPromise = waitForEvent(seeker, 'match:found', TIMEOUT_MS);
    const requestResponse = await emitWithAck(seeker, 'match:request', { tags: [TAG] }, TIMEOUT_MS);
    if (!requestResponse?.ok) throw new Error(`match:request rejected: ${requestResponse?.error}`);

    // If the seeker was queued instead of matched immediately (the mentor's
    // ack was slower than expected), the already-armed listener above still
    // catches the async match once the mentor comes online.
    const found = await seekerMatchPromise;
    await mentorMatchPromise;
    result.matchTimeMs = Date.now() - matchStart;
    const roomId = found.roomId;

    for (let i = 0; i < MESSAGES_PER_SESSION; i += 1) {
      const from = i % 2 === 0 ? seeker : mentor;
      const to = i % 2 === 0 ? mentor : seeker;
      const sendStart = Date.now();
      const receivedPromise = waitForEvent(to, 'message:received', TIMEOUT_MS);
      const ack = await emitWithAck(from, 'message:send', { roomId, text: `load test message ${i + 1}` }, TIMEOUT_MS);
      if (!ack?.ok) throw new Error(`message:send rejected: ${ack?.error}`);
      await receivedPromise;
      result.messageAckMs.push(Date.now() - sendStart);
    }

    await emitWithAck(seeker, 'session:end', { roomId }, TIMEOUT_MS);
    result.ok = true;
  } catch (error) {
    result.error = error.message;
  } finally {
    mentor?.close();
    seeker?.close();
  }
  return result;
}

async function main() {
  console.log(`MaskChat load test: ${PAIRS} pairs against ${SERVER_URL}, ${MESSAGES_PER_SESSION} messages/session, ${RAMP_MS}ms ramp.`);
  const runs = [];
  for (let i = 0; i < PAIRS; i += 1) {
    runs.push(runPair(i));
    if (RAMP_MS > 0) await new Promise((resolve) => setTimeout(resolve, RAMP_MS));
  }
  const startedAt = Date.now();
  const results = await Promise.all(runs);
  const totalMs = Date.now() - startedAt;

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const matchSamples = succeeded.map((r) => r.matchTimeMs).filter(Number.isFinite);
  const messageSamples = succeeded.flatMap((r) => r.messageAckMs).filter(Number.isFinite);
  const failureRate = results.length ? failed.length / results.length : 0;
  const matchP95 = percentileValue(matchSamples, 95);
  const messageP95 = percentileValue(messageSamples, 95);
  const checks = {
    failureRate: { value: failureRate, max: MAX_FAILURE_RATE, pass: failureRate <= MAX_FAILURE_RATE },
    matchP95Ms: { value: matchP95, max: MAX_MATCH_P95_MS, pass: matchP95 === null || matchP95 <= MAX_MATCH_P95_MS },
    messageP95Ms: { value: messageP95, max: MAX_MESSAGE_P95_MS, pass: messageP95 === null || messageP95 <= MAX_MESSAGE_P95_MS }
  };
  const passed = Object.values(checks).every((x) => x.pass);
  const report = { generatedAt: new Date().toISOString(), serverUrl: SERVER_URL, pairs: PAIRS, messagesPerSession: MESSAGES_PER_SESSION, rampMs: RAMP_MS, totalMs, succeeded: succeeded.length, failed: failed.length, failureRate, matchP95Ms: matchP95, messageP95Ms: messageP95, thresholds: { maxFailureRate: MAX_FAILURE_RATE, maxMatchP95Ms: MAX_MATCH_P95_MS, maxMessageP95Ms: MAX_MESSAGE_P95_MS }, checks, failures: failed.map((r) => r.error) };

  if (!JSON_OUTPUT) {
    console.log('');
    console.log(`Completed in ${totalMs}ms. ${succeeded.length}/${results.length} pairs succeeded.`);
    summarize('Time to match', matchSamples);
    summarize('Message send -> received', messageSamples);
    console.log(`  Thresholds: failureRate<=${MAX_FAILURE_RATE}, match p95<=${MAX_MATCH_P95_MS}ms, message p95<=${MAX_MESSAGE_P95_MS}ms`);
    console.log(`  Threshold result: ${passed ? 'PASS' : 'FAIL'}`);

    if (failed.length) {
      console.log('');
      console.log(`${failed.length} pair(s) failed:`);
      const byError = new Map();
      for (const r of failed) byError.set(r.error, (byError.get(r.error) || 0) + 1);
      for (const [error, count] of byError) console.log(`  x${count}: ${error}`);
    }
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  if (REPORT_FILE) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
    if (!JSON_OUTPUT) console.log(`Report written to ${REPORT_FILE}`);
  }

  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error('Load test crashed:', error);
  process.exit(1);
});
