import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadOidcConfig, createOidcState, verifyOidcState, pkceChallenge, buildAuthorizationUrl } from './oidc.js';

test('OIDC configuration fails closed when enabled without required settings', () => {
  assert.throws(() => loadOidcConfig({ OIDC_ENABLED: '1', OIDC_ISSUER: 'https://accounts.google.com', OIDC_CLIENT_ID: 'client', OIDC_REDIRECT_URI: 'https://chat.example.edu/api/auth/oidc/callback', OIDC_STATE_SECRET: 'short' }), /32\+ character/);
});

test('OIDC state is signed and tamper-resistant', () => {
  const config = loadOidcConfig({ OIDC_ENABLED: '1', OIDC_ISSUER: 'https://accounts.google.com', OIDC_CLIENT_ID: 'client', OIDC_REDIRECT_URI: 'https://chat.example.edu/callback', OIDC_STATE_SECRET: crypto.randomBytes(32).toString('hex') });
  const created = createOidcState(config, 1_000_000);
  const verified = verifyOidcState(created.state, config, 1_000_000 + 1000);
  assert.equal(verified.nonce, created.nonce);
  const tampered = created.state.replace(/.$/, created.state.endsWith('a') ? 'b' : 'a');
  assert.throws(() => verifyOidcState(tampered, config, 1_000_000 + 1000), /signature/);
});

test('PKCE challenge is deterministic base64url', () => {
  const verifier = 'test-verifier-value';
  assert.match(pkceChallenge(verifier), /^[A-Za-z0-9_-]+$/);
});

test('OIDC state lifetime follows configured max age and can be browser-bound', () => {
  const config = loadOidcConfig({ OIDC_ENABLED: '1', OIDC_ISSUER: 'https://accounts.google.com', OIDC_CLIENT_ID: 'client', OIDC_REDIRECT_URI: 'https://chat.example.edu/callback', OIDC_POST_LOGIN_REDIRECT: 'https://chat.example.edu/', OIDC_STATE_SECRET: crypto.randomBytes(32).toString('hex'), OIDC_MAX_AGE_SECONDS: '120' });
  const created = createOidcState(config, 2_000_000);
  assert.equal(verifyOidcState(created.state, config, 2_000_000 + 60, created.nonce).nonce, created.nonce);
  assert.throws(() => verifyOidcState(created.state, config, 2_000_000 + 60, 'different-nonce'), /not bound to this browser/);
  assert.throws(() => verifyOidcState(created.state, config, 2_000_000 + 121_000, created.nonce), /Expired/);
});

test('OIDC authorization URL requests the configured authentication freshness', () => {
  const config = loadOidcConfig({ OIDC_ENABLED: '1', OIDC_ISSUER: 'https://accounts.google.com', OIDC_CLIENT_ID: 'client', OIDC_REDIRECT_URI: 'https://chat.example.edu/callback', OIDC_POST_LOGIN_REDIRECT: 'https://chat.example.edu/', OIDC_STATE_SECRET: crypto.randomBytes(32).toString('hex'), OIDC_MAX_AGE_SECONDS: '180' });
  const state = createOidcState(config, 3_000_000);
  const url = new URL(buildAuthorizationUrl(config, { authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth' }, state));
  assert.equal(url.searchParams.get('max_age'), '180');
});

test('verifyIdToken accepts ES256 tokens (raw r||s signatures)', async () => {
  const { verifyIdToken } = await import('./oidc.js');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'ES256', kid: 'k1', typ: 'JWT' })}.${b64({ iss: 'https://idp.example.edu', aud: 'cid', sub: 's1', email: 'a@example.edu', nonce: 'n', iat: now, exp: now + 300 })}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  try {
    const result = await verifyIdToken(`${input}.${sig}`, { issuer: 'https://idp.example.edu', clientId: 'cid', maxAgeSeconds: 600 }, { jwks_uri: 'https://idp.example.edu/jwks-es256' }, 'n');
    assert.equal(result.email, 'a@example.edu');
  } finally { globalThis.fetch = realFetch; }
});
