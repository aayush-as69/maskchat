import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createOffenderRef, verifyInstitutionVerificationToken } from './core.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

test('offender references are opaque and non-reversible identifiers', () => {
  const identity = crypto.randomBytes(32).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const ref = createOffenderRef(identity, secret);
  assert.match(ref, /^[0-9a-f]{24}$/);
  assert.notEqual(ref, identity);
  assert.equal(createOffenderRef(identity, secret), ref);
  assert.notEqual(createOffenderRef(identity, crypto.randomBytes(32).toString('hex')), ref);
});

test('institution verification token rejects tampering and expiry', () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const payload = Buffer.from(JSON.stringify({ email: 'student@galgotiacollege.edu.in', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  assert.equal(verifyInstitutionVerificationToken(`${payload}.${signature}`, secret)?.email, 'student@galgotiacollege.edu.in');
  assert.equal(verifyInstitutionVerificationToken(`${payload}.tampered`, secret), null);
  const expiredPayload = Buffer.from(JSON.stringify({ email: 'student@galgotiacollege.edu.in', exp: 1 })).toString('base64url');
  const expiredSig = crypto.createHmac('sha256', secret).update(expiredPayload).digest('base64url');
  assert.equal(verifyInstitutionVerificationToken(`${expiredPayload}.${expiredSig}`, secret), null);
});

test('production authentication and transport controls remain fail-closed', () => {
  assert.match(indexSource, /AUTH_MODE !== 'trusted-token'/);
  assert.match(indexSource, /IDENTITY_VERIFICATION_SECRET\.length < 32/);
  assert.match(indexSource, /ADMIN_TOKEN\.length < 32/);
  assert.match(indexSource, /REQUIRE_HTTPS/);
  assert.match(indexSource, /X-Content-Type-Options/);
  assert.match(indexSource, /maxHttpBufferSize: 64 \* 1024/);
  assert.match(indexSource, /express\.json\(\{ limit: HTTP_BODY_LIMIT/);
});

test('admin APIs do not expose raw identity keys and use opaque offender references', () => {
  assert.match(indexSource, /redactAdminIdentity\(report\)/);
  assert.match(indexSource, /reportedIdentityKey\);/);
  assert.match(indexSource, /offenderRef: createOffenderRef\(identityKey, OFFENDER_REF_SECRET\)/);
  assert.match(indexSource, /resolveIdentityFromRef\(store, req\.params\.ref\)/);
});

test('database schema keeps identity keys server-side and audit records separate', () => {
  assert.match(schema, /reported_identity_key TEXT/);
  assert.match(schema, /identity_key TEXT PRIMARY KEY/);
  assert.match(schema, /maskchat_audit_events/);
  assert.doesNotMatch(schema, /email\s+TEXT/i);
  assert.doesNotMatch(schema, /message_text\s+TEXT/i);
});

test('production examples do not contain obvious live credentials', () => {
  assert.match(envExample, /IDENTITY_VERIFICATION_SECRET=/);
  assert.match(envExample, /POSTGRES_URL=/);
  assert.match(envExample, /REDIS_URL=/);
  assert.match(envExample, /POSTGRES_URL=postgres:\/\/maskchat:change-me@localhost:5432\/maskchat/);
});
